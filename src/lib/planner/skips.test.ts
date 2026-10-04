import { describe, expect, it } from "vitest";

import {
  STALE_SKIP_DAYS,
  answeredAtByNode,
  calendarEntryCounts,
  formatSkipDays,
  isStale,
  skipDaysByNode,
  type StaleMarker,
} from "./skips";

const TODAY = "2026-10-04"; // a Sunday

const task = (node_id: string, scheduled_date: string, created_at = `${scheduled_date}T07:00:00.000Z`) => ({
  node_id,
  scheduled_date,
  created_at,
});

const marker = (id: string, entity_id: string, created_at: string, metadata: Record<string, unknown>): StaleMarker => ({
  id,
  entity_id,
  created_at,
  metadata,
});

describe("skipDaysByNode", () => {
  it("counts distinct past days a node was planned and left undone", () => {
    const days = skipDaysByNode({
      today: TODAY,
      tasks: [
        task("ml", "2026-09-28"),
        task("ml", "2026-09-28"), // two entries the same day: one skip
        task("ml", "2026-09-30"),
        task("bank", "2026-10-01"),
      ],
    });
    expect(days.get("ml")).toEqual(["2026-09-28", "2026-09-30"]);
    expect(days.get("bank")).toEqual(["2026-10-01"]);
  });

  it("today and later aren't skips yet; past the 14-day window doesn't count", () => {
    const days = skipDaysByNode({
      today: TODAY,
      tasks: [task("a", TODAY), task("a", "2026-10-06"), task("a", "2026-09-19"), task("a", "2026-09-20")],
    });
    expect(days.get("a")).toEqual(["2026-09-20"]);
  });

  it("restarts after the latest answer — a plan made after it for that same day still counts", () => {
    const answeredAt = new Map([["ml", "2026-10-01T09:00:00.000Z"]]);
    const days = skipDaysByNode({
      today: TODAY,
      answeredAt,
      tasks: [
        task("ml", "2026-09-28"),
        task("ml", "2026-09-30"),
        task("ml", "2026-10-01", "2026-09-30T20:00:00.000Z"), // planned the night before: not counted
        task("ml", "2026-10-02"),
      ],
    });
    expect(days.get("ml")).toEqual(["2026-10-02"]);

    const sameDay = skipDaysByNode({
      today: TODAY,
      answeredAt,
      tasks: [task("ml", "2026-10-01", "2026-10-01T10:00:00.000Z")],
    });
    expect(sameDay.get("ml")).toEqual(["2026-10-01"]);
  });

  it("a day the node (or a step inside it) got done isn't a skip", () => {
    const days = skipDaysByNode({
      today: TODAY,
      tasks: [task("italian", "2026-10-01"), task("italian", "2026-10-02")],
      workedOn: (id, day) => id === "italian" && day === "2026-10-01",
    });
    expect(days.get("italian")).toEqual(["2026-10-02"]);
  });

  it("reads the answer's day in the user's timezone", () => {
    // 23:30 UTC on Oct 1 is already Oct 2 in Rome (offset -120).
    const days = skipDaysByNode({
      today: TODAY,
      tzOffsetMin: -120,
      answeredAt: new Map([["a", "2026-10-01T23:30:00.000Z"]]),
      tasks: [task("a", "2026-10-02", "2026-10-01T18:00:00.000Z"), task("a", "2026-10-03")],
    });
    expect(days.get("a")).toEqual(["2026-10-03"]);
  });
});

describe("answeredAtByNode", () => {
  it("keeps the latest answer per node and ignores answers that were undone", () => {
    const at = answeredAtByNode([
      marker("m1", "ml", "2026-10-01T09:00:00.000Z", { answer: "still_matters" }),
      marker("m2", "ml", "2026-10-03T09:00:00.000Z", { answer: "not_now" }),
      marker("m3", "ml", "2026-10-03T09:01:00.000Z", { answer: "undo", undoes: "m2" }),
      marker("m4", "bank", "2026-10-02T09:00:00.000Z", { answer: "drop" }),
      marker("m5", "bank", "2026-10-02T09:01:00.000Z", { answer: "undo", undoes: "m4" }),
      marker("m6", "x", "2026-10-02T09:00:00.000Z", { answer: "something else" }),
    ]);
    expect(at.get("ml")).toBe("2026-10-01T09:00:00.000Z");
    expect(at.has("bank")).toBe(false);
    expect(at.has("x")).toBe(false);
  });
});

describe("isStale", () => {
  it(`asks at ${STALE_SKIP_DAYS}+ skipped days with no deadline`, () => {
    expect(isStale({ skipDays: 2, hasDeadline: false, nodeType: "task" })).toBe(true);
    expect(isStale({ skipDays: 1, hasDeadline: false, nodeType: "task" })).toBe(false);
  });

  it("never asks about work with a deadline — it keeps coming back", () => {
    expect(isStale({ skipDays: 5, hasDeadline: true, nodeType: "task" })).toBe(false);
  });

  it("never asks about a habit (cadence) or about things that aren't planned", () => {
    expect(isStale({ skipDays: 4, hasDeadline: false, nodeType: "habit" })).toBe(false);
    expect(isStale({ skipDays: 4, hasDeadline: false, nodeType: "note" })).toBe(false);
    expect(isStale({ skipDays: 4, hasDeadline: false, nodeType: "area" })).toBe(false);
    for (const type of ["big_task", "project", "goal", "class"]) {
      expect(isStale({ skipDays: 2, hasDeadline: false, nodeType: type })).toBe(true);
    }
  });
});

describe("calendarEntryCounts", () => {
  it("today's and upcoming entries push; a past one pushes only dated work", () => {
    expect(calendarEntryCounts({ scheduledDate: TODAY, today: TODAY, hasDeadline: false })).toBe(true);
    expect(calendarEntryCounts({ scheduledDate: "2026-10-06", today: TODAY, hasDeadline: false })).toBe(true);
    expect(calendarEntryCounts({ scheduledDate: "2026-10-01", today: TODAY, hasDeadline: false })).toBe(false);
    expect(calendarEntryCounts({ scheduledDate: "2026-10-01", today: TODAY, hasDeadline: true })).toBe(true);
  });
});

describe("formatSkipDays", () => {
  it("weekdays for the past week, dates further back", () => {
    expect(formatSkipDays(["2026-09-30", "2026-09-28"], TODAY)).toBe("Mon, Wed");
    expect(formatSkipDays(["2026-09-22", "2026-10-02"], TODAY)).toBe("Sep 22, Fri");
  });
});
