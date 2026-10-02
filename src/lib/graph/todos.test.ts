import { describe, expect, it } from "vitest";

import type { Edge, GraphData, Node } from "@/types/graph";

import { buildTodos, dueLabel } from "./todos";

const TODAY = "2026-10-02"; // a Friday

const node = (id: string, node_type: Node["node_type"], extra: Partial<Node> = {}) =>
  ({ id, node_type, status: "active", title: id, current_importance_score: 50, ...extra }) as Node;
const child = (source: string, target: string) =>
  ({ id: `${source}-${target}`, source_node_id: source, target_node_id: target, edge_type: "belongs_to" }) as Edge;

// Two projects under an area; a big task with steps; one loose task.
const graph: GraphData = {
  nodes: [
    node("life", "area"),
    node("snap", "project", { target_date: "2026-10-15" }),
    node("uni", "goal"),
    node("scripts", "big_task", { current_importance_score: 72 }),
    node("draft", "task", { current_importance_score: 40 }),
    node("record", "task", { current_importance_score: 45, target_date: "2026-10-03" }),
    node("deploy", "task", { current_importance_score: 60 }),
    node("thesis", "big_task", { current_importance_score: 80, target_date: "2026-09-30" }),
    node("loose", "task", { current_importance_score: 10 }),
    node("old", "task", { status: "completed", completed_at: "2026-10-01T09:00:00Z" }),
    node("older", "task", { status: "completed", completed_at: "2026-09-20T09:00:00Z" }),
    node("wait", "task", { status: "paused", resume_on: "2026-10-06" }),
    node("gone", "task", { status: "archived" }),
    node("habit", "habit"),
  ],
  edges: [
    child("snap", "life"), child("uni", "life"),
    child("scripts", "snap"), child("draft", "scripts"), child("record", "scripts"),
    child("deploy", "snap"), child("thesis", "uni"),
    child("old", "snap"), child("older", "snap"), child("wait", "snap"), child("gone", "snap"),
    child("habit", "life"),
  ],
};

const ids = (items: { node: Node }[]) => items.map((i) => i.node.id);

describe("buildTodos — project grouping", () => {
  const model = buildTodos(graph, { grouping: "project", today: TODAY });

  it("sections open work by parent, the most pressing section first, loose work last", () => {
    expect(model.sections.map((s) => s.key)).toEqual(["parent:uni", "parent:snap", "none"]);
    expect(model.sections[1].title).toBe("snap");
    expect(model.sections[2].title).toBe("No project");
  });

  it("nests a big task's open steps under it, ranked, and counts them", () => {
    const snap = model.sections[1];
    expect(ids(snap.items)).toEqual(["scripts", "deploy"]);
    expect(ids(snap.items[0].steps)).toEqual(["record", "draft"]);
    expect(snap.count).toBe(4);
  });

  it("keeps habits and archived work out; paused and done go to their own lists", () => {
    const all = model.sections.flatMap((s) => s.items.flatMap((i) => [i.node.id, ...ids(i.steps)]));
    expect(all).not.toContain("habit");
    expect(all).not.toContain("gone");
    expect(ids(model.paused)).toEqual(["wait"]);
    expect(ids(model.done)).toEqual(["old", "older"]);
    expect(model.openCount).toBe(6);
    expect(model.doneCount).toBe(2);
  });

  it("keeps a just-checked task in place until it settles", () => {
    const checked: GraphData = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === "deploy" ? { ...n, status: "completed" as const } : n)),
    };
    const settling = buildTodos(checked, { grouping: "project", today: TODAY, settling: new Set(["deploy"]) });
    expect(ids(settling.sections[1].items)).toContain("deploy");
    expect(ids(settling.done)).not.toContain("deploy");
    const settled = buildTodos(checked, { grouping: "project", today: TODAY });
    expect(ids(settled.sections[1].items)).not.toContain("deploy");
    expect(ids(settled.done)).toContain("deploy");
  });
});

describe("buildTodos — priority and due groupings", () => {
  it("priority is one flat ranked list with steps un-nested", () => {
    const model = buildTodos(graph, { grouping: "priority", today: TODAY });
    expect(model.sections).toHaveLength(1);
    expect(ids(model.sections[0].items)).toEqual(["thesis", "scripts", "deploy", "record", "draft", "loose"]);
  });

  it("due buckets by the task's date, or its nearest dated parent's", () => {
    const model = buildTodos(graph, { grouping: "due", today: TODAY });
    expect(model.sections.map((s) => s.title)).toEqual(["Overdue", "Tomorrow", "Later", "No date"]);
    expect(model.sections[0].tone).toBe("overdue");
    expect(ids(model.sections[1].items)).toEqual(["record"]);
    const later = model.sections[2];
    expect(ids(later.items)).toEqual(["scripts", "deploy", "draft"]);
    expect(later.items[0].due).toEqual({ date: "2026-10-15", from: expect.objectContaining({ id: "snap" }) });
    expect(ids(model.sections[3].items)).toEqual(["loose"]);
  });
});

describe("buildTodos — search", () => {
  it("returns one flat list of matches, done ones included", () => {
    const model = buildTodos(graph, { grouping: "project", today: TODAY, search: "OLD" });
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].title).toBe("2 matches");
    expect(ids(model.sections[0].items)).toEqual(["old", "older"]);
    expect(model.done).toEqual([]);
  });
});

describe("dueLabel", () => {
  it("speaks relative to today", () => {
    expect(dueLabel("2026-10-01", TODAY)).toEqual({ text: "Yesterday", tone: "overdue" });
    expect(dueLabel("2026-09-20", TODAY)).toEqual({ text: "Sep 20", tone: "overdue" });
    expect(dueLabel(TODAY, TODAY)).toEqual({ text: "Today", tone: "today" });
    expect(dueLabel("2026-10-03", TODAY)).toEqual({ text: "Tomorrow", tone: "soon" });
    expect(dueLabel("2026-10-06", TODAY)).toEqual({ text: "Tue", tone: "soon" });
    expect(dueLabel("2026-10-15", TODAY)).toEqual({ text: "Oct 15", tone: "later" });
    expect(dueLabel("2027-01-05", TODAY)).toEqual({ text: "Jan 5, 2027", tone: "later" });
  });
});
