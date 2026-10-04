import { describe, expect, it } from "vitest";

import type { Edge, GraphData, Node } from "@/types/graph";

import {
  applyOptimisticStatus,
  belongsToDescendants,
  mergeServerStatus,
  planStatusChange,
  revertOptimisticStatus,
} from "./status-optimistic";

const node = (id: string, extra: Partial<Node> = {}) =>
  ({ id, title: id, node_type: "task", status: "active", completed_at: null, ...extra }) as Node;
const edge = (id: string, source: string, target: string, extra: Partial<Edge> = {}) =>
  ({ id, source_node_id: source, target_node_id: target, edge_type: "belongs_to", status: "active", ...extra }) as Edge;

// p ← c1 ← g1, p ← c2 (done), p ← c3 (orphaned edge), p —supports— x
const graph: GraphData = {
  nodes: [
    node("p", { node_type: "project" }),
    node("c1"),
    node("g1"),
    node("c2", { status: "completed", completed_at: "earlier" }),
    node("c3"),
    node("x"),
  ],
  edges: [
    edge("e1", "c1", "p"),
    edge("e2", "g1", "c1"),
    edge("e3", "c2", "p"),
    edge("e4", "c3", "p", { status: "orphaned" }),
    edge("e5", "p", "x", { edge_type: "supports" }),
  ],
};
const p = graph.nodes[0];
const now = () => "NOW";

describe("belongsToDescendants", () => {
  it("walks live belongs_to children only", () => {
    expect(belongsToDescendants(graph, "p", () => true).sort()).toEqual(["c1", "c2", "g1"]);
    expect(belongsToDescendants(graph, "p", (n) => n.status === "completed")).toEqual(["c2"]);
  });
});

describe("completing a parent", () => {
  const plan = planStatusChange(graph, p, "completed");

  it("cascades to open descendants and snapshots them", () => {
    expect(plan.cascadeStatus).toBe("completed");
    expect(plan.cascadeIds.sort()).toEqual(["c1", "g1"]);
    expect([...plan.affectedSnapshot.keys()].sort()).toEqual(["c1", "g1", "p"]);
    expect(plan.edgeStatusChanges.size).toBe(0);
  });

  it("shows at once, and reverts exactly on failure", () => {
    const shown = applyOptimisticStatus(graph, plan, "completed", now);
    const status = Object.fromEntries(shown.nodes.map((n) => [n.id, `${n.status}@${n.completed_at}`]));
    expect(status).toMatchObject({ p: "completed@NOW", c1: "completed@NOW", g1: "completed@NOW", c2: "completed@earlier", c3: "active@null" });
    const back = revertOptimisticStatus(shown, plan, p.status, now);
    expect(back.nodes).toEqual(graph.nodes);
  });

  it("takes the server's rows and rolls back what it didn't confirm", () => {
    const shown = applyOptimisticStatus(graph, plan, "completed", now);
    const merged = mergeServerStatus(
      shown,
      plan,
      {
        updated_node: { ...p, status: "completed", completed_at: "S" },
        auto_completed_node_ids: ["c1"],
        recomputed_scores: [{ id: "x", current_importance_score: 9, importance_index: 10, importance: "low" }],
      },
      "SERVER",
    );
    const byId = new Map(merged.nodes.map((n) => [n.id, n]));
    expect(byId.get("p")?.completed_at).toBe("S");
    expect(byId.get("c1")?.completed_at).toBe("SERVER");
    expect(byId.get("g1")?.status).toBe("active");
    expect(byId.get("x")?.current_importance_score).toBe(9);
  });
});

describe("reopening and archiving", () => {
  it("reopens completed descendants with the parent", () => {
    const done = { ...p, status: "completed" as const };
    const plan = planStatusChange({ ...graph, nodes: [done, ...graph.nodes.slice(1)] }, done, "active");
    expect(plan.cascadeStatus).toBe("active");
    expect(plan.cascadeIds).toEqual(["c2"]);
  });

  it("orphans live edges on archive and snapshots their statuses", () => {
    const plan = planStatusChange(graph, p, "archived");
    expect(plan.cascadeStatus).toBeNull();
    expect([...plan.edgeStatusChanges.entries()].sort()).toEqual([
      ["e1", "orphaned"],
      ["e3", "orphaned"],
      ["e5", "orphaned"],
    ]);
    const shown = applyOptimisticStatus(graph, plan, "archived", now);
    expect(shown.edges.find((e) => e.id === "e4")?.status).toBe("orphaned");
    const back = revertOptimisticStatus(shown, plan, "active", now);
    expect(back.edges).toEqual(graph.edges);
  });

  it("revives edges on restore from the archive", () => {
    const archived = node("a", { status: "archived" });
    const g: GraphData = { nodes: [archived, node("q")], edges: [edge("ea", "a", "q", { status: "orphaned" })] };
    const plan = planStatusChange(g, archived, "active");
    expect([...plan.edgeStatusChanges.entries()]).toEqual([["ea", "active"]]);
    expect(plan.edgeStatusSnapshot.get("ea")).toBe("orphaned");
  });
});
