import { describe, expect, it } from "vitest";

import { matchRequest, matchRequestAll, parsePlanRequests, pinFromMessage, titleCoversRequest } from "./plan-requests";

describe("parsePlanRequests", () => {
  it("reads lengths and what they're for", () => {
    expect(parsePlanRequests("plan 3h of Italian, 2h of math")).toEqual([
      { text: "plan 3h of Italian", phrase: "italian", minutes: 180, label: "Italian", start: null, end: null, parts: [] },
      { text: "2h of math", phrase: "math", minutes: 120, label: "Math", start: null, end: null, parts: [] },
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

  it("owner 10-06: a clock time makes it fixed time; the label is their words", () => {
    const [meal, electives, cv] = parsePlanRequests(
      "1.5h mealprep right now from like 12:30, look into the electives, update CV",
    );
    expect(meal).toMatchObject({ label: "Mealprep", start: 12 * 60 + 30, end: 14 * 60, minutes: 90 });
    expect(electives).toMatchObject({ label: "Look into the electives", start: null });
    expect(cv).toMatchObject({ label: "Update CV", start: null });
    expect(parsePlanRequests("lectures 2:30-6:30")[0]).toMatchObject({ start: 14 * 60 + 30, end: 18 * 60 + 30 });
    expect(parsePlanRequests("dentist at 4")[0]).toMatchObject({ label: "Dentist", start: 16 * 60, end: 17 * 60 });
    expect(parsePlanRequests("gym 8:30 to 9:30")[0]).toMatchObject({ start: 8 * 60 + 30, end: 9 * 60 + 30 });
    // A length is not a time.
    expect(parsePlanRequests("2h of leetcode")[0]).toMatchObject({ label: "Leetcode", minutes: 120, start: null });
  });

  it("owner's Wednesday plan: commas inside brackets don't split the request", () => {
    const out = parsePlanRequests("6h academics (Calculus, Probability, Machine Learning), coding tasks for Snapchat");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ minutes: 360, parts: ["calculus", "probability", "machine learning"] });
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

describe("matchRequestAll / titleCoversRequest", () => {
  it("every task the words name, best first", () => {
    const nodes = [
      { id: "a", title: "LeetCode: two medium array problems", node_type: "task" },
      { id: "b", title: "LeetCode", node_type: "task" },
      { id: "c", title: "Update CV", node_type: "task" },
    ];
    expect(matchRequestAll("leetcode", nodes).map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("a block title covers a request by its subject words", () => {
    expect(titleCoversRequest("Research selectives", "look into the selectives")).toBe(true);
    expect(titleCoversRequest("Clean room", "clean room fully")).toBe(true);
    expect(titleCoversRequest("Update CV", "update cv")).toBe(true);
    expect(titleCoversRequest("Update BrainDump docs", "update cv")).toBe(false);
    expect(titleCoversRequest("Research 10 target companies", "find companies apply")).toBe(false);
  });
});

describe("pinFromMessage — a time the chat model dropped", () => {
  it("owner 10-06: include '1.5h mealprep' + the message's 'from like 12:30' → fixed 12:30–14:00", () => {
    const out = pinFromMessage(
      "1.5h mealprep, look into selectives, update CV",
      "can you build a schedule, i want 1.5h mealprep right now from like 12:30, then i have a lecture at 15:30 to 18:30",
    );
    expect(out.fixed).toEqual([{ id: "said-0", title: "Mealprep", start: 12 * 60 + 30, end: 14 * 60 }]);
    expect(out.include).toBe("look into selectives, update CV");
  });

  it("the plan's own span is not an item's time: 'rebuild 18:00 to 19:30: 1h of leetcode'", () => {
    const message = "rebuild just 18:00 to 19:30 for me: 1h of leetcode and 30 min on my cv";
    const out = pinFromMessage("1h of leetcode, 30 min on CV", message, { start: 18 * 60, end: 19 * 60 + 30 });
    expect(out.fixed).toEqual([]);
    expect(out.include).toBe("1h of leetcode, 30 min on CV");
    // The Tuesday case keeps working with its window (12:30–23:00).
    const tuesday = pinFromMessage("1.5h mealprep", "i want 1.5h mealprep right now from like 12:30", { start: 750, end: 1380 });
    expect(tuesday.fixed).toHaveLength(1);
  });

  it("an item in the same sentence as another time doesn't take that time", () => {
    const out = pinFromMessage(
      "Look into selectives, update CV",
      "then i have a lecture at 15:30 to 18:30 (information retrieval). Other than that i need to look into the selectives",
    );
    expect(out).toEqual({ include: "Look into selectives, update CV", fixed: [] });
    // Same sentence, no comma: too many other words around the time.
    expect(pinFromMessage("look into selectives", "i have a lecture at 15:30 to 18:30 and need to look into the selectives").fixed).toEqual([]);
  });

  it("a correction with a range; nothing timed leaves include as it was", () => {
    expect(pinFromMessage("mealprep, reading 30 min", "no wait, mealprep is from 12:30 to 14:00 like i said").fixed).toEqual([
      { id: "said-0", title: "Mealprep", start: 12 * 60 + 30, end: 14 * 60 },
    ]);
    expect(pinFromMessage("update CV, 2h of leetcode", "plan my day")).toEqual({ include: "update CV, 2h of leetcode", fixed: [] });
  });
});
