import { describe, expect, it } from "vitest";

import { adviceRows, messageClauses } from "./advice-guard";

const PM_CASE = "did the gym this morning. also the CV update can wait till next week, should I focus on stats or the internship today?";

describe("messageClauses", () => {
  it("splits a ', should I…' question off the statement before it", () => {
    expect(messageClauses(PM_CASE)).toEqual([
      { text: "did the gym this morning.", asks: false },
      { text: "also the CV update can wait till next week", asks: false },
      { text: "should I focus on stats or the internship today?", asks: true },
    ]);
  });
});

describe("adviceRows (owner: advice stays advice)", () => {
  it("the PM's case: the CV can-wait is the user's, the stats focus is advice", () => {
    const rows = [
      { action: "deprioritize", title: "Update CV" },
      { action: "focus", title: "Pass Statistics Midterm" },
    ];
    expect(adviceRows(PM_CASE, rows)).toEqual([1]);
  });

  it("a fact next to a question stays the user's; the answer's priority waits", () => {
    const message = "did the gym today and finished updating my CV — should I focus on the stats midterm or the internship applications this week?";
    expect(adviceRows(message, [{ action: "complete" }, { action: "complete" }, { action: "focus" }])).toEqual([2]);
  });

  it("what the user stated stays theirs even when they also ask", () => {
    expect(adviceRows("focus on stats this week — should I drop the internship?", [{ action: "focus" }, { action: "drop" }])).toEqual([1]);
    expect(adviceRows("the CV can wait. what should I do first?", [{ action: "deprioritize" }])).toEqual([]);
  });

  it("a message that asks nothing is left to the model", () => {
    expect(adviceRows("focus on stats, reselling can wait", [{ action: "focus" }, { action: "deprioritize" }])).toEqual([]);
    expect(adviceRows("I need the ML exam for my masters", [{ action: "stakes" }])).toEqual([]);
  });

  it("facts are never advice", () => {
    expect(adviceRows("took the exam, waiting on results — what now?", [{ action: "wait" }, { action: "deadline" }])).toEqual([]);
  });
});
