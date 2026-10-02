// Dump → priorities + fixed commitments: one small Haiku read per dump that
// touches existing nodes or names a weekly time (prompt:
// prompts/dump-priorities.ts). Runs in parallel with extraction, so it adds no
// latency; the results go through the same engines as chat's
// update_priorities (applyPriorityChanges) and set_commitments
// (applyCommitmentChanges), and the deterministic ranking reranks. ~$0.001 a
// dump; skipped when retrieval found no existing node the dump could be about
// AND the dump names no clock time on a weekday / "every …". Fail-soft: any
// error → no changes.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parsePriorityChanges, PRIORITY_ACTIONS, type PriorityAction } from "@/lib/graph/priority-changes";
import { describeCommitment, loadActiveCommitments, type Commitment } from "@/lib/planner/commitments";
import { parseCommitmentChanges } from "@/lib/planner/commitment-changes";
import { AI_MODELS } from "./config";
import { hashText } from "./errors";
import {
  buildDumpPrioritiesUserMessage,
  DUMP_PRIORITIES_PROMPT_VERSION,
  DUMP_PRIORITIES_SYSTEM,
} from "./prompts/dump-priorities";
import { recordClaudeRun } from "./telemetry";
import { readClaudeUsage } from "./usage";

// Completions stay with extraction (tuned: habits log, progress ≠ done).
const DUMP_ACTIONS = new Set<PriorityAction>(["wait", "resume", "deadline", "stakes", "focus", "deprioritize", "drop"]);
const STATUS_ACTIONS = new Set<string>(["wait", "resume", "drop"]);
const MAX_NODES = 40;
const MAX_DUMP_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 500;
const MAX_UNCLEAR = 2;

export interface DumpPriorityRead {
  /** update_priorities-shaped changes, each valid on its own; ready for applyPriorityChanges. */
  changes: Record<string, unknown>[];
  /** set_commitments-shaped changes, each valid on its own; ready for applyCommitmentChanges. */
  commitments: Record<string, unknown>[];
  /** Ambiguous outcomes the model didn't act on — asked back in chat. */
  unclear: string[];
}

type RefNode = { ref: string; id: string; title: string; status?: string | null };
type RefCommitment = Commitment & { ref: string };

// A clock time ("2pm", "14:00", "noon") next to a weekday or a repeat word
// ("every", "daily", "mondays"). Cheap gate for dumps that touch no existing
// node: without it, "stats every day at 2pm" in a fresh workspace would never
// reach the read.
const CLOCK_RE = /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])|\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b|\bnoon\b/i;
const REPEAT_RE =
  /\b(?:every|each|daily|weekdays?|weekends?|(?:mon|tues?|wednes|thurs?|fri|satur|sun)days?|mon|tue|wed|thu|fri|sat|sun)\b/i;

export function mentionsWeeklyTime(dump: string): boolean {
  return CLOCK_RE.test(dump) && REPEAT_RE.test(dump);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseJson(text: string): { changes?: unknown; commitments?: unknown; unclear?: unknown } | null {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse((fenced ? fenced[1] : text).trim()) as { changes?: unknown; commitments?: unknown; unclear?: unknown };
  } catch {
    return null;
  }
}

// Model rows → set_commitments rows, checked one at a time. An end date that
// doesn't resolve is dropped (the commitment still saves) and asked about.
function commitmentRows(
  raw: unknown,
  nodes: RefNode[],
  commitments: RefCommitment[],
  today: string,
  unclear: string[],
): Record<string, unknown>[] {
  const byNodeRef = new Map(nodes.map((n) => [n.ref, n]));
  const byRef = new Map(commitments.map((c) => [c.ref, c]));
  const rows: Record<string, unknown>[] = [];
  const touched = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const row = (item ?? {}) as Record<string, unknown>;
    const action = str(row.action);
    const change: Record<string, unknown> = { action };
    if (action === "add") {
      change.title = str(row.title);
      change.days = row.days;
      change.start_time = str(row.start);
      if (str(row.end)) change.end_time = str(row.end);
      const node = byNodeRef.get(str(row.node));
      if (node) change.node_id = node.id;
    } else if (action === "update" || action === "remove") {
      const existing = byRef.get(str(row.ref));
      if (!existing || touched.has(existing.id)) continue;
      change.commitment_id = existing.id;
      if (action === "update") {
        if (str(row.title)) change.title = str(row.title);
        if (row.days) change.days = row.days;
        if (str(row.start)) change.start_time = str(row.start);
        if (str(row.end)) change.end_time = str(row.end);
      }
    } else {
      continue;
    }
    if (action !== "remove" && str(row.until)) change.until = str(row.until);

    const check = (c: Record<string, unknown>) => parseCommitmentChanges({ changes: [c] }, { today, existing: commitments }).ok;
    let valid = check(change);
    if (!valid && "until" in change) {
      delete change.until;
      valid = check(change);
      if (valid) unclear.push(`When does ${str(change.title) || "that"} end?`);
    }
    if (!valid) continue;
    if (typeof change.commitment_id === "string") touched.add(change.commitment_id);
    rows.push(change);
  }
  return rows;
}

/**
 * Model text → validated changes. Rows are checked one at a time so one bad
 * row (unknown ref, a date that doesn't resolve) never sinks the rest; a wait
 * whose check-back words don't resolve keeps the wait without the date. At
 * most one status move and one of each action per node.
 */
export function parseDumpPriorityResponse(
  text: string,
  nodes: RefNode[],
  today: string,
  commitments: RefCommitment[] = [],
): DumpPriorityRead {
  const parsed = parseJson(text);
  if (!parsed) return { changes: [], commitments: [], unclear: [] };
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const changes: Record<string, unknown>[] = [];
  // The question goes to the user: name items by title — Haiku sometimes
  // writes its refs ("Should n12 move from n10…", e2e 2026-10-01).
  const titleOfRef = new Map<string, string>([
    ...nodes.map((n) => [n.ref, n.title] as const),
    ...commitments.map((c) => [c.ref, c.title] as const),
  ]);
  const unclear = (Array.isArray(parsed.unclear) ? parsed.unclear : [])
    .map(str)
    .filter(Boolean)
    .map((q) =>
      q
        .replace(/\b([nc]\d+)\s*\(([^)]*)\)/g, (whole, ref: string, inner: string) =>
          titleOfRef.has(ref) ? `"${titleOfRef.get(ref)}"` : whole.replace(ref, "").trim() || inner,
        )
        .replace(/\b[nc]\d+\b/g, (ref) => (titleOfRef.has(ref) ? `"${titleOfRef.get(ref)}"` : ref))
        .slice(0, 160),
    );
  const seen = new Set<string>();
  const statusMoved = new Set<string>();
  // Haiku sometimes files a commitment row ({"ref":"c1","action":"update"})
  // under "changes" — move it to where it belongs (eval, dump-priorities-v2).
  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes : [];
  const isCommitmentRow = (item: unknown) =>
    ["add", "update", "remove"].includes(str((item as Record<string, unknown> | null)?.action));
  const rawCommitments = [
    ...(Array.isArray(parsed.commitments) ? parsed.commitments : []),
    ...rawChanges.filter(isCommitmentRow),
  ];

  for (const item of rawChanges.filter((row) => !isCommitmentRow(row))) {
    const row = (item ?? {}) as Record<string, unknown>;
    const node = byRef.get(str(row.ref));
    const action = str(row.action) as PriorityAction;
    if (!node || !PRIORITY_ACTIONS.includes(action) || !DUMP_ACTIONS.has(action)) continue;
    // Only a node on hold can be picked back up. On 2026-10-02 "i finally
    // updated my cv so thats done" came back as resume on the (active) CV task:
    // a "Back on" line for nothing, and it kept the builder from marking it done.
    if (action === "resume" && node.status !== undefined && node.status !== "paused") continue;
    if (seen.has(`${node.id}:${action}`)) continue;
    if (STATUS_ACTIONS.has(action) && statusMoved.has(node.id)) continue;

    const words = str(row.date_words);
    const change: Record<string, unknown> = { node_id: node.id, title: node.title, action };
    if (action === "wait") change.waiting_for = str(row.waiting_for) || "an update";
    if (action === "stakes") change.stakes = str(row.stakes);
    if (action === "deadline") {
      // A deadline must come from the user's words; unresolvable → ask instead.
      if (!words) continue;
      change.date_words = words;
    }
    if (action === "wait" && words) change.date_words = words;

    let valid = parsePriorityChanges({ changes: [change] }, { today }).ok;
    if (!valid && action === "wait" && change.date_words) {
      delete change.date_words;
      valid = parsePriorityChanges({ changes: [change] }, { today }).ok;
    }
    if (!valid) {
      if (action === "deadline") unclear.push(`When exactly is "${node.title}" due?`);
      continue;
    }
    seen.add(`${node.id}:${action}`);
    if (STATUS_ACTIONS.has(action)) statusMoved.add(node.id);
    changes.push(change);
  }
  const commitmentChanges = commitmentRows(rawCommitments, nodes, commitments, today, unclear);
  return { changes, commitments: commitmentChanges, unclear: unclear.slice(0, MAX_UNCLEAR) };
}

/**
 * Nodes this dump gives a new status (wait / resume / drop). Extraction may
 * list the same node as done ("did the exam, waiting for the result" reads as
 * "did") — the priority read is the more specific one, so it wins.
 */
export function statusTouchedIds(read: DumpPriorityRead | null): Set<string> {
  return new Set(
    (read?.changes ?? [])
      // "did it, now waiting" / "dropped it" beat the builder's "did it";
      // picking something back up never cancels a completion.
      .filter((c) => STATUS_ACTIONS.has(String(c.action)) && c.action !== "resume")
      .map((c) => String(c.node_id)),
  );
}

export async function readDumpPriorities(params: {
  dump: string;
  nodeIds: string[];
  today: string;
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<DumpPriorityRead | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const ids = [...new Set(params.nodeIds)].slice(0, MAX_NODES);
  const namesTime = mentionsWeeklyTime(params.dump);
  if (!apiKey || !params.dump.trim() || (ids.length === 0 && !namesTime)) return null;

  try {
    const [nodesResult, active] = await Promise.all([
      ids.length > 0
        ? params.supabase
            .from("nodes")
            .select("id, title, node_type, status, target_date, stakes")
            .eq("user_id", params.userId)
            .eq("workspace_id", params.workspaceId)
            .in("id", ids)
        : Promise.resolve({ data: [] }),
      loadActiveCommitments(params.supabase, params.userId, params.today),
    ]);
    const rows = ((nodesResult.data ?? []) as Array<{
      id: string;
      title: string;
      node_type: string;
      status: string | null;
      target_date: string | null;
      stakes: number | null;
    }>).filter((n) => n.status !== "completed" && n.status !== "archived");
    if (rows.length === 0 && !namesTime) return null;

    const nodes = rows.map((n, i) => ({ ...n, ref: `n${i + 1}` }));
    const commitments = active.map((c, i) => ({ ...c, ref: `c${i + 1}` }));
    const client = new Anthropic({ apiKey });
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: DUMP_PRIORITIES_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildDumpPrioritiesUserMessage({
            dump: params.dump.trim().slice(0, MAX_DUMP_CHARS),
            today: params.today,
            nodes,
            commitments: commitments.map((c) => ({
              ref: c.ref,
              title: c.title,
              when: describeCommitment(c, params.today),
            })),
          }),
        },
      ],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cutOff = response.stop_reason === "max_tokens";
    await recordClaudeRun({
      scope: { supabase: params.supabase, userId: params.userId, workspaceId: params.workspaceId },
      source: "dump-priorities",
      model: AI_MODELS.CLAUDE_HAIKU,
      promptVersion: DUMP_PRIORITIES_PROMPT_VERSION,
      usage: readClaudeUsage(response.usage),
      latencyMs: Date.now() - startedAt,
      status: cutOff ? "failed" : "success",
      errorText: cutOff ? "output cut off at max_tokens" : null,
      inputHash: hashText(params.dump),
    });
    if (cutOff) return null;
    return parseDumpPriorityResponse(text, nodes, params.today, commitments);
  } catch (err) {
    console.warn("[dump-priorities] read failed (non-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}
