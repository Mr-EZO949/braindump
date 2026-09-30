import { describe, expect, it } from "vitest";
import { lexicalScores, segmentDump, selectContextNodes, type RetrievalNode } from "./retrieval";

const node = (
  id: string,
  title: string,
  node_type: RetrievalNode["node_type"],
  importance = 50,
): RetrievalNode => ({
  id,
  title,
  summary: null,
  node_type,
  current_importance_score: importance,
  importance_index: importance,
});

describe("segmentDump", () => {
  it("keeps a short dump whole", () => {
    expect(segmentDump("finish chapter 1 tonight")).toEqual(["finish chapter 1 tonight"]);
  });

  it("splits a long multi-topic dump into at most 6 non-empty segments", () => {
    const topics = Array.from(
      { length: 20 },
      (_, i) => `Topic ${i}: I need to handle this specific thing about area number ${i} soon.`,
    );
    const segments = segmentDump(topics.join(" "));
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThanOrEqual(6);
    expect(segments.every((s) => s.trim().length > 0)).toBe(true);
    // Nothing is lost.
    expect(segments.join(" ")).toContain("area number 19");
  });
});

describe("lexicalScores", () => {
  it("scores titles that share real words with the dump, ignoring generic ones", () => {
    const scores = lexicalScores("tested braindump and found 10 bugs", [
      { id: "a", title: "Test BrainDump" },
      { id: "b", title: "New Project" },
      { id: "c", title: "Learn Rust" },
    ]);
    expect(scores.get("a")).toBeGreaterThan(0);
    expect(scores.has("b")).toBe(false); // "new", "project" are too generic
    expect(scores.has("c")).toBe(false);
  });
});

describe("selectContextNodes", () => {
  // 20 high-importance Objectives + one LOW-importance task the dump is about.
  const objectives = Array.from({ length: 20 }, (_, i) =>
    node(`obj-${i}`, `Important Objective ${i}`, "project", 90),
  );
  const buried = node("buried", "Clothes Reselling", "project", 5);
  const child = node("child", "Photograph the jackets", "task", 5);
  const nodes = [...objectives, buried, child];
  const parentOf = new Map([["child", "buried"]]);

  it("surfaces a low-importance node the dump is ABOUT (the old top-14 missed it → duplicates)", () => {
    const selected = selectContextNodes({
      nodes,
      parentOf,
      semantic: new Map([["child", 0.82]]),
      lexical: new Map(),
      rootNodeId: null,
    });
    const ids = selected.map((n) => n.id);
    expect(ids).toContain("child");
    // …and brings its parent, labelled, so new items can attach at the right level.
    expect(ids).toContain("buried");
    expect(selected.find((n) => n.id === "child")?.parent_title).toBe("Clothes Reselling");
  });

  it("shows what sits inside the top hits when a restructure needs it", () => {
    const steps = [node("s1", "Fix the login bug", "task", 5), node("s2", "Write test cases", "task", 5)];
    const params = {
      nodes: [...nodes, ...steps],
      parentOf: new Map([...parentOf, ["s1", "buried"], ["s2", "buried"]]),
      semantic: new Map([["buried", 0.9]]),
      lexical: new Map(),
      rootNodeId: null,
    };
    const plain = selectContextNodes(params).map((n) => n.id);
    expect(plain).not.toContain("s1");
    const expanded = selectContextNodes({ ...params, expandChildren: true });
    expect(expanded.map((n) => n.id)).toEqual(expect.arrayContaining(["buried", "child", "s1", "s2"]));
    expect(expanded.find((n) => n.id === "s1")?.parent_title).toBe("Clothes Reselling");
  });

  it("puts the root first and respects the budget", () => {
    const selected = selectContextNodes({
      nodes,
      parentOf,
      semantic: new Map([["child", 0.82]]),
      lexical: new Map(),
      rootNodeId: "obj-0",
      budget: 5,
    });
    expect(selected[0].id).toBe("obj-0");
    expect(selected.length).toBe(5);
  });

  it("still gives a skeleton of top Objectives when nothing matches", () => {
    const selected = selectContextNodes({
      nodes,
      parentOf,
      semantic: new Map(),
      lexical: new Map(),
      rootNodeId: null,
      budget: 8,
    });
    expect(selected.length).toBe(8);
    expect(selected.every((n) => n.node_type === "project")).toBe(true);
  });
});
