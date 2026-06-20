import { describe, it, expect } from "vitest";

import { pickStallingNode, type SessionRow } from "./temporal-flags";

const NOW = Date.parse("2026-06-20T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function session(
  nodeId: string | null,
  createdDaysAgo: number,
  lastDaysAgo: number,
): SessionRow {
  return {
    scope_node_id: nodeId,
    created_at: daysAgo(createdDaysAgo),
    last_message_at: daysAgo(lastDaysAgo),
    message_count: 4,
  };
}

describe("pickStallingNode", () => {
  it("returns null when no node is in scope", () => {
    const rows = [session("a", 6, 0), session("a", 4, 0)];
    expect(pickStallingNode(rows, NOW, null)).toBeNull();
  });

  it("returns null with no sessions for the focused node", () => {
    expect(pickStallingNode([session("other", 6, 0), session("other", 4, 0)], NOW, "a")).toBeNull();
  });

  it("flags the focused node when returned across >=2 chats over >=3 days, recently", () => {
    const rows = [session("a", 5, 4), session("a", 1, 0)];
    const pick = pickStallingNode(rows, NOW, "a");
    expect(pick?.nodeId).toBe("a");
    expect(pick?.sessions).toBe(2);
    expect(pick?.days).toBe(5);
  });

  it("does NOT flag a single thread, no matter how long ago (need >=2 returns)", () => {
    expect(pickStallingNode([session("a", 5, 4)], NOW, "a")).toBeNull();
  });

  // The headline false-positive the review caught: ancient, never-reopened node.
  it("does NOT flag a node last touched long ago (recency gate)", () => {
    const rows = [session("a", 185, 184), session("a", 183, 180)]; // 2 chats, but ~180d stale
    expect(pickStallingNode(rows, NOW, "a")).toBeNull();
  });

  it("does NOT flag when all chats are within the same day (span too short)", () => {
    const rows = [session("a", 0, 0), session("a", 0, 0)];
    expect(pickStallingNode(rows, NOW, "a")).toBeNull();
  });

  it("only counts the focused node's sessions, ignoring others", () => {
    const rows = [
      session("a", 6, 0),
      session("a", 1, 0),
      session("b", 30, 0), // unrelated, ignored
    ];
    const pick = pickStallingNode(rows, NOW, "a");
    expect(pick?.nodeId).toBe("a");
    expect(pick?.sessions).toBe(2);
  });

  it("tolerates a missing last_message_at (falls back to created_at)", () => {
    const rows: SessionRow[] = [
      { scope_node_id: "a", created_at: daysAgo(5), last_message_at: null, message_count: 2 },
      { scope_node_id: "a", created_at: daysAgo(1), last_message_at: null, message_count: 2 },
    ];
    // span is first→last = 5d ago → 1d ago = 4 days (both fall back to created_at)
    expect(pickStallingNode(rows, NOW, "a")?.days).toBe(4);
  });

  it("does not crash on malformed timestamps", () => {
    const rows: SessionRow[] = [
      { scope_node_id: "a", created_at: "garbage", last_message_at: "also bad", message_count: 9 },
    ];
    expect(pickStallingNode(rows, NOW, "a")).toBeNull();
  });

  // Pin the recency gate at its exact boundary (latest chat <= 14 days).
  it("flags when the latest chat is exactly 14 days old", () => {
    const rows = [session("a", 18, 18), session("a", 14, 14)];
    expect(pickStallingNode(rows, NOW, "a")?.nodeId).toBe("a");
  });

  it("does NOT flag when the latest chat is 15 days old (just past recency)", () => {
    const rows = [session("a", 19, 19), session("a", 15, 15)];
    expect(pickStallingNode(rows, NOW, "a")).toBeNull();
  });

  // Pin the span gate at its exact boundary (first→last >= 3 days).
  it("flags at exactly a 3-day span", () => {
    const rows = [session("a", 3, 3), session("a", 0, 0)];
    expect(pickStallingNode(rows, NOW, "a")?.days).toBe(3);
  });

  // Isolates the last_message_at NaN fallback (the other malformed test
  // corrupts created_at too, so it can't reach this branch).
  it("falls back to created_at when only last_message_at is malformed", () => {
    const rows: SessionRow[] = [
      { scope_node_id: "a", created_at: daysAgo(5), last_message_at: "garbage", message_count: 2 },
      { scope_node_id: "a", created_at: daysAgo(1), last_message_at: "garbage", message_count: 2 },
    ];
    expect(pickStallingNode(rows, NOW, "a")?.days).toBe(4);
  });
});
