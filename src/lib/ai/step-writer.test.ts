import { describe, expect, it } from "vitest";

import { stepsToOps } from "./step-writer";
import { buildStepsUserMessage } from "./prompts/steps";

const roadmap = JSON.stringify({
  phases: [
    {
      title: "Pick the dataset",
      summary: "Settle what the project runs on.",
      steps: [
        { title: "Shortlist 3 Kaggle datasets", summary: "Ones with a clear target column." },
        { title: "Email the TA your pick", summary: "Get it approved before Friday." },
      ],
    },
    { title: "Empty phase", summary: "", steps: [] },
    {
      title: "Write the proposal",
      summary: "One page.",
      steps: [{ title: "Draft the problem statement", summary: "Two paragraphs." }],
    },
  ],
  steps: [],
});

describe("stepsToOps", () => {
  it("turns a roadmap into phases (big tasks) with their steps under the item", () => {
    const ops = stepsToOps(roadmap, { shape: "roadmap", parent: { node_id: "ml" }, existingTitles: [] });
    expect(ops.map((op) => (op.kind === "create_node" ? [op.node_type, op.title] : op.kind))).toEqual([
      ["big_task", "Pick the dataset"],
      ["task", "Shortlist 3 Kaggle datasets"],
      ["task", "Email the TA your pick"],
      ["big_task", "Write the proposal"],
      ["task", "Draft the problem statement"],
    ]);
    const [phase, step] = ops as Array<Extract<(typeof ops)[number], { kind: "create_node" }>>;
    expect(phase.parent_node_id).toBe("ml");
    expect(step.parent_local_ref).toBe(phase.local_ref);
    expect(new Set(ops.map((op) => (op.kind === "create_node" ? op.local_ref : ""))).size).toBe(ops.length);
  });

  it("drops steps already under the item, and a phase left empty by that", () => {
    const ops = stepsToOps(roadmap, {
      shape: "roadmap",
      parent: { node_id: "ml" },
      existingTitles: ["Draft the problem statement", "email the TA your pick!"],
    });
    expect(ops.map((op) => (op.kind === "create_node" ? op.title : ""))).toEqual([
      "Pick the dataset",
      "Shortlist 3 Kaggle datasets",
    ]);
  });

  it("keeps 'next' flat and to three steps, under a new item's local_ref", () => {
    const text = JSON.stringify({
      phases: [{ title: "Ignored", summary: "", steps: [{ title: "x", summary: "" }] }],
      steps: ["Open the doc", "Write the title", "List 3 sources", "Too many"].map((title) => ({ title, summary: "" })),
    });
    const ops = stepsToOps(text, { shape: "next", parent: { local_ref: "item" }, existingTitles: [], refPrefix: "s1_" });
    expect(ops).toHaveLength(3);
    for (const op of ops) {
      expect(op).toMatchObject({ kind: "create_node", node_type: "task", parent_local_ref: "item" });
      expect(op.kind === "create_node" && op.local_ref?.startsWith("s1_")).toBe(true);
    }
  });

  it("falls back to the flat list when a roadmap came back without phases, and is empty on junk", () => {
    const flat = JSON.stringify({ phases: [], steps: [{ title: "Solve 5 problems from ch. 2", summary: "" }] });
    expect(stepsToOps(flat, { shape: "roadmap", parent: { node_id: "x" }, existingTitles: [] })).toHaveLength(1);
    expect(stepsToOps("not json", { shape: "steps", parent: { node_id: "x" }, existingTitles: [] })).toEqual([]);
  });
});

describe("buildStepsUserMessage", () => {
  it("gives the item, its parent, what's under it and the user's words — nothing else", () => {
    const text = buildStepsUserMessage({
      today: "2026-10-03",
      shape: "steps",
      item: { title: "ML course project", typeLabel: "big task", description: "Groups of 2.", targetDate: "2026-10-20", isNew: false },
      parent: { title: "Machine Learning", typeLabel: "class" },
      children: [{ title: "Pick a dataset", done: true }],
      words: "break the ML project into steps",
    });
    expect(text).toContain('Item: big task "ML course project" (due 2026-10-20)');
    expect(text).toContain('Under: class "Machine Learning"');
    expect(text).toContain("- [done] Pick a dataset");
    expect(text).toContain("What the user said: break the ML project into steps");
  });
});
