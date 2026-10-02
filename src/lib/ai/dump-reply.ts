// Dump → reply: the human half of a brain dump, answered in parallel with the
// graph builder (prompt: prompts/dump-reply.ts). One small Haiku call on every
// dump (~$0.001); the model says NONE when the dump is only items. Until
// 2026-10-02 a word filter decided whether to ask, and a dump that only told
// about the day ("bus broke down, got home at 9") got no answer.
// Fail-soft: any error → no reply, the card still shows what changed.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { STRUCTURE_TYPES } from "@/lib/graph/node-types";
import type { NodeType } from "@/types/graph";
import { AI_MODELS } from "./config";
import { hashText } from "./errors";
import {
  buildDumpReplyUserMessage,
  DUMP_REPLY_PROMPT_VERSION,
  DUMP_REPLY_SYSTEM,
  type DumpReplyPromptNode,
} from "./prompts/dump-reply";
import { recordClaudeRun } from "./telemetry";
import { readClaudeUsage } from "./usage";

const MAX_NODES = 24;
const MAX_DUMP_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 200;
const MAX_REPLY_CHARS = 600;
const MAX_HISTORY_TURNS = 6;

const MAX_ANSWER_WORDS = 60;

// Whole sentences up to a word budget; the first `minSentences` always stay.
// A sentence ends at . ! ? followed by a capital, so "Oct. 6" stays whole.
function keepSentences(text: string, maxWords: number, minSentences = 1): string {
  const sentences = text.split(/(?<=[.!?]["”’)]*)\s+(?=["“]?[A-Z])/);
  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).filter(Boolean).length;
    if (kept.length >= minSentences && words + count > maxWords) break;
    kept.push(sentence);
    words += count;
  }
  return kept.join(" ");
}

// Model text → the reply, or null when there is nothing to say. The first line
// is the model's verdict (NONE / ACK / ANSWER / BOTH); the length rules are
// enforced here, since Haiku runs long: an acknowledgement is one sentence;
// an answer stops at the last whole sentence within MAX_ANSWER_WORDS, but
// never before its first sentence (BOTH: the acknowledgement plus one).
export function parseDumpReply(text: string): string | null {
  const trimmed = text.trim();
  const verdict = /^(NONE|ACK|ANSWER|BOTH)\b[:.]?\s*/i.exec(trimmed);
  const kind = verdict?.[1]?.toUpperCase() ?? null;
  const reply = (verdict ? trimmed.slice(verdict[0].length) : trimmed)
    .replace(/\s+/g, " ")
    .replace(/^["“]|["”]$/g, "")
    .trim();
  if (kind === "NONE" || !reply || /^none\b[.!]?$/i.test(reply)) return null;
  const shaped =
    kind === "ACK"
      ? keepSentences(reply, 0)
      : keepSentences(reply, MAX_ANSWER_WORDS, kind === "BOTH" ? 2 : 1);
  return shaped.slice(0, MAX_REPLY_CHARS);
}

export async function readDumpReply(params: {
  dump: string;
  today: string;
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  signal?: AbortSignal;
  // The thread the dump was typed into (chat composer).
  history?: Array<{ role: "user" | "assistant"; body: string }>;
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const dump = params.dump.trim();
  if (!apiKey || !dump) return null;

  try {
    // What they could be asked about: the work that ranks highest right now.
    const [{ data: rows }, { data: parentEdges }] = await Promise.all([
      params.supabase
        .from("nodes")
        .select("id, title, node_type, status, target_date, waiting_for, current_importance_score")
        .eq("user_id", params.userId)
        .eq("workspace_id", params.workspaceId)
        .in("status", ["active", "paused"])
        .order("current_importance_score", { ascending: false, nullsFirst: false })
        .limit(MAX_NODES * 2),
      params.supabase
        .from("edges")
        .select("source_node_id, target_node_id")
        .eq("user_id", params.userId)
        .eq("workspace_id", params.workspaceId)
        .eq("edge_type", "belongs_to")
        .eq("status", "active"),
    ]);
    type Row = {
      id: string;
      title: string;
      node_type: string;
      status: string | null;
      target_date: string | null;
      waiting_for: string | null;
    };
    const all = (rows ?? []) as Row[];
    const titleById = new Map(all.map((n) => [n.id, n.title]));
    const parentOf = new Map(
      ((parentEdges ?? []) as Array<{ source_node_id: string; target_node_id: string }>).map((e) => [
        e.source_node_id,
        e.target_node_id,
      ]),
    );
    const nodes: DumpReplyPromptNode[] = all
      .filter((n) => !STRUCTURE_TYPES.has(n.node_type as NodeType))
      .slice(0, MAX_NODES)
      .map((n) => ({
        title: n.title,
        node_type: n.node_type,
        target_date: n.target_date,
        status: n.status,
        waiting_for: n.waiting_for,
        parent_title: titleById.get(parentOf.get(n.id) ?? "") ?? null,
      }));

    const client = new Anthropic({ apiKey });
    const startedAt = Date.now();
    const response = await client.messages.create(
      {
        model: AI_MODELS.CLAUDE_HAIKU,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.4,
        system: DUMP_REPLY_SYSTEM,
        messages: [
          {
            role: "user",
            content: buildDumpReplyUserMessage({
              dump: dump.slice(0, MAX_DUMP_CHARS),
              today: params.today,
              nodes,
              history: (params.history ?? []).slice(-MAX_HISTORY_TURNS),
            }),
          },
        ],
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    await recordClaudeRun({
      scope: { supabase: params.supabase, userId: params.userId, workspaceId: params.workspaceId },
      source: "dump-reply",
      model: AI_MODELS.CLAUDE_HAIKU,
      promptVersion: DUMP_REPLY_PROMPT_VERSION,
      usage: readClaudeUsage(response.usage),
      latencyMs: Date.now() - startedAt,
      inputHash: hashText(dump),
    });
    return parseDumpReply(text);
  } catch (err) {
    console.warn("[dump-reply] read failed (non-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}
