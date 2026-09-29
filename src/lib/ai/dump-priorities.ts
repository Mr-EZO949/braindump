// Dump → priorities: one small Haiku read per dump that touches existing
// nodes (prompt: prompts/dump-priorities.ts). Runs in parallel with
// extraction, so it adds no latency; the result goes through the same engine
// as chat's update_priorities (applyPriorityChanges) and the deterministic
// ranking reranks. ~$0.002 a dump; skipped when retrieval found no existing
// node the dump could be about. Fail-soft: any error → no changes.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parsePriorityChanges, PRIORITY_ACTIONS, type PriorityAction } from "@/lib/graph/priority-changes";
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
const MAX_OUTPUT_TOKENS = 400;
const MAX_UNCLEAR = 2;

export interface DumpPriorityRead {
  /** update_priorities-shaped changes, each valid on its own; ready for applyPriorityChanges. */
  changes: Record<string, unknown>[];
  /** Ambiguous outcomes the model didn't act on — asked back in chat. */
  unclear: string[];
}

type RefNode = { ref: string; id: string; title: string };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Model text → validated changes. Rows are checked one at a time so one bad
 * row (unknown ref, a date that doesn't resolve) never sinks the rest; a wait
 * whose check-back words don't resolve keeps the wait without the date. At
 * most one status move and one of each action per node.
 */
export function parseDumpPriorityResponse(text: string, nodes: RefNode[], today: string): DumpPriorityRead {
  let parsed: { changes?: unknown; unclear?: unknown };
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = JSON.parse((fenced ? fenced[1] : text).trim()) as typeof parsed;
  } catch {
    return { changes: [], unclear: [] };
  }
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const changes: Record<string, unknown>[] = [];
  const unclear = (Array.isArray(parsed.unclear) ? parsed.unclear : [])
    .map(str)
    .filter(Boolean)
    .map((q) => q.slice(0, 160));
  const seen = new Set<string>();
  const statusMoved = new Set<string>();

  for (const item of Array.isArray(parsed.changes) ? parsed.changes : []) {
    const row = (item ?? {}) as Record<string, unknown>;
    const node = byRef.get(str(row.ref));
    const action = str(row.action) as PriorityAction;
    if (!node || !PRIORITY_ACTIONS.includes(action) || !DUMP_ACTIONS.has(action)) continue;
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
  return { changes, unclear: unclear.slice(0, MAX_UNCLEAR) };
}

/**
 * Nodes this dump gives a new status (wait / resume / drop). Extraction may
 * list the same node as done ("did the exam, waiting for the result" reads as
 * "did") — the priority read is the more specific one, so it wins.
 */
export function statusTouchedIds(read: DumpPriorityRead | null): Set<string> {
  return new Set(
    (read?.changes ?? [])
      .filter((c) => STATUS_ACTIONS.has(String(c.action)))
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
  if (!apiKey || ids.length === 0 || !params.dump.trim()) return null;

  try {
    const { data } = await params.supabase
      .from("nodes")
      .select("id, title, node_type, status, target_date, stakes")
      .eq("user_id", params.userId)
      .eq("workspace_id", params.workspaceId)
      .in("id", ids);
    const rows = ((data ?? []) as Array<{
      id: string;
      title: string;
      node_type: string;
      status: string | null;
      target_date: string | null;
      stakes: number | null;
    }>).filter((n) => n.status !== "completed" && n.status !== "archived");
    if (rows.length === 0) return null;

    const nodes = rows.map((n, i) => ({ ...n, ref: `n${i + 1}` }));
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
    return parseDumpPriorityResponse(text, nodes, params.today);
  } catch (err) {
    console.warn("[dump-priorities] read failed (non-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}
