import { describe, it, expect } from "vitest";

import { needsNextAction } from "./next-action";
import type { Edge, Node, NodeStatus, NodeType } from "@/types/graph";

function node(
  id: string,
  node_type: NodeType,
  status: NodeStatus = "active",
): Node {
  return { id, node_type, status, title: id } as Node;
}

function belongsTo(child: string, parent: string): Edge {
  return edge(child, parent, "belongs_to");
}

function edge(source: string, target: string, type: Edge["edge_type"]): Edge {
  return {
    id: `${source}-${type}-${target}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: type,
  } as unknown as Edge;
}

describe("needsNextAction", () => {
  it("is true for a childless project", () => {
    expect(needsNextAction("p", [node("p", "project")], [])).toBe(true);
  });

  it("is true for a childless class and goal", () => {
    expect(needsNextAction("c", [node("c", "class")], [])).toBe(true);
    expect(needsNextAction("g", [node("g", "goal")], [])).toBe(true);
  });

  it("is false for a non-container (a plain task)", () => {
    expect(needsNextAction("t", [node("t", "task")], [])).toBe(false);
  });

  it("is false when an active task child exists (belongs_to)", () => {
    const nodes = [node("p", "project"), node("t", "task")];
    expect(needsNextAction("p", nodes, [belongsTo("t", "p")])).toBe(false);
  });

  it("is false when an active sub-project child exists", () => {
    const nodes = [node("p", "project"), node("sp", "project")];
    expect(needsNextAction("p", nodes, [belongsTo("sp", "p")])).toBe(false);
  });

  it("is true when the only child is completed", () => {
    const nodes = [node("p", "project"), node("t", "task", "completed")];
    expect(needsNextAction("p", nodes, [belongsTo("t", "p")])).toBe(true);
  });

  it("is true when the only child is archived", () => {
    const nodes = [node("p", "project"), node("t", "task", "archived")];
    expect(needsNextAction("p", nodes, [belongsTo("t", "p")])).toBe(true);
  });

  it("is false when the only child is paused (parked work is not a dead-end)", () => {
    // A paused child counts as live on purpose — the user parked it; don't nag.
    const nodes = [node("p", "project"), node("t", "task", "paused")];
    expect(needsNextAction("p", nodes, [belongsTo("t", "p")])).toBe(false);
  });

  it("treats a child with no status as active (suggests nothing)", () => {
    const nodes = [node("p", "project"), { id: "t", node_type: "task" } as Node];
    expect(needsNextAction("p", nodes, [belongsTo("t", "p")])).toBe(false);
  });

  it("ignores non-workable children (a note doesn't count as a next step)", () => {
    const nodes = [node("p", "project"), node("note", "note")];
    expect(needsNextAction("p", nodes, [belongsTo("note", "p")])).toBe(true);
  });

  it("flags a big task with no steps (Focus offers to break it down)", () => {
    expect(needsNextAction("b", [node("b", "big_task")], [])).toBe(true);
    const nodes = [node("b", "big_task"), node("t", "task")];
    expect(needsNextAction("b", nodes, [belongsTo("t", "b")])).toBe(false);
  });

  it("is false for a completed container (nothing to suggest)", () => {
    expect(needsNextAction("p", [node("p", "project", "completed")], [])).toBe(
      false,
    );
  });

  it("does not treat a child of a DIFFERENT parent as its own", () => {
    const nodes = [node("p", "project"), node("other", "project"), node("t", "task")];
    // task belongs to `other`, not `p`
    expect(needsNextAction("p", nodes, [belongsTo("t", "other")])).toBe(true);
  });

  // Guards the edge_type filter — every other test uses belongs_to, so without
  // this a non-parentage edge (depends_on/blocks) could leak in as a "child"
  // and silently suppress the dead-end offer.
  it("does not count a non-belongs_to edge as a child", () => {
    const nodes = [node("p", "project"), node("t", "task")];
    expect(needsNextAction("p", nodes, [edge("t", "p", "depends_on")])).toBe(true);
  });

  it("survives a stale edge to a deleted child (orphan id, no throw)", () => {
    expect(needsNextAction("p", [node("p", "project")], [belongsTo("ghost", "p")])).toBe(true);
  });

  it("counts an active goal child as a real next step", () => {
    const nodes = [node("p", "project"), node("subg", "goal")];
    expect(needsNextAction("p", nodes, [belongsTo("subg", "p")])).toBe(false);
  });

  it("is false for an archived container", () => {
    expect(needsNextAction("p", [node("p", "project", "archived")], [])).toBe(false);
  });

  it("is false for a node id that isn't in the graph", () => {
    expect(needsNextAction("does-not-exist", [node("p", "project")], [])).toBe(false);
  });
});
