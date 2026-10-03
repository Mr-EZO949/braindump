// How long a plan is — shared by the Planner screen, POST /api/assistant/plan,
// chat's plan_day and the plan model call, so all four agree on the minutes.
//
// A "day" plan covers the user's waking day: from its start (the time they
// gave, else now on today, else 08:00 on another day) to 23:00. The profile
// knows no wake / sleep time yet, so 23:00 is the default end (owner,
// 2026-10-03: "plan like 15 hours, basically my whole day from when I'm awake"
// — 08:00–23:00 is 15 h). Until then a day was a fixed 8 h and every plan
// stopped at 10 h.

/** The longest plan: a whole waking day. */
export const PLAN_MAX_MINUTES = 18 * 60;
export const PLAN_MIN_MINUTES = 15;

/** A day plan ends here (local time). */
export const DAY_PLAN_END_MINUTE = 23 * 60;
/** A day plan for a day other than today starts here unless a time is given. */
export const DAY_PLAN_START_MINUTE = 8 * 60;

const MINUTES_IN_DAY = 24 * 60;

export type PlanWindowKind = "1h" | "2h" | "day" | "custom";

export function clampPlanMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.max(PLAN_MIN_MINUTES, Math.min(PLAN_MAX_MINUTES, Math.round(minutes)));
}

/**
 * A day plan's length from its start: to 23:00, at least an hour when the
 * evening is late, never past midnight, never over 18 h.
 */
export function dayPlanMinutes(startMinute: number): number {
  const start = Math.max(0, Math.min(MINUTES_IN_DAY - PLAN_MIN_MINUTES, Math.round(startMinute)));
  const toEnd = Math.max(60, DAY_PLAN_END_MINUTE - start);
  return clampPlanMinutes(Math.min(toEnd, MINUTES_IN_DAY - start));
}

/**
 * A planning window's length in minutes. `startMinute` (minutes from local
 * midnight) sizes a day plan; without it a day is assumed to start at 08:00.
 */
export function planWindowMinutes(
  window: string,
  customMinutes?: number | null,
  startMinute?: number | null,
): number {
  if (window === "custom") return clampPlanMinutes(customMinutes ?? 60);
  if (window === "day") return dayPlanMinutes(startMinute ?? DAY_PLAN_START_MINUTE);
  return window === "2h" ? 120 : 60;
}

/** "08:00–23:00" for a session [start, start + minutes). */
export function describeSessionSpan(startMinute: number, minutes: number): string {
  const clock = (value: number) => {
    const m = Math.max(0, Math.min(MINUTES_IN_DAY, Math.round(value)));
    return m === MINUTES_IN_DAY
      ? "24:00"
      : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return `${clock(startMinute)}–${clock(startMinute + minutes)}`;
}
