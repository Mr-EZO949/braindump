import { describe, expect, it } from "vitest";

import { pickExistingParentForNode } from "./anchor-attachment";

describe("pickExistingParentForNode", () => {
  const existingNodes = [
    { id: "italian", title: "Italian Crash Course", summary: null, node_type: "big_task" as const },
    { id: "uni", title: "University Courses", summary: null, node_type: "area" as const },
  ];

  it("never guesses a parent that can't hold the child", () => {
    // "course" in a big task's title used to win a new class.
    const onlyBigTask = pickExistingParentForNode({
      child: { title: "Statistics Midterm", summary: null, node_type: "class" },
      existingNodes: existingNodes.slice(0, 1),
    });
    expect(onlyBigTask).toBeNull();
  });

  it("still attaches to a fitting container", () => {
    expect(
      pickExistingParentForNode({
        child: { title: "Statistics Midterm", summary: null, node_type: "class" },
        existingNodes,
      }),
    ).toBe("uni");
  });
});
