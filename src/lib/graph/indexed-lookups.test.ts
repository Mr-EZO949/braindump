// A 2026-09-25 refactor replaced full-graph scans on node selection with lookup
// indexes: the delete preview (getStructuralSubtree*) and the details panel
// (buildChatNodeContext). These tests pin the new code to the ORIGINAL
// algorithms on random graphs, so the speed-up can't change what gets deleted
// or shown.

import { describe, expect, it } from "vitest";

import type { Edge, EdgeType, GraphData, Node } from "@/types/graph";

import { buildChatNodeContext } from "./data";
import {
  buildPrimaryStructuralTree,
  getStructuralSubtree,
  getStructuralSubtreeFromIndexes,
} from "./structure";

const EDGE_TYPES: EdgeType[] = [
  "belongs_to",
  "required_for",
  "prerequisite_for",
  "supports",
  "related_to",
  "blocks",
];

// Small deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomGraph(seed: number): GraphData {
  const rand = rng(seed);
  const nodeCount = 2 + Math.floor(rand() * 30);
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    title: `Node ${i}`,
    summary: null,
    node_type: "task",
    importance: "medium",
    status: "active",
  })) as unknown as Node[];
  const edges: Edge[] = [];
  const edgeCount = Math.floor(rand() * nodeCount * 2);
  for (let i = 0; i < edgeCount; i += 1) {
    const a = Math.floor(rand() * nodeCount);
    let b = Math.floor(rand() * nodeCount);
    if (b === a) b = (b + 1) % nodeCount; // the app never creates self-links
    edges.push({
      id: `e${i}`,
      source_node_id: `n${a}`,
      target_node_id: `n${b}`,
      edge_type: EDGE_TYPES[Math.floor(rand() * EDGE_TYPES.length)],
    } as Edge);
  }
  return { nodes, edges };
}

// The pre-refactor delete preview, verbatim in behavior: walk the structural
// tree, then take every edge touching the subtree by scanning all edges.
function originalSubtree(graph: GraphData, rootId: string) {
  const { childrenByParent } = buildPrimaryStructuralTree(graph);
  const visited = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const child of childrenByParent.get(id) ?? []) if (!visited.has(child)) stack.push(child);
  }
  const nodeIds = [...visited];
  const edgeIds = graph.edges
    .filter((e) => visited.has(e.source_node_id) || visited.has(e.target_node_id))
    .map((e) => e.id);
  return { descendantCount: Math.max(nodeIds.length - 1, 0), nodeIds, edgeIds };
}

function incidentIndex(graph: GraphData) {
  const index = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    for (const id of [edge.source_node_id, edge.target_node_id]) {
      index.set(id, [...(index.get(id) ?? []), edge]);
    }
  }
  return index;
}

const sorted = (values: string[]) => [...values].sort();

describe("indexed delete preview == original scan", () => {
  it("returns the same nodes and edges for every node of 300 random graphs", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const graph = randomGraph(seed);
      const { childrenByParent } = buildPrimaryStructuralTree(graph);
      const index = incidentIndex(graph);
      for (const node of graph.nodes) {
        const expected = originalSubtree(graph, node.id);
        for (const actual of [
          getStructuralSubtree(graph, node.id),
          getStructuralSubtreeFromIndexes(node.id, childrenByParent, index),
        ]) {
          expect(sorted(actual.nodeIds), `seed ${seed} node ${node.id}`).toEqual(sorted(expected.nodeIds));
          expect(sorted(actual.edgeIds), `seed ${seed} node ${node.id}`).toEqual(sorted(expected.edgeIds));
          expect(actual.descendantCount).toBe(expected.descendantCount);
        }
      }
    }
  });
});

describe("indexed details panel == unindexed", () => {
  it("builds the same node context with and without the lookup indexes", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const graph = randomGraph(seed);
      const indexes = {
        nodesById: new Map(graph.nodes.map((n) => [n.id, n])),
        incidentEdgesByNode: incidentIndex(graph),
      };
      for (const node of graph.nodes) {
        expect(buildChatNodeContext(graph, node.id, indexes), `seed ${seed} node ${node.id}`).toEqual(
          buildChatNodeContext(graph, node.id),
        );
      }
      expect(buildChatNodeContext(graph, "missing", indexes)).toBeNull();
    }
  });
});
