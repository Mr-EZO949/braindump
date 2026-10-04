import { describe, expect, it } from "vitest";

import type { Edge, GraphData, Node } from "@/types/graph";

import { placeAcceptedNodes, stepCandidates, withMergedNode, withoutNodes, withReviewedEdges } from "./graph-patches";

const node = (id: string, extra: Partial<Node> = {}) =>
  ({ id, title: id, node_type: "task", status: "active", position_x: 5, position_y: 5, manual_position: true, ...extra }) as Node;
const edge = (id: string, source: string, target: string, edge_type: Edge["edge_type"] = "belongs_to") =>
  ({ id, source_node_id: source, target_node_id: target, edge_type, status: "active" }) as Edge;

describe("placeAcceptedNodes", () => {
  it("lets attached nodes go to the tree layout and grids the rest around the view centre", () => {
    const { positioned, stored } = placeAcceptedNodes(
      [node("a"), node("b"), node("c"), node("d")],
      [edge("e1", "a", "root"), edge("e2", "b", "x", "related_to")],
      { zoom: 2, panX: -440, panY: 0 },
    );
    // centre (220, 0); three loose nodes → 2 columns, 2 rows.
    expect(positioned[0]).toMatchObject({ id: "a", manual_position: false, position_x: null, position_y: null });
    expect(positioned.slice(1).map((n) => [n.id, n.position_x, n.position_y, n.manual_position])).toEqual([
      ["b", 110, -110, true],
      ["c", 330, -110, true],
      ["d", 110, 110, true],
    ]);
    expect(stored).toEqual([
      { nodeId: "a", position: null },
      { nodeId: "b", position: { x: 110, y: -110 } },
      { nodeId: "c", position: { x: 330, y: -110 } },
      { nodeId: "d", position: { x: 110, y: 110 } },
    ]);
  });

  it("uses the origin without a camera", () => {
    expect(placeAcceptedNodes([node("a")], [], null).positioned[0]).toMatchObject({ position_x: 0, position_y: 0 });
  });
});

describe("stepCandidates", () => {
  it("offers steps for goals, projects, big tasks and habits that have nothing under them", () => {
    const accepted = [
      node("g", { node_type: "goal" }),
      node("p", { node_type: "project" }),
      node("t"),
      node("h", { node_type: "habit" }),
    ];
    const ids = stepCandidates(accepted, [edge("e1", "t", "p")], [edge("e2", "x", "h")]).map((n) => n.id);
    expect(ids).toEqual(["g"]);
  });
});

describe("withReviewedEdges", () => {
  const graph: GraphData = { nodes: [node("a"), node("b")], edges: [] };

  it("adds links and lets the layout re-place every node", () => {
    const next = withReviewedEdges(graph, [edge("e", "a", "b")], new Map([["a", node("a", { title: "A2" })]]));
    expect(next.edges).toHaveLength(1);
    expect(next.nodes[0]).toMatchObject({ title: "A2", manual_position: false, position_x: null });
    expect(next.nodes[1]).toMatchObject({ manual_position: false, position_x: null });
  });

  it("only updates nodes when no link was accepted", () => {
    const next = withReviewedEdges(graph, [], new Map([["b", node("b", { title: "B2" })]]));
    expect(next.nodes[1]).toMatchObject({ title: "B2", manual_position: true, position_x: 5 });
  });
});

describe("withMergedNode / withoutNodes", () => {
  const graph: GraphData = {
    nodes: [node("keep"), node("dup"), node("other")],
    edges: [edge("e1", "dup", "keep"), edge("e2", "other", "keep")],
  };

  it("drops the archived duplicate and its edges, and applies new scores", () => {
    const next = withMergedNode(graph, "dup", [
      { id: "keep", current_importance_score: 77, importance_index: 80, importance: "high" },
    ]);
    expect(next.nodes.map((n) => n.id)).toEqual(["keep", "other"]);
    expect(next.nodes[0]).toMatchObject({ current_importance_score: 77, importance: "high" });
    expect(next.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("removes nodes with every edge that touched them", () => {
    const next = withoutNodes(graph, new Set(["keep"]));
    expect(next.nodes.map((n) => n.id)).toEqual(["dup", "other"]);
    expect(next.edges).toEqual([]);
  });
});
