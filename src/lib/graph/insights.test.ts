import { describe, expect, it } from "vitest";

import {
  calculateLinkedNodePriority,
  getFocusItems,
  getLinkedNodePerspectives,
} from "./insights";
import type { ChatNodeContext } from "@/types/chat";
import type { Edge, GraphData, Node } from "@/types/graph";

// Convert a graph Node into a ChatNodeContext for tests — getFocusItems
// takes ChatNodeContext, not Node, but the fields it actually reads
// (id, title, node_type) map 1:1.
function asChatContext(node: Node): ChatNodeContext {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary,
    node_type: node.node_type,
    importance: node.importance,
    importanceIndex: node.importance_index ?? 50,
    currentImportanceScore: node.current_importance_score ?? null,
    status: node.status ?? null,
    connectedNodeTitles: [],
    edgeTypes: [],
  };
}

// Minimal Node + Edge factories. Importance defaults to 50 so tests can
// adjust to verify the importance bonus contribution.
function makeNode(
  id: string,
  overrides: Partial<Node> = {},
): Node {
  return {
    id,
    title: id,
    summary: null,
    body: null,
    node_type: "task",
    status: "active",
    importance: "medium",
    importance_index: 50,
    current_importance_score: 50,
    workspace_id: "ws",
    user_id: "u",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    archived_at: null,
    target_date: null,
    manual_weight: null,
    rest_x: 0,
    rest_y: 0,
    ...overrides,
  } as Node;
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  edge_type: Edge["edge_type"],
): Edge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    edge_type,
    status: "active",
    confidence: 1,
    user_confirmed: true,
    user_rejected: false,
    workspace_id: "ws",
    user_id: "u",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as Edge;
}

describe("calculateLinkedNodePriority", () => {
  it("ranks required_for above belongs_to above supports above related_to", () => {
    const node = makeNode("n", { importance_index: 50 });
    const required = calculateLinkedNodePriority("required_for", node);
    const belongs = calculateLinkedNodePriority("belongs_to", node);
    const supports = calculateLinkedNodePriority("supports", node);
    const related = calculateLinkedNodePriority("related_to", node);
    expect(required).toBeGreaterThan(belongs);
    expect(belongs).toBeGreaterThan(supports);
    expect(supports).toBeGreaterThan(related);
  });

  it("higher importance increases priority within the same edge type", () => {
    const low = calculateLinkedNodePriority(
      "belongs_to",
      makeNode("low", { importance_index: 10 }),
    );
    const high = calculateLinkedNodePriority(
      "belongs_to",
      makeNode("high", { importance_index: 90 }),
    );
    expect(high).toBeGreaterThan(low);
  });

  it("importance bonus is small enough to stay within a tier", () => {
    // Max importance bonus is round(100 * 0.08) = 8. The tier gap from
    // supports (70) to belongs_to (90) is 20 — so a high-importance
    // support node (70+8=78) must NOT outrank a low-importance child
    // (90+0=90).
    const highSupport = calculateLinkedNodePriority(
      "supports",
      makeNode("hs", { importance_index: 100 }),
    );
    const lowChild = calculateLinkedNodePriority(
      "belongs_to",
      makeNode("lc", { importance_index: 0 }),
    );
    expect(highSupport).toBeLessThan(lowChild);
  });
});

describe("getLinkedNodePerspectives", () => {
  it("returns empty for null selection", () => {
    const graph: GraphData = { nodes: [], edges: [] };
    expect(getLinkedNodePerspectives(graph, null)).toEqual([]);
  });

  it("orders related nodes by priority then title", () => {
    const focus = makeNode("focus");
    const child = makeNode("child", { node_type: "task", importance_index: 50 });
    const sibling = makeNode("sibling", { importance_index: 50 });
    const graph: GraphData = {
      nodes: [focus, child, sibling],
      edges: [
        makeEdge("e1", "child", "focus", "belongs_to"), // child→focus
        makeEdge("e2", "focus", "sibling", "related_to"),
      ],
    };
    const result = getLinkedNodePerspectives(graph, "focus");
    expect(result.map((r) => r.node.id)).toEqual(["child", "sibling"]);
  });

  it("dedupes multi-edge connections by linked node", () => {
    const focus = makeNode("focus");
    const other = makeNode("other");
    const graph: GraphData = {
      nodes: [focus, other],
      edges: [
        makeEdge("e1", "other", "focus", "belongs_to"),
        makeEdge("e2", "other", "focus", "supports"),
      ],
    };
    const result = getLinkedNodePerspectives(graph, "focus");
    expect(result).toHaveLength(1);
    expect(result[0].edgeTypes).toHaveLength(2);
  });

  it("excludes edges hidden in UI", () => {
    const focus = makeNode("focus");
    const other = makeNode("other");
    const graph: GraphData = {
      nodes: [focus, other],
      edges: [makeEdge("e1", "other", "focus", "blocks")],
    };
    expect(getLinkedNodePerspectives(graph, "focus")).toHaveLength(0);
  });
});

describe("getFocusItems", () => {
  it("returns empty for non-focus-capable node types", () => {
    const node = makeNode("t", { node_type: "task" });
    expect(getFocusItems({ nodes: [node], edges: [] }, asChatContext(node))).toEqual([]);
  });

  it("hard prereqs outrank every child type", () => {
    const goal = makeNode("goal", { node_type: "goal" });
    const childTask = makeNode("child", { node_type: "task", importance_index: 100 });
    const prereq = makeNode("prereq", { importance_index: 0 });
    const graph: GraphData = {
      nodes: [goal, childTask, prereq],
      edges: [
        makeEdge("e1", "childTask", "goal", "belongs_to"),
        makeEdge("e2", "prereq", "goal", "required_for"),
      ],
    };
    // Note: edges reference IDs as strings — fix factory uses ids directly:
    graph.edges[0] = makeEdge("e1", "child", "goal", "belongs_to");
    graph.edges[1] = makeEdge("e2", "prereq", "goal", "required_for");

    const items = getFocusItems(graph, asChatContext(goal));
    expect(items.length).toBeGreaterThanOrEqual(2);
    // The prereq must come first even though the child has higher importance.
    expect(items[0].nodeId).toBe("prereq");
  });

  it("orders child types: task > project > class > concept", () => {
    const goal = makeNode("goal", { node_type: "goal" });
    const childTask = makeNode("task1", { node_type: "task", importance_index: 50 });
    const childProj = makeNode("proj1", { node_type: "project", importance_index: 50 });
    const childClass = makeNode("class1", { node_type: "class", importance_index: 50 });
    const graph: GraphData = {
      nodes: [goal, childTask, childProj, childClass],
      edges: [
        makeEdge("e1", "task1", "goal", "belongs_to"),
        makeEdge("e2", "proj1", "goal", "belongs_to"),
        makeEdge("e3", "class1", "goal", "belongs_to"),
      ],
    };
    const items = getFocusItems(graph, asChatContext(goal));
    expect(items.map((i) => i.nodeId)).toEqual(["task1", "proj1", "class1"]);
  });

  it("returns at most 5 items even with many candidates", () => {
    const goal = makeNode("goal", { node_type: "goal" });
    const children = Array.from({ length: 12 }, (_, i) =>
      makeNode(`c${i}`, { node_type: "task" }),
    );
    const edges = children.map((c, i) =>
      makeEdge(`e${i}`, c.id, "goal", "belongs_to"),
    );
    const items = getFocusItems(
      { nodes: [goal, ...children], edges },
      asChatContext(goal),
    );
    expect(items.length).toBeLessThanOrEqual(5);
  });
});
