import { describe, expect, it } from "vitest";

import { hasOpenSteps, planTaskCompletesNode } from "./sessions";

describe("planTaskCompletesNode — ticking a planner entry", () => {
  it("a time block on a class, goal or project marks the session done, never the node", () => {
    for (const type of ["class", "goal", "project"]) {
      expect(planTaskCompletesNode(type, true)).toBe(false);
      expect(planTaskCompletesNode(type, false)).toBe(false);
    }
  });

  it("a big task with steps is a session; one with no steps is finished in one sitting", () => {
    expect(planTaskCompletesNode("big_task", true)).toBe(false);
    expect(planTaskCompletesNode("big_task", false)).toBe(true);
  });

  it("a task or a habit completes as before", () => {
    expect(planTaskCompletesNode("task", false)).toBe(true);
    expect(planTaskCompletesNode("habit", false)).toBe(true);
    expect(planTaskCompletesNode(null, false)).toBe(true);
  });
});

describe("hasOpenSteps", () => {
  const graph = {
    nodes: [
      { id: "it", status: "active" },
      { id: "a", status: "active" },
      { id: "b", status: "completed" },
      { id: "solo", status: "active" },
      { id: "done-only", status: "active" },
    ],
    edges: [
      { source_node_id: "a", target_node_id: "it", edge_type: "belongs_to", status: "active" },
      { source_node_id: "b", target_node_id: "done-only", edge_type: "belongs_to", status: "active" },
      { source_node_id: "a", target_node_id: "solo", edge_type: "related_to", status: "active" },
    ],
  };

  it("counts only open children under belongs_to", () => {
    expect(hasOpenSteps("it", graph)).toBe(true);
    expect(hasOpenSteps("done-only", graph)).toBe(false);
    expect(hasOpenSteps("solo", graph)).toBe(false);
  });
});
