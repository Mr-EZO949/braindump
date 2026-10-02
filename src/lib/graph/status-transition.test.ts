import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionNodeStatus } from "./status-transition";

// Minimal chainable Supabase stand-in: every builder method records itself and
// returns the chain; maybeSingle() resolves to the given node row. Enough to
// assert WHICH writes a transition performs without a database.
// writeErrors: table → the error message a write to it resolves with.
function fakeSupabase(nodeRow: Record<string, unknown> | null, writeErrors: Record<string, string> = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "then") return undefined; // not a thenable; await yields the chain
          if (prop === "error") return writeErrors[table] ? { message: writeErrors[table] } : null;
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

    // Stored as the user's own check-in: the column's check constraint only
    // allows 'manual' | 'plan_task', and 'chat' was rejected on every write.
    const upsert = calls.find((c) => c.table === "habit_completions" && c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({
      node_id: "habit-1",
      completed_on: "2026-09-28",
      source: "manual",
    });

    // The node row must never be touched — that's what made habits vanish.
    expect(calls.some((c) => c.table === "nodes" && c.method === "update")).toBe(false);
  });

  it("reports a failed check-in instead of claiming it was logged", async () => {
    const { client } = fakeSupabase(
      { id: "habit-1", status: "active", node_type: "habit", workspace_id: "ws-1", completed_at: null },
      { habit_completions: 'new row violates check constraint "habit_completions_source_check"' },
    );

    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "habit-1",
      newStatus: "completed",
      today: "2026-09-28",
      habitSource: "dump",
    });

    expect(result.kind).toBe("error");
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

  it("lets a waiting (paused) node complete directly and clears its hold", async () => {
    const { client, calls } = fakeSupabase({
      id: "g-1",
      status: "paused",
      node_type: "goal",
      workspace_id: "ws-1",
      completed_at: null,
    });
    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "g-1",
      newStatus: "completed",
      today: "2026-10-15",
      recomputeScores: false,
    }).catch((error: unknown) => ({ kind: "threw", error }));
    // The guard allows it (this minimal fake can't run the rest of the
    // completion cascade, so only the guard and the node write are asserted).
    expect(result).not.toMatchObject({ kind: "error", httpStatus: 422 });
    const update = calls.find((c) => c.table === "nodes" && c.method === "update");
    expect(update?.args[0]).toMatchObject({ status: "completed", waiting_for: null, resume_on: null });
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

// A fake whose queries resolve: each from() chain is recorded and awaits to
// { data: respond(table, ops), error: null }, so a transition runs to the end.
function resolvingSupabase(
  nodeRow: Record<string, unknown>,
  respond: (table: string, ops: Array<{ method: string; args: unknown[] }>) => unknown,
) {
  const chains: Array<{ table: string; ops: Array<{ method: string; args: unknown[] }> }> = [];
  const from = (table: string) => {
    const record = { table, ops: [] as Array<{ method: string; args: unknown[] }> };
    chains.push(record);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "maybeSingle") return async () => ({ data: nodeRow, error: null });
          if (prop === "then") {
            return (resolve: (value: unknown) => void) =>
              resolve({ data: respond(table, record.ops), error: null });
          }
          return (...args: unknown[]) => {
            record.ops.push({ method: prop, args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, chains };
}

const edgeUpdates = (chains: Array<{ table: string; ops: Array<{ method: string; args: unknown[] }> }>) =>
  chains.filter((c) => c.table === "edges" && c.ops.some((op) => op.method === "update"));

describe("transitionNodeStatus — archive edges", () => {
  it("archiving orphans only live edges, so a rejected link stays rejected", async () => {
    const { client, chains } = resolvingSupabase(
      { id: "a", status: "active", node_type: "task", workspace_id: "ws-1", completed_at: null },
      () => null,
    );
    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "a",
      newStatus: "archived",
      today: "2026-10-02",
      recomputeScores: false,
    });
    expect(result).toMatchObject({ kind: "changed", status: "archived" });
    const [update] = edgeUpdates(chains);
    expect(update.ops).toContainEqual({ method: "in", args: ["status", ["active", "decayed"]] });
  });

  it("unarchiving a node that was moved first revives one parent, not both", async () => {
    const touching = [
      { id: "old", source_node_id: "a", target_node_id: "p1", edge_type: "belongs_to", status: "orphaned", created_at: "2026-09-01T00:00:00Z" },
      { id: "new", source_node_id: "a", target_node_id: "p2", edge_type: "belongs_to", status: "orphaned", created_at: "2026-09-20T00:00:00Z" },
    ];
    const { client, chains } = resolvingSupabase(
      { id: "a", status: "archived", node_type: "task", workspace_id: "ws-1", completed_at: null },
      (table, ops) => {
        if (table === "edges" && ops.some((op) => op.method === "or")) return touching;
        if (table === "nodes" && ops.some((op) => op.method === "select")) {
          return [
            { id: "p1", status: "active" },
            { id: "p2", status: "active" },
          ];
        }
        return null;
      },
    );
    const result = await transitionNodeStatus({
      supabase: client,
      userId: "user-1",
      nodeId: "a",
      newStatus: "active",
      today: "2026-10-02",
      recomputeScores: false,
    });
    expect(result).toMatchObject({ kind: "changed", status: "active" });
    const [update] = edgeUpdates(chains);
    expect(update.ops).toContainEqual({ method: "update", args: [expect.objectContaining({ status: "active" })] });
    expect(update.ops).toContainEqual({ method: "in", args: ["id", ["new"]] });
  });
});
