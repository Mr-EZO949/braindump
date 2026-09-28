import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionNodeStatus } from "./status-transition";

// Minimal chainable Supabase stand-in: every builder method records itself and
// returns the chain; maybeSingle() resolves to the given node row. Enough to
// assert WHICH writes a transition performs without a database.
function fakeSupabase(nodeRow: Record<string, unknown> | null) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "then") return undefined; // not a thenable; await yields the chain
          if (prop === "maybeSingle") {
            return async () => ({ data: nodeRow, error: null });
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: prop, args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

describe("transitionNodeStatus — habit semantics (#13)", () => {
  it("logs the user's LOCAL day for a habit and never marks the node completed", async () => {
    const { client, calls } = fakeSupabase({
      id: "habit-1",
      status: "active",
      node_type: "habit",
      workspace_id: "ws-1",
      completed_at: null,
    });

    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "habit-1",
      newStatus: "completed",
      today: "2026-09-28", // e.g. 00:30 in Milan — UTC would still say the 27th
      habitSource: "chat",
    });

    expect(result).toEqual({
      kind: "habit_logged",
      nodeId: "habit-1",
      status: "active",
      loggedOn: "2026-09-28",
    });

    const upsert = calls.find((c) => c.table === "habit_completions" && c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({
      node_id: "habit-1",
      completed_on: "2026-09-28",
      source: "chat",
    });

    // The node row must never be touched — that's what made habits vanish.
    expect(calls.some((c) => c.table === "nodes" && c.method === "update")).toBe(false);
  });
});

describe("transitionNodeStatus — guards", () => {
  it("is a no-op when the status is already the target", async () => {
    const { client, calls } = fakeSupabase({
      id: "t-1",
      status: "completed",
      node_type: "task",
      workspace_id: "ws-1",
      completed_at: "2026-09-27T10:00:00Z",
    });
    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "t-1",
      newStatus: "completed",
      today: "2026-09-28",
    });
    expect(result).toEqual({ kind: "unchanged", nodeId: "t-1", status: "completed" });
    expect(calls.some((c) => c.method === "update")).toBe(false);
  });

  it("refuses archived → completed with a human message", async () => {
    const { client } = fakeSupabase({
      id: "t-2",
      status: "archived",
      node_type: "task",
      workspace_id: "ws-1",
      completed_at: null,
    });
    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "t-2",
      newStatus: "completed",
      today: "2026-09-28",
    });
    expect(result).toMatchObject({ kind: "error", httpStatus: 422 });
    expect((result as { error: string }).error).toMatch(/archived/);
  });

  it("returns 404 for a node outside the user's scope", async () => {
    const { client } = fakeSupabase(null);
    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "nope",
      newStatus: "completed",
      today: "2026-09-28",
      workspaceId: "ws-1",
    });
    expect(result).toMatchObject({ kind: "error", httpStatus: 404 });
  });
});
