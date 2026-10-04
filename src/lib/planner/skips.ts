// Skipped plans → "Does this still matter?" (owner, 2026-10-04: "the past
// undone tasks clogging the current focus sessions and schedulings. If there
// was a certain deadline then yes, it can reappear, but otherwise I don't
// think it should").
//
// A SKIP is a day a node sat in the user's plan — a plan_task on that date,
// which is what the Planner's Accept and Focus's "Plan my day" write — and was
// left undone. Until 2026-10-04 a skip pushed the node UP: +170 "carried over"
// and +240 "on your calendar" for the past date, deadline or not, so
// yesterday's leftovers crowded the top of Focus and the next plan.
//
// Now (lib/ai/planner.ts):
//   - a skip pushes only work with a deadline (its own or inherited);
//   - STALE_SKIP_DAYS skips with no deadline make the node STALE: it leaves
//     Focus's picks and new plans until the user answers a small card —
//     still matters / not now / drop it. Deterministic, no model call.
//
// Answers are feedback_events rows (no migration): entity_type "stale_check",
// entity_id = the node, metadata.answer. Undo appends an "undo" row naming the
// answer it cancels (feedback_events is append-only). The skip count restarts
// after the latest answer that wasn't undone.

export const SKIP_WINDOW_DAYS = 14;
export const STALE_SKIP_DAYS = 2;

export const STALE_CHECK_ENTITY = "stale_check";
// An existing feedback_event_type value — nothing reads edit_plan rows with
// this entity_type, so the answers never count as steering or acceptance.
export const STALE_CHECK_EVENT = "edit_plan";

export const STALE_ANSWERS = ["still_matters", "not_now", "drop"] as const;
export type StaleAnswer = (typeof STALE_ANSWERS)[number];

export function isStaleAnswer(value: unknown): value is StaleAnswer {
  return typeof value === "string" && (STALE_ANSWERS as readonly string[]).includes(value);
}

// What can sit in a plan and so be skipped. Habits run on cadence — a missed
// gym day isn't a leftover to question — and areas, ideas and notes are
// never planned.
const STALE_TYPES = new Set(["task", "big_task", "project", "goal", "class"]);

export interface StaleMarker {
  id: string;
  entity_id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** Per node: when the latest answer that wasn't undone was given. */
export function answeredAtByNode(markers: StaleMarker[]): Map<string, string> {
  const undone = new Set<string>();
  for (const m of markers) {
    const undoes = m.metadata?.undoes;
    if (m.metadata?.answer === "undo" && typeof undoes === "string") undone.add(undoes);
  }
  const out = new Map<string, string>();
  for (const m of markers) {
    if (!isStaleAnswer(m.metadata?.answer) || undone.has(m.id)) continue;
    const prev = out.get(m.entity_id);
    if (!prev || m.created_at > prev) out.set(m.entity_id, m.created_at);
  }
  return out;
}

/** The user's local YYYY-MM-DD for an instant (tzOffsetMin = getTimezoneOffset()). */
export function localDateOf(iso: string, tzOffsetMin: number): string {
  return new Date(Date.parse(iso) - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

export function addDaysISO(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface PlannedTask {
  node_id: string | null;
  scheduled_date: string | null;
  created_at: string;
}

/**
 * Distinct past days (oldest first) each node was planned and left undone,
 * within the window. `tasks` are the UNDONE plan tasks. A day doesn't count
 * when the node or something inside it was finished that day (`workedOn`:
 * a 2h "Italian" block whose lesson got done wasn't skipped), nor when it is
 * on or before the node's latest answer (a plan made after the answer, for
 * that same day, still counts).
 */
export function skipDaysByNode(params: {
  tasks: PlannedTask[];
  today: string;
  windowDays?: number;
  answeredAt?: Map<string, string>;
  tzOffsetMin?: number;
  workedOn?: (nodeId: string, day: string) => boolean;
}): Map<string, string[]> {
  const windowStart = addDaysISO(params.today, -(params.windowDays ?? SKIP_WINDOW_DAYS));
  const tz = params.tzOffsetMin ?? 0;
  const days = new Map<string, Set<string>>();
  for (const task of params.tasks) {
    const nodeId = task.node_id;
    const day = task.scheduled_date?.slice(0, 10);
    if (!nodeId || !day || day < windowStart || day >= params.today) continue;
    const answered = params.answeredAt?.get(nodeId);
    if (answered) {
      const answeredDay = localDateOf(answered, tz);
      if (day < answeredDay) continue;
      if (day === answeredDay && !(task.created_at > answered)) continue;
    }
    if (params.workedOn?.(nodeId, day)) continue;
    const set = days.get(nodeId) ?? new Set<string>();
    set.add(day);
    days.set(nodeId, set);
  }
  return new Map([...days].map(([id, set]) => [id, [...set].sort()]));
}

/** Stale = skipped on enough days, with no deadline, and a plannable type. */
export function isStale(params: { skipDays: number; hasDeadline: boolean; nodeType: string }): boolean {
  return params.skipDays >= STALE_SKIP_DAYS && !params.hasDeadline && STALE_TYPES.has(params.nodeType);
}

/**
 * A planner entry pushes a node up ("On your calendar") when it's for today or
 * later; a past one is a skip, and pushes only work with a deadline.
 */
export function calendarEntryCounts(params: { scheduledDate: string; today: string; hasDeadline: boolean }): boolean {
  return params.scheduledDate >= params.today || params.hasDeadline;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon, Wed" — weekday names for the past week, "Sep 22" further back. */
export function formatSkipDays(days: string[], today: string): string {
  const weekAgo = addDaysISO(today, -6);
  return [...days]
    .sort()
    .map((day) => {
      const d = new Date(`${day}T12:00:00.000Z`);
      return day >= weekAgo ? WEEKDAYS[d.getUTCDay()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    })
    .join(", ");
}

export interface StaleItem {
  id: string;
  title: string;
  node_type: string;
  /** Skipped days, oldest first (YYYY-MM-DD). */
  skipped_on: string[];
  /** "Mon, Wed" */
  skipped_label: string;
}
