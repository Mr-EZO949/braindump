// Conversation memory for the assistant. Keeps the last N turns verbatim; when
// the transcript grows past a token budget, older turns are compressed into a
// single bullet summary by Haiku. The compressed summary is injected as a
// synthetic user turn so the next Claude call can reference prior context
// without re-sending the whole history.
//
// Token estimation is a rough 4 chars ≈ 1 token heuristic — we're bounding the
// prompt, not billing against it.

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export interface HistoryTurn {
  role: "user" | "assistant";
  body: string;
}

// Tight budget — every input token costs real money on chat. Compress aggressively.
// The graph context (~4-8k) already dominates; we don't need a long tail of
// raw turns after that. Past 1.5k worth of history, we summarize with Haiku.
const HISTORY_TOKEN_BUDGET = 1_500;

// Always keep at least this many of the most recent turns raw. Three turns
// (~1-2 round trips) is enough short-term context; anything older collapses
// to a summary bullet list.
const KEEP_RECENT_TURNS = 3;

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function turnTokens(turn: HistoryTurn): number {
  return estimateTokens(turn.body) + 8; // +8 for role tag + message overhead
}

function sanitizeTurn(turn: HistoryTurn): HistoryTurn | null {
  const body = typeof turn.body === "string" ? turn.body.trim() : "";
  if (!body) return null;
  if (turn.role !== "user" && turn.role !== "assistant") return null;
  return { role: turn.role, body };
}

export function sanitizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const turn = sanitizeTurn(item as HistoryTurn);
    if (turn) out.push(turn);
  }
  return out;
}

async function compressTurns(client: Anthropic, turns: HistoryTurn[]): Promise<string> {
  const transcript = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.body}`)
    .join("\n\n");

  const res = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 250,
    temperature: 0.2,
    system:
      "Summarize the prior conversation between a user and an assistant into 2–4 terse bullet points. " +
      "Preserve only: user goals, decisions made, open questions, anything the assistant promised to remember. " +
      "Drop pleasantries and filler. Output only the bullet list — no preamble.",
    messages: [{ role: "user", content: transcript }],
  });

  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return "";
  return block.text.trim();
}

// Compresses `history` if needed and returns a list of `MessageParam` entries
// ready to be prepended before the current user turn. When compression runs,
// it adds a synthetic user turn carrying the summary so the assistant can
// ground itself without pretending to have said it.
//
// Compression is best-effort: any error falls back to returning just the
// recent raw tail so the conversation still proceeds.
export async function buildHistoryMessages(
  client: Anthropic,
  history: HistoryTurn[],
): Promise<MessageParam[]> {
  if (history.length === 0) return [];

  const totalTokens = history.reduce((acc, t) => acc + turnTokens(t), 0);
  if (totalTokens <= HISTORY_TOKEN_BUDGET && history.length <= KEEP_RECENT_TURNS * 2) {
    return history.map((t) => ({ role: t.role, content: t.body }) as MessageParam);
  }

  const recent = history.slice(-KEEP_RECENT_TURNS);
  const older = history.slice(0, -KEEP_RECENT_TURNS);

  if (older.length === 0) {
    return recent.map((t) => ({ role: t.role, content: t.body }) as MessageParam);
  }

  let summary = "";
  try {
    summary = await compressTurns(client, older);
  } catch (err) {
    console.error("[chat-memory] compression failed:", err);
  }

  const out: MessageParam[] = [];
  if (summary) {
    out.push({
      role: "user",
      content: `[Summary of earlier conversation in this thread]\n${summary}`,
    });
    out.push({
      role: "assistant",
      content: "Understood — carrying that context forward.",
    });
  }
  for (const t of recent) {
    out.push({ role: t.role, content: t.body });
  }
  return out;
}

