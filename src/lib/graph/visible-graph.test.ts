import { describe, expect, it } from "vitest";

import type { Edge, GraphData, Node } from "@/types/graph";

import {
  RECENT_COMPLETION_WINDOW_MS,
  countNodeTypes,
  hashGraphContent,
  indexIncidentEdges,
  isRecentCompletion,
  nodeConnections,
  parentContextTitle,
  shelvedCompletedNodes,
  visibleGraph,
} from "./visible-graph";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const CUTOFF = NOW - RECENT_COMPLETION_WINDOW_MS;
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const node = (id: string, extra: Partial<Node> = {}) =>
  ({ id, title: id.toUpperCase(), node_type: "task", status: "active", ...extra }) as Node;
const edge = (id: string, source: string, target: string, extra: Partial<Edge> = {}) =>
  ({ id, source_node_id: source, target_node_id: target, edge_type: "belongs_to", status: "active", ...extra }) as Edge;

describe("isRecentCompletion", () => {
  it("is true inside the window and false outside or without a date", () => {
    expect(isRecentCompletion(node("a", { completed_at: daysAgo(2) }), CUTOFF)).toBe(true);
    expect(isRecentCompletion(node("a", { completed_at: daysAgo(8) }), CUTOFF)).toBe(false);
    expect(isRecentCompletion(node("a", { completed_at: null }), CUTOFF)).toBe(false);
    expect(isRecentCompletion(node("a", { completed_at: "not a date" }), CUTOFF)).toBe(false);
  });
});

describe("visibleGraph + shelvedCompletedNodes", () => {
  const graph: GraphData = {
    nodes: [
      node("open"),
      node("goal", { node_type: "goal" }),
      node("fresh", { status: "completed", completed_at: daysAgo(1) }),
      node("old", { status: "completed", completed_at: daysAgo(30) }),
      node("arch", { status: "archived" }),
    ],
    edges: [
      edge("e1", "open", "goal"),
      edge("e2", "fresh", "goal"),
      edge("e3", "old", "goal"),
      edge("e4", "arch", "goal"),
      edge("e5", "open", "goal", { status: "orphaned" }),
    ],
  };

  it("keeps recent completions on the board and shelves old ones and archived nodes", () => {
    const shown = visibleGraph(graph, { hideCompleted: false, nodeTypeFilter: "all", recentCompletionCutoffMs: CUTOFF });
    expect(shown.nodes.map((n) => n.id)).toEqual(["open", "goal", "fresh"]);
    expect(shown.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(shelvedCompletedNodes(graph.nodes, false, CUTOFF).map((n) => n.id)).toEqual(["old"]);
  });

  it("'Hide done' shelves every completion", () => {
    const shown = visibleGraph(graph, { hideCompleted: true, nodeTypeFilter: "all", recentCompletionCutoffMs: CUTOFF });
    expect(shown.nodes.map((n) => n.id)).toEqual(["open", "goal"]);
    expect(shelvedCompletedNodes(graph.nodes, true, CUTOFF).map((n) => n.id)).toEqual(["fresh", "old"]);
  });

  it("applies the type filter to nodes and drops edges to filtered-out nodes", () => {
    const shown = visibleGraph(graph, { hideCompleted: false, nodeTypeFilter: "goal", recentCompletionCutoffMs: CUTOFF });
    expect(shown.nodes.map((n) => n.id)).toEqual(["goal"]);
    expect(shown.edges).toEqual([]);
  });
});

describe("hashGraphContent", () => {
  const base = { nodes: [node("a", { updated_at: "t1" })], edges: [edge("e", "a", "b")] };

  it("is stable for the same content and changes with what the user sees", () => {
    expect(hashGraphContent(base.nodes, base.edges)).toBe(hashGraphContent([...base.nodes], [...base.edges]));
    expect(hashGraphContent(base.nodes, base.edges)).toMatch(/^1:1:[0-9a-z]+$/);
    const renamed = [node("a", { updated_at: "t2" })];
    expect(hashGraphContent(renamed, base.edges)).not.toBe(hashGraphContent(base.nodes, base.edges));
    const orphaned = [edge("e", "a", "b", { status: "orphaned" })];
    expect(hashGraphContent(base.nodes, orphaned)).not.toBe(hashGraphContent(base.nodes, base.edges));
  });
});

describe("countNodeTypes", () => {
  it("counts open nodes per type, sorted by label", () => {
    const counts = countNodeTypes([
      node("t1"),
      node("t2"),
      node("g", { node_type: "goal" }),
      node("done", { status: "completed" }),
      node("gone", { node_type: "goal", status: "archived" }),
    ]);
    expect(counts.map((c) => [c.type, c.count])).toEqual([
      ["goal", 1],
      ["task", 2],
    ]);
    expect(counts[0].label).toBe("Goal");
  });
});

describe("nodeConnections", () => {
  it("lists a node's visible links by the linked node's title", () => {
    const graph: GraphData = {
      nodes: [node("a"), node("z", { title: "Zed" }), node("b", { title: "Bee" })],
      edges: [edge("e1", "a", "z"), edge("e2", "b", "a", { edge_type: "supports" }), edge("e3", "a", "missing")],
    };
    const list = nodeConnections("a", indexIncidentEdges(graph));
    expect(list.map((c) => [c.edgeId, c.title])).toEqual([
      ["e2", "Bee"],
      ["e1", "Zed"],
    ]);
    expect(nodeConnections(null, indexIncidentEdges(graph))).toEqual([]);
  });
});

describe("parentContextTitle", () => {
  const graph: GraphData = {
    nodes: [node("root", { title: "Life" }), node("p", { title: "Stats" }), node("s"), node("t")],
    edges: [edge("e1", "s", "p"), edge("e2", "t", "root"), edge("e3", "p", "root", { status: "orphaned" })],
  };

  it("names the live parent, but not the workspace root", () => {
    expect(parentContextTitle(graph, "s", "root")).toBe("Stats");
    expect(parentContextTitle(graph, "t", "root")).toBeNull();
    expect(parentContextTitle(graph, "p", "root")).toBeNull();
    expect(parentContextTitle(graph, "t", null)).toBe("Life");
  });
});
