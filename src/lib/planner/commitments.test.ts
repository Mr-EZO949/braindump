import { describe, expect, it } from "vitest";

import {
  activeOn,
  busyOn,
  describeCommitment,
  describeDays,
  describeFreeTime,
  freeStretches,
  freeTimeAt,
  isoWeekday,
  layoutAroundBusy,
  nextSessionStartMinute,
  normalizeCommitment,
  oneOffBusy,
  sessionBusyNote,
  type Commitment,
} from "./commitments";

const WED = "2026-10-07";
const SAT = "2026-10-10";

const stats: Commitment = {
  id: "stats",
  title: "Stats lecture",
  node_id: null,
  days: [1, 2, 3, 4, 5],
  start_time: "14:00",
  end_time: "15:00",
  starts_on: null,
  ends_on: "2026-12-20",
};
const lab: Commitment = { ...stats, id: "lab", title: "Lab", days: [3], start_time: "15:00", end_time: "16:30" };
const h = (hh: number, mm = 0) => hh * 60 + mm;

describe("which days a commitment runs", () => {
  it("follows its weekdays and its start/end dates", () => {
    expect(isoWeekday(WED)).toBe(3);
    expect(isoWeekday("2026-10-11")).toBe(7);
    expect(activeOn(stats, WED)).toBe(true);
    expect(activeOn(stats, SAT)).toBe(false);
    expect(activeOn(stats, "2026-12-21")).toBe(false);
    expect(activeOn({ ...stats, starts_on: "2026-10-12" }, WED)).toBe(false);
  });

  it("lists a day's busy time earliest first", () => {
    expect(busyOn([lab, stats], WED).map((b) => [b.id, b.start, b.end])).toEqual([
      ["stats", h(14), h(15)],
      ["lab", h(15), h(16, 30)],
    ]);
    expect(busyOn([lab, stats], SAT)).toEqual([]);
  });
});

describe("freeTimeAt — what Focus says", () => {
  it("before class: minutes free until it", () => {
    const free = freeTimeAt([stats], WED, h(13, 15));
    expect(free.current).toBeNull();
    expect(free.next?.id).toBe("stats");
    expect(free.freeMinutes).toBe(45);
    expect(describeFreeTime(free)).toBe("45 min free · Stats lecture at 14:00");
  });

  it("in class, with another one straight after: free counts from the end of both", () => {
    const free = freeTimeAt([stats, lab], WED, h(14, 30));
    expect(free.current?.id).toBe("stats");
    expect(free.next).toBeNull();
    expect(free.freeMinutes).toBeNull();
    expect(describeFreeTime(free)).toBe("In Stats lecture until 15:00");
  });

  it("almost time, and nothing left today", () => {
    expect(describeFreeTime(freeTimeAt([stats], WED, h(13, 52)))).toBe("Stats lecture at 14:00 — in 8 min");
    expect(describeFreeTime(freeTimeAt([stats], WED, h(16)))).toBeNull();
    expect(describeFreeTime(freeTimeAt([stats], SAT, h(10)))).toBeNull();
  });

  it("in class with a gap before the next", () => {
    const later = { ...lab, start_time: "16:30", end_time: "17:30" };
    expect(describeFreeTime(freeTimeAt([stats, later], WED, h(14, 10)))).toBe(
      "In Stats lecture until 15:00 · then 1h 30m free before Lab",
    );
  });
});

describe("planning around busy time", () => {
  it("free stretches of a session", () => {
    expect(freeStretches(busyOn([stats], WED), h(13), h(17))).toEqual([
      { start: h(13), end: h(14) },
      { start: h(15), end: h(17) },
    ]);
  });

  it("the AI planner's note: free minutes and where the gaps are", () => {
    const note = sessionBusyNote(busyOn([stats], WED), h(13), 240);
    expect(note?.free_minutes).toBe(180);
    expect(note?.lines[0]).toContain("Stats lecture 14:00–15:00");
    expect(note?.lines[1]).toContain("13:00–14:00 (60 min), 15:00–17:00 (120 min)");
    expect(note?.titles).toEqual(["Stats lecture"]);
    expect(sessionBusyNote(busyOn([stats], WED), h(9), 120)).toBeNull();
  });

  it("Accept lays blocks back to back and moves one that would hit class to after it", () => {
    // 13:00 start: 45 fits, 30 would run 13:45–14:15 → 15:00, then 20.
    expect(layoutAroundBusy([45, 30, 20], h(13), busyOn([stats, lab], WED))).toEqual([h(13), h(16, 30), h(17)]);
  });

  it("owner 10-06: short tasks fill the time before a lecture a long block doesn't fit; breaks don't jump ahead", () => {
    const lecture = [{ start: h(15, 30), end: h(18, 30) }];
    // research 10, core dev 120, break 10, test 60, CV 30, companies 20
    const durations = [10, 120, 10, 60, 30, 20];
    const fills = [true, true, false, true, true, true];
    // 14:00–15:30 holds research, the test pass and companies; core dev, the
    // break and the CV follow the lecture in order.
    expect(layoutAroundBusy(durations, h(14), lecture, fills)).toEqual([
      h(14),
      h(18, 30),
      h(20, 30),
      h(14, 10),
      h(20, 40),
      h(15, 10),
    ]);
  });
});

describe("words", () => {
  it("days", () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(describeDays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(describeDays([2, 4])).toBe("Tue & Thu");
    expect(describeDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(describeDays([6, 7])).toBe("Weekends");
  });

  it("a commitment", () => {
    expect(describeCommitment(stats, WED)).toBe("Mon–Fri 14:00–15:00 · until Dec 20");
    expect(describeCommitment({ ...stats, ends_on: null, starts_on: "2026-10-12" }, WED)).toBe(
      "Mon–Fri 14:00–15:00 · from Oct 12 · no end date",
    );
    expect(describeCommitment({ ...stats, ends_on: null }, WED, { openEnd: false })).toBe("Mon–Fri 14:00–15:00");
  });

  it("normalizes Postgres rows", () => {
    expect(
      normalizeCommitment({ ...stats, start_time: "14:00:00", end_time: "15:00:00", days: [1, 2, 3, 4, 5] }),
    ).toEqual(stats);
    expect(normalizeCommitment({ ...stats, days: [] })).toBeNull();
  });
});

describe("busy time named for one plan", () => {
  it("parses rows and drops bad ones", () => {
    expect(oneOffBusy([{ title: "Lectures", start: "14:30", end: "18:30" }, { start: "9:00", end: "8:00" }, null])).toEqual([
      { id: "once-0", title: "Lectures", start: h(14, 30), end: h(18, 30) },
    ]);
    expect(oneOffBusy("nope")).toEqual([]);
    expect(oneOffBusy([{ start: "16:00", end: "17:00" }])[0].title).toBe("Busy");
  });

  it("a session that starts now begins 15 minutes out, on the half hour", () => {
    expect(nextSessionStartMinute(h(12, 10))).toBe(h(12, 30));
    expect(nextSessionStartMinute(h(12, 20))).toBe(h(13));
    expect(nextSessionStartMinute(h(23, 50))).toBe(h(23, 30));
  });
});
