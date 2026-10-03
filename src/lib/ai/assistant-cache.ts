// Prompt-cache layout for the assistant's agent loop (chat + resume routes).
//
// Anthropic allows 4 cache breakpoints per request, over the prefix order
// tools → system → messages:
//   1. static system  5m — tools + the mode/date system prompt; identical for
//                          every user in that mode, so shared app-wide. 5m or
//                          1h by AI_ASSISTANT.STATIC_CACHE_TTL (config.ts says
//                          when the hour pays off)
//   2. graph context  5m — the user's graph snapshot (byte-stable until the
//                          graph changes; snapshot-pin.ts keeps it stable
//                          across a burst), re-read by every turn of a thread
//   3. history end    5m — turn N+1 re-reads turn N's history at 0.1× and only
//                          pays to write the newest exchange (chat-memory.ts
//                          keeps that prefix stable)
//   4. last message   5m — moves every tool round, so round k re-reads
//                          everything up to round k-1 instead of re-paying it
// 1h entries must come before 5m ones, which this order satisfies. Tools carry
// no breakpoint of their own — they sit inside breakpoint 1's prefix.
//
// Until 2026-10-03 the static block was always 1h: written at 2× at the first
// message of every chat session (~$0.026 for 13K tokens), though the owner's
// gaps between messages are under 5 minutes 87% of the time (fix list #19).

import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import { AI_ASSISTANT } from "./config";

const STATIC =
  AI_ASSISTANT.STATIC_CACHE_TTL === "1h" ? ({ type: "ephemeral", ttl: "1h" } as const) : ({ type: "ephemeral" } as const);
const SHORT = { type: "ephemeral" } as const;

export function cachedSystem(staticPrompt: string, graphContext?: string): TextBlockParam[] {
  const blocks: TextBlockParam[] = [{ type: "text", text: staticPrompt, cache_control: STATIC }];
  if (graphContext?.trim()) blocks.push({ type: "text", text: graphContext, cache_control: SHORT });
  return blocks;
}

function stripCacheControl(block: ContentBlockParam): ContentBlockParam {
  if (!("cache_control" in block) || !block.cache_control) return block;
  const copy = { ...block };
  delete copy.cache_control;
  return copy;
}

function markLastBlock(message: MessageParam): MessageParam {
  const blocks: ContentBlockParam[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [...message.content];
  const last = blocks[blocks.length - 1];
  if (!last || last.type === "thinking" || last.type === "redacted_thinking") return message;
  blocks[blocks.length - 1] = { ...last, cache_control: SHORT } as ContentBlockParam;
  return { ...message, content: blocks };
}

// The messages to send this round, with breakpoints 3 and 4 applied. Any
// breakpoints already inside `messages` (e.g. a paused run persisted by an
// older build) are removed first so the request never exceeds the limit.
// `historyEnd` is the index of the last prior-turn message, or null.
export function withCacheBreakpoints(
  messages: MessageParam[],
  historyEnd: number | null,
): MessageParam[] {
  const clean = messages.map((m) =>
    typeof m.content === "string" ? m : { ...m, content: m.content.map(stripCacheControl) },
  );
  const lastIndex = clean.length - 1;
  return clean.map((m, i) => {
    if (i === lastIndex) return markLastBlock(m);
    if (historyEnd !== null && i === historyEnd) return markLastBlock(m);
    return m;
  });
}
