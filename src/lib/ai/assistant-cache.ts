// Prompt-cache layout for the assistant's agent loop (chat + resume routes).
//
// Anthropic allows 4 cache breakpoints per request, over the prefix order
// tools → system → messages:
//   1. tools         1h — identical for every user and every turn
//   2. system        1h — per mode + date, shared by every user in that mode
//   3. history end   5m — turn N+1 re-reads turn N's history at 0.1× and only
//                         pays to write the newest exchange (chat-memory.ts
//                         keeps that prefix stable)
//   4. last message  5m — moves every tool round, so round k re-reads
//                         everything up to round k-1 instead of re-paying it
// 1h entries must come before 5m ones, which this order satisfies.

import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";

const LONG = { type: "ephemeral", ttl: "1h" } as const;
const SHORT = { type: "ephemeral" } as const;

export function cachedTools<T extends Tool>(tools: T[]): T[] {
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: LONG } : t));
}

export function cachedSystem(text: string): TextBlockParam[] {
  return [{ type: "text", text, cache_control: LONG }];
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
