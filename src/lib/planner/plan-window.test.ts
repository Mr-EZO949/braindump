import { describe, expect, it } from "vitest";

import {
  PLAN_MAX_MINUTES,
  dayPlanMinutes,
  describeSessionSpan,
  planWindowMinutes,
} from "./plan-window";

describe("plan window", () => {
  it("a day plan runs from its start to 23:00", () => {
    expect(dayPlanMinutes(8 * 60)).toBe(15 * 60);
    expect(dayPlanMinutes(14 * 60 + 30)).toBe(510);
    expect(planWindowMinutes("day", null, 8 * 60)).toBe(900);
  });

  it("the user's own end of work ends a day plan (docs/preferences.md)", () => {
    expect(dayPlanMinutes(8 * 60, 22 * 60)).toBe(14 * 60);
    expect(planWindowMinutes("day", null, 8 * 60, 22 * 60)).toBe(14 * 60);
    // Past their end of work: still an hour, as for a late start.
    expect(dayPlanMinutes(22 * 60 + 15, 22 * 60)).toBe(60);
    // Only a day plan: a 2-hour session keeps its length.
    expect(planWindowMinutes("2h", null, 21 * 60, 22 * 60)).toBe(120);
    expect(dayPlanMinutes(8 * 60, null)).toBe(15 * 60);
  });

  it("without a start, a day is 08:00–23:00", () => {
    expect(planWindowMinutes("day")).toBe(900);
  });

  it("an early start is capped at 18 hours", () => {
    expect(dayPlanMinutes(60)).toBe(PLAN_MAX_MINUTES);
  });

  it("a late start still gets an hour, but never past midnight", () => {
    expect(dayPlanMinutes(22 * 60 + 30)).toBe(60);
    expect(dayPlanMinutes(23 * 60 + 30)).toBe(30);
  });

  it("custom windows go up to 18 hours", () => {
    expect(planWindowMinutes("custom", 900)).toBe(900);
    expect(planWindowMinutes("custom", 5000)).toBe(PLAN_MAX_MINUTES);
    expect(planWindowMinutes("custom", 5)).toBe(15);
    expect(planWindowMinutes("custom", null)).toBe(60);
  });

  it("short windows are unchanged", () => {
    expect(planWindowMinutes("1h")).toBe(60);
    expect(planWindowMinutes("2h")).toBe(120);
  });

  it("describes the span", () => {
    expect(describeSessionSpan(8 * 60, 900)).toBe("08:00–23:00");
    expect(describeSessionSpan(23 * 60, 60)).toBe("23:00–24:00");
  });
});
