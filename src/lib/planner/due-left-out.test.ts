import { describe, expect, it } from "vitest";

import { describeLeftOut, dueLeftOut, leftOutQuestion, type DueSoonItem } from "./due-left-out";

const exam: DueSoonItem = { id: "exam", title: "Stats exam", days_left: 1, node_ids: ["exam", "ch3", "ch4"] };
const cv: DueSoonItem = { id: "cv", title: "Send CV", days_left: 0, node_ids: ["cv"] };
const later: DueSoonItem = { id: "essay", title: "Essay", days_left: 5, node_ids: ["essay"] };

describe("dueLeftOut", () => {
  it("names due-soon work with no block, soonest first", () => {
    const out = dueLeftOut({ dueSoon: [exam, cv, later], blocks: [{ node_id: "gym" }, { node_id: null }], today: "2026-10-06" });
    expect(out).toEqual([
      { id: "cv", title: "Send CV", label: "due today" },
      { id: "exam", title: "Stats exam", label: "due tomorrow" },
    ]);
    expect(describeLeftOut(out)).toBe('"Send CV" (due today) and "Stats exam" (due tomorrow)');
    expect(leftOutQuestion(out)).toBe(
      '"Send CV" (due today) and "Stats exam" (due tomorrow) aren\'t in it — want me to build around them?',
    );
    expect(leftOutQuestion(out.slice(1))).toBe('"Stats exam" is due tomorrow and isn\'t in it — want me to build around it?');
  });

  it("a block on any open step, or on a time block holding one, covers the deadline", () => {
    expect(dueLeftOut({ dueSoon: [exam], blocks: [{ node_id: "ch4" }], today: "2026-10-06" })).toEqual([]);
    expect(
      dueLeftOut({
        dueSoon: [exam],
        blocks: [{ node_id: "uni" }],
        timeBlocks: [{ id: "uni", step_ids: ["ch3", "lab"] }],
        today: "2026-10-06",
      }),
    ).toEqual([]);
  });

  it("long overdue is a different question; a later day skips what's due before it", () => {
    const old: DueSoonItem = { id: "old", title: "Old form", days_left: -12, node_ids: ["old"] };
    expect(dueLeftOut({ dueSoon: [old], blocks: [], today: "2026-10-06" })).toEqual([]);
    // Planning Thursday (3 days ahead): the exam tomorrow is past by then, the essay is 2 days out.
    const out = dueLeftOut({ dueSoon: [exam, later], blocks: [], today: "2026-10-06", planDate: "2026-10-09" });
    expect(out.map((i) => i.id)).toEqual(["essay"]);
    expect(out[0].label).toBe("due in 5 days");
  });

  it("nothing left out → no line", () => {
    expect(describeLeftOut([])).toBeNull();
    expect(leftOutQuestion([])).toBeNull();
  });
});
