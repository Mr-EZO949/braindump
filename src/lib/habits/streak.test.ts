import { describe, expect, it } from "vitest";
import { applyHabitDayToggle, computeStreak, lastNDays } from "./streak";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("applyHabitDayToggle", () => {
  it("matches what the server recomputes after a tick of today or yesterday", () => {
    const today = "2026-09-29";
    const window = 90;
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const density = r();
      const all = lastNDays([], today, window).map((d) => d.date);
      const done = new Set(all.filter(() => r() < density));
      const date = r() < 0.5 ? today : all[all.length - 2];
      const markDone = !done.has(date);

      const before = { history: lastNDays(done, today, window), streak: computeStreak(done, today) };
      const optimistic = applyHabitDayToggle(before, date, markDone, today);

      const after = new Set(done);
      if (markDone) after.add(date);
      else after.delete(date);
      expect(optimistic.history).toEqual(lastNDays(after, today, window));
      expect(optimistic.streak).toEqual(computeStreak(after, today));
    }
  });

  it("keeps a streak longer than the loaded window when today is ticked", () => {
    const today = "2026-09-29";
    const history = lastNDays([], today, 7).map((d) => ({ ...d, done: d.date !== today }));
    const result = applyHabitDayToggle(
      { history, streak: { streak: 120, doneToday: false, atRisk: true } },
      today,
      true,
      today,
    );
    expect(result.streak).toEqual({ streak: 121, doneToday: true, atRisk: false });
  });

  it("is a no-op on the streak when the day is already in that state", () => {
    const today = "2026-09-29";
    const data = {
      history: [{ date: today, done: true }],
      streak: { streak: 3, doneToday: true, atRisk: false },
      started_on: null,
    };
    expect(applyHabitDayToggle(data, today, true, today)).toEqual(data);
  });
});
