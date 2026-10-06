// Fixed commitments (docs/commitments.md) — the weekly times the user isn't
// free: a class every weekday at 14:00, a Tuesday shift. Pure schedule math
// shared by the server (Focus, the AI planner, the chat tool) and the browser
// (planner timeline, What Now's "Schedule these").
//
// Times are the user's local wall-clock times ("HH:MM"); days are ISO
// weekdays (1 = Mon … 7 = Sun); dates are YYYY-MM-DD in the user's calendar.

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatShortDate } from "@/lib/graph/short-date";

export interface Commitment {
  id: string;
  title: string;
  node_id: string | null;
  days: number[];
  start_time: string;
  end_time: string;
  starts_on: string | null;
  ends_on: string | null;
}

/** One commitment on one day, in minutes from local midnight. */
export interface BusyInterval {
  id: string;
  title: string;
  start: number;
  end: number;
}

export const COMMITMENT_SELECT = "id, title, node_id, days, start_time, end_time, starts_on, ends_on";

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** A commitment with no end time said ("stats at 2pm") lasts this long. */
export const DEFAULT_COMMITMENT_MINUTES = 60;

const TIME_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** "14:00" / "14:00:00" (Postgres time) → minutes from midnight. */
export function timeToMinutes(value: string | null | undefined): number | null {
  const match = typeof value === "string" ? value.trim().match(TIME_RE) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function minutesToTime(value: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(value)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/** ISO weekday (1 = Mon … 7 = Sun) of a YYYY-MM-DD date. */
export function isoWeekday(dateISO: string): number {
  const day = new Date(`${dateISO}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function activeOn(commitment: Commitment, dateISO: string): boolean {
  if (commitment.starts_on && dateISO < commitment.starts_on) return false;
  if (commitment.ends_on && dateISO > commitment.ends_on) return false;
  return commitment.days.includes(isoWeekday(dateISO));
}

/** The day's busy intervals, earliest first. */
export function busyOn(commitments: Commitment[], dateISO: string): BusyInterval[] {
  return commitments
    .filter((c) => activeOn(c, dateISO))
    .flatMap((c) => {
      const start = timeToMinutes(c.start_time);
      const end = timeToMinutes(c.end_time);
      return start === null || end === null || end <= start ? [] : [{ id: c.id, title: c.title, start, end }];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface FreeTime {
  /** The commitment happening right now, if any. */
  current: BusyInterval | null;
  /** The next one today, starting at or after the current one ends. */
  next: BusyInterval | null;
  /** Minutes free from now (or from the end of the current one) until `next`; null = free for the rest of the day. */
  freeMinutes: number | null;
}

export function freeTimeAt(commitments: Commitment[], dateISO: string, nowMinute: number): FreeTime {
  return freeTimeInBusy(busyOn(commitments, dateISO), nowMinute);
}

/** freeTimeAt over a day's busy intervals (earliest first) — the browser has only these. */
export function freeTimeInBusy(busy: BusyInterval[], nowMinute: number): FreeTime {
  // Back-to-back or overlapping commitments read as one busy stretch.
  let from = nowMinute;
  let current: BusyInterval | null = null;
  for (const interval of busy) {
    if (interval.start <= from && interval.end > from) {
      current = current ?? interval;
      from = interval.end;
    }
  }
  const next = busy.find((interval) => interval.start >= from) ?? null;
  return { current, next, freeMinutes: next ? next.start - from : null };
}

/** Busy intervals inside [start, end), clipped to it. */
export function busyWithin(busy: BusyInterval[], start: number, end: number): BusyInterval[] {
  return busy
    .filter((b) => b.end > start && b.start < end)
    .map((b) => ({ ...b, start: Math.max(b.start, start), end: Math.min(b.end, end) }));
}

/** The free stretches of [start, end) around the busy intervals. */
export function freeStretches(busy: BusyInterval[], start: number, end: number): { start: number; end: number }[] {
  const stretches: { start: number; end: number }[] = [];
  let cursor = start;
  for (const b of busyWithin(busy, start, end).sort((x, y) => x.start - y.start)) {
    if (b.start > cursor) stretches.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < end) stretches.push({ start: cursor, end });
  return stretches;
}

/**
 * Busy time the user names for one plan ("lectures 2:30–6:30 today") — not a
 * saved commitment. From chat's plan_day input; bad rows are dropped.
 */
export function oneOffBusy(raw: unknown): BusyInterval[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap((item, index) => {
    const row = (item ?? {}) as { title?: unknown; start?: unknown; end?: unknown };
    const start = timeToMinutes(typeof row.start === "string" ? row.start : null);
    const end = timeToMinutes(typeof row.end === "string" ? row.end : null);
    if (start === null || end === null || end <= start) return [];
    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 60) : "Busy";
    return [{ id: `once-${index}`, title, start, end }];
  });
}

/**
 * One-off busy time minus what a saved commitment already covers: chat named
 * "Information Retrieval lecture 15:30–18:30" for a day that has it saved,
 * and the plan listed it twice.
 */
export function withoutSaved(oneOff: BusyInterval[], saved: BusyInterval[]): BusyInterval[] {
  return oneOff.filter((b) => {
    const length = b.end - b.start;
    return !saved.some((s) => Math.min(b.end, s.end) - Math.max(b.start, s.start) >= length / 2);
  });
}

/** Where a session that starts "now" begins: 15 min out, on the half hour. */
export function nextSessionStartMinute(nowMinute: number): number {
  return Math.min(23 * 60 + 30, Math.ceil((nowMinute + 15) / 30) * 30);
}

/**
 * Start minutes for blocks laid out in order from `anchor`, skipping busy
 * time: a block that would run into a commitment starts after it instead.
 * With `fillsGaps`, the free time before a commitment isn't left empty when
 * the next block is too long for it: the first later block that fits (and may
 * fill a gap — not a break) goes there, the rest keep their order. Owner
 * 10-06: a 2-hour block didn't fit before a 15:30 lecture, so 14:10–15:30
 * stayed empty while three short tasks were pushed to 22:10–23:20.
 */
export function layoutAroundBusy(
  durations: number[],
  anchor: number,
  busy: { start: number; end: number }[],
  fillsGaps?: boolean[],
): number[] {
  const sorted = [...busy].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const starts = new Array<number>(durations.length).fill(anchor);
  const queue = durations.map((_, i) => i);
  let cursor = anchor;
  while (queue.length > 0) {
    const inside = sorted.find((b) => cursor >= b.start && cursor < b.end);
    if (inside) {
      cursor = inside.end;
      continue;
    }
    const next = sorted.find((b) => b.start >= cursor);
    const gap = next ? next.start - cursor : Infinity;
    let pick = durations[queue[0]] <= gap ? 0 : -1;
    if (pick < 0 && fillsGaps) pick = queue.findIndex((i, k) => k > 0 && fillsGaps[i] && durations[i] <= gap);
    if (pick < 0) {
      cursor = next!.end;
      continue;
    }
    const [index] = queue.splice(pick, 1);
    starts[index] = cursor;
    cursor += durations[index];
  }
  return starts;
}

/**
 * The AI planner's view of a session [start, start + length) that fixed
 * commitments cut into: the free minutes to plan and the Session-block lines
 * naming the busy time and the free stretches. Null when nothing overlaps.
 */
export function sessionBusyNote(
  busy: BusyInterval[],
  start: number,
  length: number,
): { free_minutes: number; lines: string[]; titles: string[] } | null {
  const end = start + length;
  const inside = busyWithin(busy, start, end);
  if (inside.length === 0) return null;
  const stretches = freeStretches(busy, start, end);
  const freeMinutes = stretches.reduce((sum, s) => sum + (s.end - s.start), 0);
  const span = (s: { start: number; end: number }) => `${minutesToTime(s.start)}–${minutesToTime(s.end)}`;
  return {
    free_minutes: freeMinutes,
    lines: [
      `Session starts ${minutesToTime(start)}. Busy inside it (fixed commitments — NOT part of your plan, schedule nothing then): ${inside
        .map((b) => `${b.title} ${span(b)}`)
        .join(", ")}.`,
      stretches.length > 0
        ? `Plan only the free time, ${freeMinutes} minutes, in these stretches: ${stretches
            .map((s) => `${span(s)} (${s.end - s.start} min)`)
            .join(", ")}. List blocks in time order; none may cross into busy time, and the busy time gets NO block — not even a placeholder.`
        : "There is no free time in this session.",
    ],
    // A block that only restates one of these is dropped (validatePlanOutput).
    titles: [...new Set(inside.map((b) => b.title))],
  };
}

/** "1h 30m" / "45 min" / "2h". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/**
 * Focus's time line: "In Stats until 15:00 · then 1h 30m free",
 * "45 min free · Stats at 14:00", "Stats at 14:00 — in 10 min".
 * Null when nothing else is fixed today.
 */
export function describeFreeTime(free: FreeTime): string | null {
  if (free.current) {
    const after =
      free.next && free.freeMinutes !== null
        ? free.freeMinutes > 0
          ? ` · then ${formatMinutes(free.freeMinutes)} free before ${free.next.title}`
          : ` · then ${free.next.title}`
        : "";
    return `In ${free.current.title} until ${minutesToTime(free.current.end)}${after}`;
  }
  if (!free.next || free.freeMinutes === null) return null;
  return free.freeMinutes < 15
    ? `${free.next.title} at ${minutesToTime(free.next.start)} — in ${formatMinutes(free.freeMinutes)}`
    : `${formatMinutes(free.freeMinutes)} free · ${free.next.title} at ${minutesToTime(free.next.start)}`;
}

// ── Words ───────────────────────────────────────────────────────────────────

/** [1,2,3,4,5] → "Mon–Fri", [2,4] → "Tue & Thu", all → "Every day". */
export function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  if (sorted.length === 2 && sorted[0] === 6 && sorted[1] === 7) return "Weekends";
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length >= 3) {
    return `${WEEKDAY_SHORT[sorted[0] - 1]}–${WEEKDAY_SHORT[sorted[sorted.length - 1] - 1]}`;
  }
  const names = sorted.map((d) => WEEKDAY_SHORT[d - 1]);
  return names.length === 2 ? `${names[0]} & ${names[1]}` : names.join(", ");
}

/**
 * "Mon–Fri 14:00–15:00 · until Dec 20" — the card line and the snapshot line.
 * An open-ended one says "no end date" there (it invites the user to give
 * one); `openEnd: false` leaves that out where it would only be noise.
 */
export function describeCommitment(
  commitment: Pick<Commitment, "days" | "start_time" | "end_time" | "starts_on" | "ends_on">,
  today?: string,
  options: { openEnd?: boolean } = {},
): string {
  const start = timeToMinutes(commitment.start_time);
  const end = timeToMinutes(commitment.end_time);
  const time = start !== null && end !== null ? `${minutesToTime(start)}–${minutesToTime(end)}` : "";
  const bounds = [
    commitment.starts_on && (!today || commitment.starts_on > today)
      ? `from ${formatShortDate(commitment.starts_on)}`
      : null,
    commitment.ends_on
      ? `until ${formatShortDate(commitment.ends_on)}`
      : options.openEnd === false
        ? null
        : "no end date",
  ].filter(Boolean);
  return [`${describeDays(commitment.days)} ${time}`.trim(), ...bounds].join(" · ");
}

// ── Loading ─────────────────────────────────────────────────────────────────

/** Postgres returns time as "HH:MM:SS" and smallint[] as numbers — normalize. */
export function normalizeCommitment(row: Record<string, unknown>): Commitment | null {
  const start = timeToMinutes(row.start_time as string);
  const end = timeToMinutes(row.end_time as string);
  const days = Array.isArray(row.days) ? row.days.map(Number).filter((d) => d >= 1 && d <= 7) : [];
  if (typeof row.id !== "string" || typeof row.title !== "string" || start === null || end === null) return null;
  if (days.length === 0) return null;
  return {
    id: row.id,
    title: row.title,
    node_id: typeof row.node_id === "string" ? row.node_id : null,
    days,
    start_time: minutesToTime(start),
    end_time: minutesToTime(end),
    starts_on: typeof row.starts_on === "string" ? row.starts_on : null,
    ends_on: typeof row.ends_on === "string" ? row.ends_on : null,
  };
}

/**
 * The user's commitments that haven't ended by `today`. Per user, not per
 * workspace — a class blocks the afternoon whichever workspace is open.
 * Fail-soft: a missing table (migration not applied) reads as none.
 */
export async function loadActiveCommitments(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<Commitment[]> {
  try {
    const { data, error } = await supabase
      .from("commitments")
      .select(COMMITMENT_SELECT)
      .eq("user_id", userId)
      .or(`ends_on.is.null,ends_on.gte.${today}`)
      .order("start_time", { ascending: true })
      .limit(60);
    if (error) return [];
    return ((data ?? []) as Record<string, unknown>[])
      .map(normalizeCommitment)
      .filter((c): c is Commitment => c !== null);
  } catch {
    return [];
  }
}
