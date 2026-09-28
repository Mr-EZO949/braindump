// Conversation memory for the assistant: the thread's recent turns, sent
// verbatim. There is no LLM summarization — the graph itself is the long-term
// memory, and the old per-turn Haiku summary cost more than it saved: it fired
// on ~80% of turns (re-summarizing the same older turns every time, unlogged)
// and delayed every reply by a round-trip.
//
// Trimming is prefix-stable so the prompt cache keeps working: turns are only
// ever dropped from the front in whole chunks, so consecutive turns share the
// same history prefix and each turn re-reads the previous one's history at
// 0.1× (see assistant-cache.ts) until the next chunk is dropped.

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export interface HistoryTurn {
  role: "user" | "assistant";
  body: string;
}

// Keep at most this many turns; past it, drop the oldest in chunks. The kept
// window therefore floats between MAX_HISTORY_TURNS - TRIM_CHUNK_TURNS + 1 and
// MAX_HISTORY_TURNS turns (~6 and ~6 exchanges).
const MAX_HISTORY_TURNS = 12;
const TRIM_CHUNK_TURNS = 6;

// Long turns (a pasted brain dump, a long plan) are capped — whatever mattered
// in them is in the graph context now.
const MAX_TURN_CHARS = 2_000;

const TRIMMED_NOTE =
  "[Earlier messages in this thread were trimmed — the graph context below is current.]";

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

// The window of `history` to send. Pure and deterministic in the history, so
// the same thread always yields the same prefix.
export function trimHistory(history: HistoryTurn[]): { turns: HistoryTurn[]; trimmed: boolean } {
  const overflow = history.length - MAX_HISTORY_TURNS;
  let cut = overflow > 0 ? Math.ceil(overflow / TRIM_CHUNK_TURNS) * TRIM_CHUNK_TURNS : 0;
  // The window must open on a user turn.
  while (cut < history.length && history[cut].role !== "user") cut += 1;

  const turns = history.slice(cut).map((t) => ({
    role: t.role,
    body: t.body.length > MAX_TURN_CHARS ? `${t.body.slice(0, MAX_TURN_CHARS)} …[truncated]` : t.body,
  }));
  return { turns, trimmed: cut > 0 };
}

// History as Messages API turns, always in block form so a turn renders the
// same whether or not it carries a cache breakpoint.
export function buildHistoryMessages(history: HistoryTurn[]): MessageParam[] {
  const { turns, trimmed } = trimHistory(history);
  return turns.map((t, i) => ({
    role: t.role,
    content: [{ type: "text", text: i === 0 && trimmed ? `${TRIMMED_NOTE}\n\n${t.body}` : t.body }],
  }));
}
