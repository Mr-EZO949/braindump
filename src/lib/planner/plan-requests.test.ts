import { describe, expect, it } from "vitest";

import { matchRequest, parsePlanRequests } from "./plan-requests";

describe("parsePlanRequests", () => {
  it("reads lengths and what they're for", () => {
    expect(parsePlanRequests("plan 3h of Italian, 2h of math")).toEqual([
      { text: "plan 3h of Italian", phrase: "italian", minutes: 180 },
      { text: "2h of math", phrase: "math", minutes: 120 },
    ]);
  });

  it("understands the usual ways to say a length", () => {
    const minutes = (text: string) => parsePlanRequests(text)[0]?.minutes;
    expect(minutes("1h30 statistics")).toBe(90);
    expect(minutes("1.5 hours of statistics")).toBe(90);
    expect(minutes("1 hour 15 min of statistics")).toBe(75);
    expect(minutes("90 min statistics")).toBe(90);
    expect(minutes("an hour on the CV")).toBe(60);
    expect(minutes("two hours of English")).toBe(120);
    expect(minutes("half an hour of Italian")).toBe(30);
    expect(minutes("some Italian")).toBeNull();
  });

  it("splits on 'and' only before a length, so titles with 'and' stay whole", () => {
    expect(parsePlanRequests("3h of Italian and 2h of math").map((r) => r.phrase)).toEqual(["italian", "math"]);
    expect(parsePlanRequests("1h of numbers and telling time").map((r) => r.phrase)).toEqual([
      "numbers and telling",
    ]);
  });

  it("nothing to read → nothing asked", () => {
    expect(parsePlanRequests("")).toEqual([]);
    expect(parsePlanRequests(undefined)).toEqual([]);
    expect(parsePlanRequests("2h")).toEqual([]);
  });
});

describe("matchRequest", () => {
  const nodes = [
    { id: "it", title: "Italian Crash Course", node_type: "big_task" },
    { id: "greet", title: "Learn greetings and introductions", node_type: "task" },
    { id: "stats", title: "Statistics", node_type: "class" },
    { id: "mid", title: "Pass Statistics Midterm", node_type: "goal" },
    { id: "cv", title: "Update CV", node_type: "task" },
  ];
  const match = (phrase: string) => matchRequest(phrase, nodes)?.id ?? null;

  it("matches by the words of the title, short forms included", () => {
    expect(match("italian")).toBe("it");
    expect(match("stats")).toBe("stats");
    expect(match("stats midterm")).toBe("mid");
    expect(match("cv")).toBe("cv");
  });

  it("leaves a phrase that names nothing to the plan model", () => {
    expect(match("math")).toBeNull();
    expect(match("english")).toBeNull();
  });
});
