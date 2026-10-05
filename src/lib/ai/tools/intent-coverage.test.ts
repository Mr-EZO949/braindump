import { describe, expect, it } from "vitest";

import { MULTI_INTENT_CASES } from "@/lib/ai/eval/chat-intents";
import { callCoverage, coverageNudge, mergeRetryCalls, missingIntents, statedIntents, statedOpSource } from "./intent-coverage";

const PM_CASE = "Did the gym. Also the CV update can wait till next week, should I focus on stats or the internship?";
const kinds = (message: string) => statedIntents(message).map((s) => s.kind);

describe("statedIntents", () => {
  it("the PM's case: done + can wait are stated; the focus is only asked", () => {
    expect(statedIntents(PM_CASE)).toEqual([
      { kind: "complete", clause: "Did the gym." },
      { kind: "deprioritize", clause: "Also the CV update can wait till next week" },
    ]);
  });

  it("finds each kind of statement", () => {
    expect(kinds("finally updated my CV!")).toEqual(["complete"]);
    expect(kinds("went to the gym this morning, now plan my afternoon")).toEqual(["complete", "plan"]);
    expect(kinds("the stats midterm is on oct 20")).toEqual(["deadline"]);
    expect(kinds("The internship deadline moved to november 15.")).toEqual(["deadline"]);
    expect(kinds("Took the stats midterm today, now waiting on results.")).toEqual(["wait"]);
    expect(kinds("I have statistics lectures every Tue and Thu 2-4pm.")).toEqual(["commitment"]);
    expect(kinds("I really need the stats midterm for my scholarship, so I'm focusing on it this week.")).toEqual(["focus", "stakes"]);
    expect(kinds("Add a task to email the stats TA, and move Italian Crash Course under Personal Development.")).toEqual(["add", "move"]);
    expect(kinds("Rename Clothes Reselling to Vintage Reselling")).toEqual(["rename"]);
    expect(kinds("I'm not doing the Italian course anymore")).toEqual(["drop"]);
    expect(kinds("X and Y aren't related, remove that link")).toEqual(["link"]);
  });

  it("questions are not statements — advice stays advice", () => {
    expect(kinds("should I focus on stats or the internship?")).toEqual([]);
    expect(kinds("should I drop clothes reselling?")).toEqual([]);
    expect(kinds("what should I do first today?")).toEqual([]);
    expect(kinds("did I do the gym yesterday?")).toEqual([]);
  });

  it("a request phrased as a question still counts", () => {
    expect(kinds("can you add a task to call mom?")).toEqual(["add"]);
  });

  it("intentions, venting and plain talk aren't statements of change", () => {
    expect(kinds("I should finish the CV")).toEqual([]);
    expect(kinds("I didn't do the gym today")).toEqual([]);
    expect(kinds("ugh, stats is killing me")).toEqual([]);
    expect(kinds("I can't focus on anything today")).toEqual([]);
    expect(kinds("I'm planning to go to the gym later")).toEqual([]);
    expect(kinds("break Italian into steps")).toEqual([]);
  });
});

describe("missingIntents", () => {
  const gym = { name: "change", input: { source: "user", changes: [{ kind: "complete", node_id: "gym" }] } };
  const cv = { name: "update_priorities", input: { source: "user", changes: [{ node_id: "cv", title: "Update CV", action: "deprioritize" }] } };

  it("the reproduced #22 drop: only the gym was called → the can-wait is missing", () => {
    expect(missingIntents(PM_CASE, [gym])).toEqual([{ kind: "deprioritize", clause: "Also the CV update can wait till next week" }]);
  });

  it("the full set covers it; the advice row doesn't need to be there", () => {
    expect(missingIntents(PM_CASE, [gym, cv])).toEqual([]);
  });

  it("a reply with no call at all misses everything stated", () => {
    expect(missingIntents(PM_CASE, []).map((m) => m.kind)).toEqual(["complete", "deprioritize"]);
  });

  it("stakes stated next to focus needs its own row", () => {
    const message = "I really need the stats midterm for my scholarship, so I'm focusing on it this week. should I drop clothes reselling?";
    const focusOnly = { name: "update_priorities", input: { source: "user", changes: [{ node_id: "m", action: "focus" }] } };
    expect(missingIntents(message, [focusOnly]).map((m) => m.kind)).toEqual(["stakes"]);
  });

  it("an op called as a tool, a planned tool, ask_choice and build_graph count", () => {
    expect(missingIntents("went to the gym this morning, now plan my afternoon", [
      { name: "complete", input: { node_id: "gym" } },
      { name: "plan_day", input: { window: "day" } },
    ])).toEqual([]);
    expect(missingIntents(PM_CASE, [{ name: "ask_choice", input: {} }])).toEqual([]);
    expect(missingIntents("add A and B, and move C under D", [{ name: "build_graph", input: {} }])).toEqual([]);
  });

  it("two stated clauses of a kind need two rows", () => {
    const message = "The CV can wait. Reselling can wait too.";
    expect(missingIntents(message, [cv]).length).toBe(2);
  });

  it("every eval case's stated kinds are found (the live set stays checkable)", () => {
    for (const c of MULTI_INTENT_CASES) expect(statedIntents(c.message).length, c.id).toBeGreaterThan(0);
  });
});

describe("callCoverage", () => {
  it("counts change ops, priority actions, dates and tool names", () => {
    const counts = callCoverage([
      { name: "change", input: { changes: [{ kind: "create_node", title: "A", target_date: "2026-10-20" }, { kind: "move", node_id: "x" }] } },
      { name: "update_priorities", input: { changes: [{ action: "wait" }, { action: "deadline" }] } },
      { name: "plan_day", input: {} },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ create_node: 1, deadline: 2, move: 1, wait: 1, plan_day: 1 });
  });
});

describe("coverageNudge", () => {
  it("names each missing clause with the call it needs, and says it isn't the user", () => {
    const text = coverageNudge(missingIntents(PM_CASE, []), false);
    expect(text).toContain("not from the user");
    expect(text).toContain('"Did the gym." (done → change complete)');
    expect(text).toContain("update_priorities deprioritize");
    expect(text).toContain("no call");
  });
});

describe("mergeRetryCalls", () => {
  const block = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

  it("appends a new call", () => {
    const first = [block("a", "change", { source: "user", changes: [{ kind: "complete", node_id: "gym" }] })];
    const retry = [block("b", "update_priorities", { source: "user", changes: [{ node_id: "cv", action: "deprioritize" }] })];
    expect(mergeRetryCalls(first, retry).map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("folds new rows into the same-source call and drops repeats", () => {
    const first = [block("a", "update_priorities", { source: "user", changes: [{ node_id: "m", action: "focus" }] })];
    const retry = [block("b", "update_priorities", { source: "user", changes: [{ node_id: "m", action: "focus" }, { node_id: "m", action: "stakes", level: "high" }] })];
    const merged = mergeRetryCalls(first, retry);
    expect(merged).toHaveLength(1);
    expect((merged[0].input as { changes: unknown[] }).changes).toEqual([
      { node_id: "m", action: "focus" },
      { node_id: "m", action: "stakes", level: "high" },
    ]);
    // The first response's input isn't mutated.
    expect((first[0].input as { changes: unknown[] }).changes).toHaveLength(1);
  });

  it("drops a retry row the first response already made with the other tool", () => {
    const first = [block("a", "change", { source: "user", changes: [{ kind: "complete", node_id: "gym" }] })];
    const retry = [block("b", "update_priorities", { source: "user", changes: [{ node_id: "cv", action: "deprioritize" }, { node_id: "gym", title: "Go to the gym", action: "complete" }] })];
    const merged = mergeRetryCalls(first, retry);
    expect((merged[1].input as { changes: unknown[] }).changes).toEqual([{ node_id: "cv", action: "deprioritize" }]);
  });

  it("keeps a different source as its own call, and drops an identical repeat call", () => {
    const first = [block("a", "update_priorities", { source: "user", changes: [{ node_id: "cv", action: "deprioritize" }] }), block("p", "plan_day", { window: "day" })];
    const retry = [block("b", "update_priorities", { source: "suggestion", changes: [{ node_id: "s", action: "focus" }] }), block("q", "plan_day", { window: "day" })];
    expect(mergeRetryCalls(first, retry).map((b) => b.id)).toEqual(["a", "p", "b"]);
  });
});

describe("statedOpSource", () => {
  it("an op the message states is the user's; one it doesn't is a suggestion", () => {
    expect(statedOpSource("went to the gym this morning, now plan my afternoon", "complete")).toBe("user");
    expect(statedOpSource("what should I do next?", "complete")).toBe("suggestion");
    expect(statedOpSource(undefined, "complete")).toBe("suggestion");
  });
});

describe("coverage holes found in the live eval", () => {
  it("a calendar item doesn't stand in for the date the user gave", () => {
    const message = "ugh I'm so behind on everything. the stats midterm is on oct 20, and I need to book a room for the study group";
    const calendar = { name: "add_task_to_calendar", input: { title: "Book room", scheduled_date: "2026-10-05" } };
    expect(missingIntents(message, [calendar]).map((m) => m.kind)).toEqual(["deadline"]);
  });

  it("an archive doesn't stand in for a can-wait", () => {
    const message = "The BrainDump fixes can wait. Is getting the internship by November realistic?";
    const archive = { name: "change", input: { source: "user", changes: [{ kind: "archive", node_id: "f" }] } };
    expect(missingIntents(message, [archive]).map((m) => m.kind)).toEqual(["deprioritize"]);
  });
});

describe("core cases cost no extra round when the model gets them right", () => {
  const call = (name: string, input: unknown = {}) => ({ name, input });
  const change = (...kinds: string[]) => call("change", { source: "user", changes: kinds.map((kind) => ({ kind, node_id: "n" })) });
  it.each([
    ["add a task to email the TA under Statistics", [change("create_node")]],
    ["I finished the CV", [change("complete")]],
    ["did the gym", [change("complete")]],
    ["move Italian under Personal Development", [change("move")]],
    ["Italian and the gym aren't related, remove that link", [change("remove_edge")]],
    ["the CV can wait till next week", [call("update_priorities", { changes: [{ action: "deprioritize" }] })]],
    ["should I focus on stats or the internship?", []],
    ["did the gym, what should I do next?", [change("complete")]],
    ["plan my day", [call("plan_day")]],
    ["plan my day, I want 3h on Italian", [call("plan_day")]],
    ["break the thesis into steps", [call("write_steps")]],
    ["stats every Tue 2pm", [call("set_commitments")]],
    ["ugh, stats is killing me", []],
  ] as const)("%j", (message, calls) => {
    expect(missingIntents(message, [...calls])).toEqual([]);
  });
});
