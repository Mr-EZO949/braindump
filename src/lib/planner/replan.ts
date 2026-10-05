// One plan per day, and "I went off schedule" (#27, docs/replan.md).
//
// A day's plan is its plan_tasks: what the Planner's Accept writes, what the
// user ticks. A task made from a plan carries the node it is about (node_id);
// a task typed by hand has none and is never part of "the plan".
//
// - A new plan for a day takes over the old plan's UNFINISHED tasks that start
//   before it ends (all of them for a day plan). Ticked tasks stay — they
//   happened. The old rows go into the replacement record (plan-replace.ts),
//   so Undo puts them back exactly.
// - "Replan from now" keeps the unfinished tasks, re-timed from now around
//   fixed commitments and the user's own timed tasks; what the user says they
//   missed leaves today's plan; what can't fit before the day ends drops —
//   undated work first. No model call: the plan the user accepted is the plan.
//
// Pure — shared by the routes, the chat tool and the tests.

export interface DayPlanTask {
  id: string;
  title: string;
  node_id: string | null;
  scheduled_date: string | null;
  start_time: string | null;
  duration_minutes: number | null;
  done: boolean;
  created_at: string;
}

export const DAY_TASK_SELECT = "id, title, node_id, scheduled_date, start_time, duration_minutes, done, created_at";

/** A plan block with no length (an old row) counts as this long. */
export const DEFAULT_TASK_MINUTES = 30;

const TIME_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

export function clockToMinutes(value: string | null | undefined): number | null {
  const match = typeof value === "string" ? value.trim().match(TIME_RE) : null;
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h > 23 || m > 59 ? null : h * 60 + m;
}

export function minutesToClock(value: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(value)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Made by a plan (it names the node it is about), not typed by hand. */
export function isPlanTask(task: Pick<DayPlanTask, "node_id">): boolean {
  return typeof task.node_id === "string" && task.node_id.length > 0;
}

function taskMinutes(task: Pick<DayPlanTask, "duration_minutes">): number {
  return task.duration_minutes && task.duration_minutes > 0 ? task.duration_minutes : DEFAULT_TASK_MINUTES;
}

function sameDay(task: Pick<DayPlanTask, "scheduled_date">, date: string): boolean {
  return (task.scheduled_date ?? "").slice(0, 10) === date;
}

/**
 * What a new plan for `date` replaces: the plan's unfinished tasks that start
 * before the new plan ends (null = it runs to the end of the day). A task with
 * no time is replaced too. Ticked tasks and hand-typed ones stay.
 */
export function supersededTasks(tasks: DayPlanTask[], date: string, planEndMinute: number | null): DayPlanTask[] {
  return tasks.filter((task) => {
    if (!sameDay(task, date) || task.done || !isPlanTask(task)) return false;
    const start = clockToMinutes(task.start_time);
    return planEndMinute === null || start === null || start < planEndMinute;
  });
}

/**
 * Of those, the ones whose time had passed by `nowMinute` — planned and not
 * done: skips, which the stale check counts. A past day: all; a future day: none.
 */
export function pastUnfinished(tasks: DayPlanTask[], date: string, today: string, nowMinute: number): DayPlanTask[] {
  if (date > today) return [];
  return tasks.filter((task) => {
    if (!sameDay(task, date) || task.done || !isPlanTask(task)) return false;
    if (date < today) return true;
    const start = clockToMinutes(task.start_time);
    return start !== null && start + taskMinutes(task) <= nowMinute;
  });
}

export interface PlacedTask {
  task: DayPlanTask;
  start: number;
  minutes: number;
}

export interface ReplanResult {
  /** The rest of today, in time order. */
  placed: PlacedTask[];
  /** Off today's plan because the user said so. */
  missed: DayPlanTask[];
  /** No room before the day ends. */
  didntFit: DayPlanTask[];
}

/**
 * Lays the day's unfinished plan tasks out again from `startMinute`: each keeps
 * its time when that is still ahead and free, else it moves to the next free
 * moment — in the order they were planned, never over busy time, never past
 * `endMinute`. When it doesn't all fit, the last task without a deadline
 * drops first, then the last one.
 */
export function replanRestOfDay(params: {
  tasks: DayPlanTask[];
  date: string;
  startMinute: number;
  endMinute: number;
  busy: Array<{ start: number; end: number }>;
  missedNodeIds?: ReadonlySet<string>;
  datedNodeIds?: ReadonlySet<string>;
}): ReplanResult {
  const missedIds = params.missedNodeIds ?? new Set<string>();
  const dated = params.datedNodeIds ?? new Set<string>();
  const open = params.tasks
    .filter((task) => sameDay(task, params.date) && !task.done && isPlanTask(task))
    .sort((a, b) => {
      const sa = clockToMinutes(a.start_time) ?? Number.MAX_SAFE_INTEGER;
      const sb = clockToMinutes(b.start_time) ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.created_at.localeCompare(b.created_at);
    });
  const missed = open.filter((task) => missedIds.has(task.node_id as string));
  let carry = open.filter((task) => !missedIds.has(task.node_id as string));
  const busy = [...params.busy].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);

  const layout = (list: DayPlanTask[]): PlacedTask[] | null => {
    let cursor = params.startMinute;
    const placed: PlacedTask[] = [];
    for (const task of list) {
      const minutes = taskMinutes(task);
      let start = Math.max(cursor, clockToMinutes(task.start_time) ?? cursor);
      let moved = true;
      while (moved) {
        moved = false;
        for (const b of busy) {
          if (start < b.end && start + minutes > b.start) {
            start = b.end;
            moved = true;
          }
        }
      }
      if (start + minutes > params.endMinute) return null;
      placed.push({ task, start, minutes });
      cursor = start + minutes;
    }
    return placed;
  };

  const didntFit: DayPlanTask[] = [];
  let placed = layout(carry);
  while (!placed && carry.length > 0) {
    let victim = -1;
    for (let i = carry.length - 1; i >= 0; i -= 1) {
      if (!dated.has(carry[i].node_id as string)) {
        victim = i;
        break;
      }
    }
    if (victim < 0) victim = carry.length - 1;
    didntFit.unshift(carry[victim]);
    carry = carry.filter((_, i) => i !== victim);
    placed = layout(carry);
  }
  return { placed: placed ?? [], missed, didntFit };
}

/** Where "from now" starts: the next quarter hour. */
export function replanStartMinute(nowMinute: number): number {
  return Math.min(23 * 60 + 45, Math.ceil(Math.max(0, nowMinute) / 15) * 15);
}

/** Today's plan for the chat snapshot: one line per plan task, in time order. */
export function describeDayPlan(tasks: DayPlanTask[], date: string): string | null {
  const rows = tasks
    .filter((task) => sameDay(task, date) && isPlanTask(task))
    .sort((a, b) => (clockToMinutes(a.start_time) ?? 9999) - (clockToMinutes(b.start_time) ?? 9999));
  if (rows.length === 0) return null;
  const lines = rows.slice(0, 12).map((task) => {
    const start = clockToMinutes(task.start_time);
    const when = start === null ? "any time" : `${minutesToClock(start)}–${minutesToClock(start + taskMinutes(task))}`;
    return `- ${when} ${task.title} — ${task.done ? "done ✓" : "not done"} — id: ${task.node_id}`;
  });
  return `Today's plan (Planner; "done ✓" = ticked):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Replacement records → skips and missed habits (lib/ai/planner.ts reads them)
// ---------------------------------------------------------------------------

export const PLAN_REPLACE_ENTITY = "plan_replace";

export interface ReplacementRow {
  id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface NodeRef {
  node_id: string;
  title: string;
}

function nodeRefs(raw: unknown): NodeRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const r = (row ?? {}) as { node_id?: unknown; title?: unknown };
    return typeof r.node_id === "string" ? [{ node_id: r.node_id, title: typeof r.title === "string" ? r.title : "" }] : [];
  });
}

/** Replacement rows that weren't undone (an undo row names the one it cancels). */
export function liveReplacements(rows: ReplacementRow[]): ReplacementRow[] {
  const undone = new Set(
    rows.flatMap((row) => (typeof row.metadata?.undoes === "string" ? [row.metadata.undoes as string] : [])),
  );
  return rows.filter((row) => typeof row.metadata?.undoes !== "string" && !undone.has(row.id));
}

/**
 * What live replacements say: the plan tasks they took off a day unfinished
 * after their time (skips, as planned tasks for skipDaysByNode) and the
 * habits the user said they missed today (out of today's Focus and plans).
 */
export function replacementMarks(
  rows: ReplacementRow[],
  today: string,
): { skipped: Array<{ node_id: string; scheduled_date: string; created_at: string }>; missedToday: Set<string> } {
  const skipped: Array<{ node_id: string; scheduled_date: string; created_at: string }> = [];
  const missedToday = new Set<string>();
  for (const row of liveReplacements(rows)) {
    const date = typeof row.metadata?.date === "string" ? (row.metadata.date as string) : null;
    if (!date) continue;
    for (const ref of nodeRefs(row.metadata?.skipped)) {
      skipped.push({ node_id: ref.node_id, scheduled_date: date, created_at: row.created_at });
    }
    if (date === today) for (const ref of nodeRefs(row.metadata?.missed)) missedToday.add(ref.node_id);
  }
  return { skipped, missedToday };
}
