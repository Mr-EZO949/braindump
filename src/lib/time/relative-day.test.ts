import { describe, expect, it } from "vitest";

import { resolveRelativeDay } from "./relative-day";

// 2026-10-07 is a Wednesday.
const WED = "2026-10-07";

describe("resolveRelativeDay", () => {
  it.each([
    ["friday", "2026-10-09"],
    ["this friday", "2026-10-09"],
    ["Fri", "2026-10-09"],
    ["on friday", "2026-10-09"],
    ["this coming friday", "2026-10-09"],
    ["next friday", "2026-10-16"],
    ["monday", "2026-10-12"],
    ["next monday", "2026-10-12"],
    ["wednesday", "2026-10-14"],
    ["this wednesday", WED],
    ["today", WED],
    ["tomorrow", "2026-10-08"],
    ["in 3 days", "2026-10-10"],
    ["in two weeks", "2026-10-21"],
    ["next week", "2026-10-14"],
    ["2026-11-02", "2026-11-02"],
    ["oct 20", "2026-10-20"],
    ["20th October", "2026-10-20"],
    ["Sept 3", "2027-09-03"],
  ])("%s → %s", (phrase, expected) => {
    expect(resolveRelativeDay(phrase, WED)).toBe(expected);
  });

  it("'next' on a Saturday is the coming day when it's already next week", () => {
    expect(resolveRelativeDay("next monday", "2026-10-10")).toBe("2026-10-12");
    expect(resolveRelativeDay("next sunday", "2026-10-10")).toBe("2026-10-18");
  });

  it.each(["soon", "end of term", "the 15th", "in 900 days", "feb 30", ""])("gives up on %j", (phrase) => {
    expect(resolveRelativeDay(phrase, WED)).toBeNull();
  });
});
