import { describe, expect, it } from "vitest";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import { cachedSystem, cachedTools, withCacheBreakpoints } from "./assistant-cache";

function breakpoints(messages: MessageParam[]): string[] {
  const out: string[] = [];
  messages.forEach((m, i) => {
    if (typeof m.content === "string") return;
    m.content.forEach((b, j) => {
      if ("cache_control" in b && b.cache_control) out.push(`${i}.${j}`);
    });
  });
  return out;
}

const history: MessageParam[] = [
  { role: "user", content: [{ type: "text", text: "earlier question" }] },
  { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
];
const current: MessageParam = {
  role: "user",
  content: [
    { type: "text", text: "graph context", cache_control: { type: "ephemeral" } },
    { type: "text", text: "the message" },
  ],
};

describe("withCacheBreakpoints", () => {
  it("marks the history end and the last block of the last message", () => {
    const out = withCacheBreakpoints([...history, current], 1);
    expect(breakpoints(out)).toEqual(["1.0", "2.1"]);
  });

  it("moves the last-message breakpoint as tool rounds are appended", () => {
    const round2: MessageParam[] = [
      ...history,
      current,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_node", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ];
    expect(breakpoints(withCacheBreakpoints(round2, 1))).toEqual(["1.0", "4.0"]);
  });

  it("never exceeds two message breakpoints, even with stale markers inside", () => {
    const stale: MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
      current,
    ];
    expect(breakpoints(withCacheBreakpoints(stale, null))).toEqual(["2.1"]);
  });

  it("converts a string message to block form when marking it", () => {
    const out = withCacheBreakpoints([{ role: "user", content: "hi" }], null);
    expect(out[0].content).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });

  it("does not mutate the caller's messages", () => {
    const messages = [...history, current];
    withCacheBreakpoints(messages, 1);
    expect(breakpoints(messages)).toEqual(["2.0"]);
  });
});

describe("static prefix", () => {
  it("caches tools and system for an hour, on the last tool only", () => {
    const input: Tool[] = [
      { name: "a", input_schema: { type: "object" } },
      { name: "b", input_schema: { type: "object" } },
    ];
    const tools = cachedTools(input);
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(cachedSystem("s")[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
