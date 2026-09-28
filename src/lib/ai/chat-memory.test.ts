import { describe, expect, it } from "vitest";

import { buildHistoryMessages, sanitizeHistory, trimHistory, type HistoryTurn } from "./chat-memory";

function thread(n: number): HistoryTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    body: `turn ${i}`,
  }));
}

describe("trimHistory", () => {
  it("keeps short threads verbatim", () => {
    const { turns, trimmed } = trimHistory(thread(12));
    expect(turns).toHaveLength(12);
    expect(trimmed).toBe(false);
  });

  it("drops the oldest turns in whole chunks and opens on a user turn", () => {
    const { turns, trimmed } = trimHistory(thread(13));
    expect(trimmed).toBe(true);
    expect(turns[0]).toEqual({ role: "user", body: "turn 6" });
    expect(turns).toHaveLength(7);
  });

  it("keeps the same prefix across consecutive turns until the next chunk drops", () => {
    // Cache stability: growing the thread must not move the cut on every turn.
    const first = (n: number) => trimHistory(thread(n)).turns[0].body;
    expect(first(13)).toBe(first(14));
    expect(first(14)).toBe(first(18));
    expect(first(19)).not.toBe(first(18));
  });

  it("caps very long turns", () => {
    const { turns } = trimHistory([{ role: "user", body: "x".repeat(5000) }]);
    expect(turns[0].body.length).toBeLessThan(2100);
    expect(turns[0].body.endsWith("…[truncated]")).toBe(true);
  });
});

describe("buildHistoryMessages", () => {
  it("emits block-form turns and flags a trimmed window", () => {
    const messages = buildHistoryMessages(thread(13));
    const first = messages[0].content as Array<{ type: string; text: string }>;
    expect(first[0].type).toBe("text");
    expect(first[0].text.startsWith("[Earlier messages in this thread were trimmed")).toBe(true);
  });

  it("returns nothing for an empty thread", () => {
    expect(buildHistoryMessages([])).toEqual([]);
  });
});

describe("sanitizeHistory", () => {
  it("drops empty and malformed turns", () => {
    expect(
      sanitizeHistory([{ role: "user", body: "  hi " }, { role: "system", body: "x" }, { role: "assistant", body: " " }, null]),
    ).toEqual([{ role: "user", body: "hi" }]);
  });
});
