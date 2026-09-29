import { describe, expect, it } from "vitest";

import type { Edge, GraphData, Node } from "@/types/graph";

import { computeWorkProgress } from "./work-progress";

const node = (id: string, node_type: Node["node_type"], status: Node["status"] = "active") =>
  ({ id, node_type, status, title: id }) as Node;
const child = (source: string, target: string, edge_type: Edge["edge_type"] = "belongs_to") =>
  ({ id: `${source}-${target}`, source_node_id: source, target_node_id: target, edge_type }) as Edge;

describe("computeWorkProgress", () => {
  it("counts done and total steps under big tasks and projects, including hidden completed ones", () => {
    const graph: GraphData = {
      nodes: [
        node("b", "big_task"), node("s1", "task", "completed"), node("s2", "task"), node("n", "note"),
        node("p", "project"), node("p1", "big_task"), node("x", "task", "archived"),
      ],
      edges: [child("s1", "b"), child("s2", "b"), child("n", "b"), child("p1", "p"), child("x", "p")],
    };
    const progress = computeWorkProgress(graph);
    expect(progress.get("b")).toEqual({ done: 1, total: 2 });
    expect(progress.get("p")).toEqual({ done: 0, total: 1 });
  });

  it("ignores goals, non-hierarchy edges and parents without work", () => {
    const graph: GraphData = {
      nodes: [node("g", "goal"), node("t", "task"), node("b", "big_task"), node("r", "task")],
      edges: [child("t", "g"), child("r", "b", "related_to")],
    };
    expect(computeWorkProgress(graph).size).toBe(0);
  });
});
