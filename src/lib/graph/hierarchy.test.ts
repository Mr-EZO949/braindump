import { describe, expect, it } from "vitest";

import { wouldCreateCycle } from "./hierarchy";

// child → parent
const tree = new Map<string, string>([
  ["money", "root"],
  ["braindump", "money"],
  ["test", "braindump"],
  ["bugs", "test"],
  ["health", "root"],
]);

describe("wouldCreateCycle", () => {
  it("allows a move to an unrelated branch or further up", () => {
    expect(wouldCreateCycle(tree, "test", "health")).toBe(false);
    expect(wouldCreateCycle(tree, "bugs", "money")).toBe(false);
    expect(wouldCreateCycle(tree, "orphan", "root")).toBe(false);
  });

  it("refuses putting a node under itself or under its own descendant", () => {
    expect(wouldCreateCycle(tree, "test", "test")).toBe(true);
    // The 2026-09-30 screenshot: project "BrainDump" ended up under its own step.
    expect(wouldCreateCycle(tree, "braindump", "test")).toBe(true);
    expect(wouldCreateCycle(tree, "money", "bugs")).toBe(true);
  });

  it("terminates on data that already contains a loop", () => {
    const looped = new Map<string, string>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(wouldCreateCycle(looped, "c", "a")).toBe(false);
    expect(wouldCreateCycle(looped, "a", "b")).toBe(true);
  });
});
