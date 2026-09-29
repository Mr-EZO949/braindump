import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { createFakeSupabase, type FakeTables } from "@/lib/test/fake-supabase";
import { transitionNodeStatus } from "./status-transition";

// A project with a task, a habit and an already-finished task under it; the
// task is the only prerequisite of a task elsewhere; the task is on today's plan.
function workspace(): FakeTables {
  const node = (id: string, node_type: string, status = "active", completed_at: string | null = null) => ({
    id,
    user_id: "u1",
    workspace_id: "ws1",
    title: id,
    node_type,
    status,
    completed_at,
    created_at: "2026-09-01T09:00:00.000Z",
    manual_weight: null,
    target_date: null,
  });
  const edge = (id: string, source: string, target: string, edge_type: string) => ({
    id,
    user_id: "u1",
    workspace_id: "ws1",
    source_node_id: source,
    target_node_id: target,
    edge_type,
    status: "active",
    confidence: 0.9,
    user_confirmed: false,
    user_rejected: false,
  });
  return {
    nodes: [
      node("project", "project"),
      node("task", "task"),
      node("habit", "habit"),
      node("old", "task", "completed", "2026-09-10T08:00:00.000Z"),
      node("next", "task"),
    ],
    edges: [
      edge("e1", "task", "project", "belongs_to"),
      edge("e2", "habit", "project", "belongs_to"),
      edge("e3", "old", "project", "belongs_to"),
      edge("e4", "task", "next", "prerequisite_for"),
    ],
    plan_tasks: [
      { id: "p1", user_id: "u1", workspace_id: "ws1", node_id: "task", done: false, scheduled_date: "2026-09-29" },
    ],
    feedback_events: [],
    ai_node_judgments: [],
    lifecycle_events: [],
    cascade_results: [],
    habit_completions: [],
    node_scores: [],
    edge_scores: [],
  };
}

const statusOf = (tables: FakeTables, id: string) =>
  tables.nodes.find((n) => n.id === id)?.status;

describe("transitionNodeStatus — cascades", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
  });
  afterAll(() => vi.useRealTimers());

  it("completes the subtree, unblocks, syncs the planner and logs the swept habit", async () => {
    const fake = createFakeSupabase(workspace());
    const result = await transitionNodeStatus({
      supabase: fake.client,
      userId: "u1",
      nodeId: "project",
      newStatus: "completed",
      today: "2026-09-29",
    });

    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect([...result.autoCompletedNodeIds].sort()).toEqual(["habit", "task"]);
    expect(result.newlyAvailable).toEqual([{ id: "next", title: "next" }]);
    expect(result.updatedTaskIds).toEqual(["p1"]);
    expect((result.updatedNode as { status: string }).status).toBe("completed");

    expect(statusOf(fake.tables, "task")).toBe("completed");
    expect(statusOf(fake.tables, "habit")).toBe("completed");
    expect(fake.tables.nodes.find((n) => n.id === "old")?.completed_at).toBe(
      "2026-09-10T08:00:00.000Z",
    );
    expect(fake.tables.plan_tasks[0].done).toBe(true);
    expect(fake.tables.habit_completions).toMatchObject([
      { node_id: "habit", completed_on: "2026-09-29", source: "plan_task" },
    ]);
    expect(fake.tables.lifecycle_events.map((e) => e.node_id).sort()).toEqual([
      "habit",
      "project",
      "task",
    ]);
    expect(fake.tables.cascade_results).toMatchObject([
      { affected_node_id: "next", action_taken: "unblocked" },
    ]);

    // The whole cascade — subtree, prerequisites, scores, planner — used to
    // take ~18 sequential round trips (up to 40+); it's staged in parallel now.
    expect(fake.stats.depth).toBeLessThanOrEqual(6);
  });

  it("reopens only the descendants completed in the same cascade", async () => {
    const fake = createFakeSupabase(workspace());
    const args = { supabase: fake.client, userId: "u1", nodeId: "project", today: "2026-09-29" };
    await transitionNodeStatus({ ...args, newStatus: "completed" });
    const result = await transitionNodeStatus({ ...args, newStatus: "active" });

    if (result.kind !== "changed") throw new Error(result.kind);
    expect([...result.autoReopenedNodeIds].sort()).toEqual(["habit", "task"]);
    expect(statusOf(fake.tables, "old")).toBe("completed");
    expect(statusOf(fake.tables, "task")).toBe("active");
    expect(fake.tables.plan_tasks[0].done).toBe(false);
  });

  it("returns the recomputed scores on the refreshed rows", async () => {
    const fake = createFakeSupabase(workspace());
    const result = await transitionNodeStatus({
      supabase: fake.client,
      userId: "u1",
      nodeId: "task",
      newStatus: "completed",
      today: "2026-09-29",
    });
    if (result.kind !== "changed") throw new Error(result.kind);
    const scores = result.recomputedScores as Array<{ id: string; current_importance_score: number }>;
    const stored = fake.tables.nodes.find((n) => n.id === "task");
    expect(stored?.current_importance_score).toBe(0);
    expect((result.updatedNode as { current_importance_score: number }).current_importance_score).toBe(
      scores.find((s) => s.id === "task")?.current_importance_score,
    );
  });
});

describe("computeWorkspaceScores — writes", () => {
  it("writes only the nodes whose score changed", async () => {
    const fake = createFakeSupabase(workspace());
    const scope = { workspaceId: "ws1", userId: "u1", supabase: fake.client };
    const first = await computeWorkspaceScores(scope);
    for (const update of first.nodeUpdates) {
      expect(fake.tables.nodes.find((n) => n.id === update.id)).toMatchObject({
        current_importance_score: update.current_importance_score,
        importance: update.importance,
        importance_top_signals: update.importance_top_signals,
      });
    }
    // Identical values share one UPDATE … IN (…).
    const firstNodeWrites = fake.stats.calls.filter((c) => c === "nodes.update").length;
    expect(firstNodeWrites).toBeLessThanOrEqual(first.nodeUpdates.length);

    fake.stats.calls.length = 0;
    const second = await computeWorkspaceScores(scope);
    expect(second.nodeUpdates).toEqual(first.nodeUpdates);
    expect(fake.stats.calls.filter((c) => c === "nodes.update")).toEqual([]);
  });
});
