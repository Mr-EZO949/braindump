// Dump → reply: the human half of a brain dump, answered in parallel with the
// graph builder (prompt: prompts/dump-reply.ts). One small Haiku call, only
// when the dump has a human part at all (looksConversational); ~$0.002.
// Fail-soft: any error → no reply, the card still shows what changed.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { looksConversational } from "@/lib/graph/dump-heuristic";
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

// Model text → the reply, or null when there is nothing to say.
export function parseDumpReply(text: string): string | null {
  const reply = text
    .trim()
    .replace(/^["“]|["”]$/g, "")
    .trim();
  if (!reply || /^none\b[.!]?$/i.test(reply)) return null;
  return reply.slice(0, MAX_REPLY_CHARS);
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
  if (!apiKey || !dump || !looksConversational(dump)) return null;

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
