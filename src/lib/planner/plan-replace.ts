// Writing a day's plan — one plan per day, with Undo (docs/replan.md).
//
// Every way a plan reaches a day goes through commitDayPlan: the Planner's
// Accept (its own plans and chat's plan_day drafts), "Replan from now" and
// chat's replan_today. It writes the new plan's tasks, takes the old plan's
// unfinished tasks off the day, and records the replacement as one
// feedback_events row (entity_type "plan_replace") holding the old rows
// exactly — so the old plan is superseded, not lost, and Undo puts it back
// with its ticks and drops the new one. No migration: plan_tasks stays as is.
// Undo appends a row naming the one it cancels (feedback_events is
// append-only, like the stale check's answers).

import type { SupabaseClient } from "@supabase/supabase-js";

import { dayPlanMinutes } from "@/lib/planner/plan-window";
import { busyOn, loadActiveCommitments } from "@/lib/planner/commitments";
import {
  DAY_TASK_SELECT,
  PLAN_REPLACE_ENTITY,
  clockToMinutes,
  isPlanTask,
  liveReplacements,
  minutesToClock,
  pastUnfinished,
  replanRestOfDay,
  replanStartMinute,
  type DayPlanTask,
  type ReplanResult,
  type ReplacementRow,
} from "@/lib/planner/replan";

/** An existing feedback_event_type; nothing reads edit_plan rows of this entity_type as steering. */
export const PLAN_REPLACE_EVENT = "edit_plan";

export interface PlanScope {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}

export interface NewPlanTask {
  title: string;
  node_id: string | null;
  start_time: string | null;
  duration_minutes: number | null;
}

interface NodeRef {
  node_id: string;
  title: string;
}

export type CommitResult =
  | { ok: true; inserted: DayPlanTask[]; replacementId: string | null; replaced: number }
  | { ok: false; error: string };

const MAX_TASKS = 40;

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export async function loadDayTasks(scope: PlanScope, date: string): Promise<DayPlanTask[]> {
  const { data } = await scope.supabase
    .from("plan_tasks")
    .select(DAY_TASK_SELECT)
    .eq("user_id", scope.userId)
    .eq("workspace_id", scope.workspaceId)
    .eq("scheduled_date", date);
  return ((data ?? []) as DayPlanTask[]).map((row) => ({ ...row, done: Boolean(row.done) }));
}

function uniqueRefs(refs: NodeRef[]): NodeRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => (seen.has(ref.node_id) ? false : (seen.add(ref.node_id), true)));
}

/**
 * Writes `tasks` as the plan for `date`. `superseded` (the old plan's
 * unfinished tasks) leave the day; when any do — or for a replan — the
 * replacement is recorded and its id is the Undo handle.
 */
export async function commitDayPlan(
  scope: PlanScope,
  params: {
    date: string;
    tasks: NewPlanTask[];
    superseded: DayPlanTask[];
    skipped?: NodeRef[];
    missed?: NodeRef[];
    kind: "plan" | "replan";
    sessionId?: string | null;
  },
): Promise<CommitResult> {
  const { supabase, userId, workspaceId } = scope;
  const createdAt = new Date().toISOString();
  let inserted: DayPlanTask[] = [];
  if (params.tasks.length > 0) {
    const { data, error } = await supabase
      .from("plan_tasks")
      .insert(
        params.tasks.slice(0, MAX_TASKS).map((task) => ({
          user_id: userId,
          workspace_id: workspaceId,
          title: task.title,
          node_id: task.node_id,
          scheduled_date: params.date,
          start_time: task.start_time,
          duration_minutes: task.duration_minutes,
          done: false,
          created_at: createdAt,
        })),
      )
      .select(DAY_TASK_SELECT);
    if (error || !data) return { ok: false, error: error?.message ?? "tasks not saved" };
    inserted = (data as DayPlanTask[]).map((row) => ({ ...row, done: Boolean(row.done) }));
  }
  const rollback = async () => {
    if (inserted.length > 0) {
      await supabase.from("plan_tasks").delete().eq("user_id", userId).in("id", inserted.map((t) => t.id));
    }
  };

  const missed = uniqueRefs(params.missed ?? []);
  let replacementId: string | null = null;
  if (params.superseded.length > 0 || missed.length > 0 || params.kind === "replan") {
    const { data, error } = await supabase
      .from("feedback_events")
      .insert({
        user_id: userId,
        workspace_id: workspaceId,
        event_type: PLAN_REPLACE_EVENT,
        entity_type: PLAN_REPLACE_ENTITY,
        entity_id: params.sessionId ?? randomId(),
        created_at: new Date().toISOString(),
        metadata: {
          date: params.date,
          kind: params.kind,
          superseded: params.superseded,
          created: inserted.map((t) => t.id),
          skipped: uniqueRefs(params.skipped ?? []),
          missed,
          session_id: params.sessionId ?? null,
        },
      })
      .select("id")
      .single();
    if (error || !data) {
      await rollback();
      return { ok: false, error: error?.message ?? "plan change not recorded" };
    }
    replacementId = (data as { id: string }).id;
  }

  if (params.superseded.length > 0) {
    const { error } = await supabase
      .from("plan_tasks")
      .delete()
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .in("id", params.superseded.map((t) => t.id));
    if (error) {
      await rollback();
      if (replacementId) await recordUndo(scope, replacementId, params.date, params.sessionId ?? null);
      return { ok: false, error: error.message };
    }
  }
  return { ok: true, inserted, replacementId, replaced: params.superseded.length };
}

async function recordUndo(scope: PlanScope, replacementId: string, date: string, entityId: string | null) {
  await scope.supabase.from("feedback_events").insert({
    user_id: scope.userId,
    workspace_id: scope.workspaceId,
    event_type: PLAN_REPLACE_EVENT,
    entity_type: PLAN_REPLACE_ENTITY,
    entity_id: entityId ?? randomId(),
    created_at: new Date().toISOString(),
    metadata: { undoes: replacementId, date },
  });
}

function parseSuperseded(raw: unknown): DayPlanTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string") return [];
    return [
      {
        id: r.id,
        title: r.title,
        node_id: typeof r.node_id === "string" ? r.node_id : null,
        scheduled_date: typeof r.scheduled_date === "string" ? r.scheduled_date : null,
        start_time: typeof r.start_time === "string" ? r.start_time : null,
        duration_minutes: typeof r.duration_minutes === "number" ? r.duration_minutes : null,
        done: r.done === true,
        created_at: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
      },
    ];
  });
}

export type UndoResult = { ok: true; date: string; already?: boolean } | { ok: false; error: string; status: number };

/** Back to the earlier plan: the new plan's tasks go, the old rows come back as they were. */
export async function undoPlanReplacement(scope: PlanScope, replacementId: string): Promise<UndoResult> {
  const { supabase, userId, workspaceId } = scope;
  const { data: row } = await supabase
    .from("feedback_events")
    .select("id, entity_id, created_at, metadata")
    .eq("id", replacementId)
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("entity_type", PLAN_REPLACE_ENTITY)
    .maybeSingle();
  const record = row as (ReplacementRow & { entity_id: string }) | null;
  const meta = record?.metadata ?? null;
  const date = typeof meta?.date === "string" ? (meta.date as string) : null;
  if (!record || !meta || !date || typeof meta.undoes === "string") {
    return { ok: false, error: "That plan change wasn't found.", status: 404 };
  }

  // Later plan changes for the same day: undo stacks, newest first.
  const { data: laterRows } = await supabase
    .from("feedback_events")
    .select("id, created_at, metadata")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("entity_type", PLAN_REPLACE_ENTITY)
    .gte("created_at", record.created_at);
  const later = (laterRows ?? []) as ReplacementRow[];
  if (later.some((r) => r.metadata?.undoes === replacementId)) return { ok: true, date, already: true };
  const newer = liveReplacements(later).filter((r) => r.id !== replacementId && r.metadata?.date === date);
  if (newer.length > 0) {
    return { ok: false, error: "A newer plan replaced this one — undo that first.", status: 409 };
  }

  const created = Array.isArray(meta.created) ? (meta.created as unknown[]).filter((id): id is string => typeof id === "string") : [];
  if (created.length > 0) {
    const { error } = await supabase
      .from("plan_tasks")
      .delete()
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .in("id", created);
    if (error) return { ok: false, error: error.message, status: 500 };
  }
  const superseded = parseSuperseded(meta.superseded);
  if (superseded.length > 0) {
    const { error } = await supabase.from("plan_tasks").upsert(
      superseded.map((task) => ({ ...task, user_id: userId, workspace_id: workspaceId })),
      { onConflict: "id" },
    );
    if (error) return { ok: false, error: error.message, status: 500 };
  }
  const sessionId = typeof meta.session_id === "string" ? meta.session_id : null;
  if (sessionId) {
    // The new plan is dropped: chat context and carry-over stop counting it.
    await supabase
      .from("plan_sessions")
      .update({ status: "rejected" })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("status", "accepted");
  }
  await recordUndo(scope, replacementId, date, record.entity_id);
  return { ok: true, date };
}

// ---------------------------------------------------------------------------
// Replan the rest of today
// ---------------------------------------------------------------------------

export interface ReplanOutcome {
  ok: true;
  replacementId: string | null;
  result: ReplanResult;
  /** Habits / tasks the user named that weren't on today's plan (recorded as missed). */
  missedOffPlan: NodeRef[];
  habitIds: Set<string>;
  startMinute: number;
  endMinute: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Today's plan again from now: unfinished tasks kept and re-timed, what the
 * user missed taken off (a habit recorded as missed, never done), ticked ones
 * left as they are. `missed` holds node ids or titles.
 */
export async function replanToday(
  scope: PlanScope,
  params: { today: string; nowMinute: number; startMinute?: number | null; missed?: string[] },
): Promise<ReplanOutcome | { ok: false; reason: "no_plan" | "error"; error: string }> {
  const { supabase, userId, workspaceId } = scope;
  const tasks = await loadDayTasks(scope, params.today);
  const open = tasks.filter((t) => !t.done && isPlanTask(t));

  // Nodes involved: today's plan + whatever the user said they missed.
  const refs = (params.missed ?? []).map((r) => String(r).trim()).filter(Boolean).slice(0, 8);
  const byTitle = (title: string) => open.find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
  const idRefs = new Set<string>();
  const titleRefs: string[] = [];
  for (const ref of refs) {
    const onPlan = open.find((t) => t.node_id === ref) ?? byTitle(ref);
    if (onPlan) idRefs.add(onPlan.node_id as string);
    else if (UUID_RE.test(ref)) idRefs.add(ref);
    else titleRefs.push(ref);
  }
  const ids = [...new Set([...open.map((t) => t.node_id as string), ...idRefs])];
  type NodeRow = { id: string; title: string; node_type: string; target_date: string | null };
  const nodes = new Map<string, NodeRow>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("nodes")
      .select("id, title, node_type, target_date")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .in("id", ids);
    for (const n of (data ?? []) as NodeRow[]) nodes.set(n.id, n);
  }
  for (const title of titleRefs.slice(0, 4)) {
    const { data } = await supabase
      .from("nodes")
      .select("id, title, node_type, target_date")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .neq("status", "archived")
      .ilike("title", title.replace(/[%_]/g, ""))
      .limit(1);
    const found = ((data ?? []) as NodeRow[])[0];
    if (found) {
      nodes.set(found.id, found);
      idRefs.add(found.id);
    }
  }
  const missedIds = new Set([...idRefs].filter((id) => nodes.has(id) || open.some((t) => t.node_id === id)));

  if (open.length === 0 && missedIds.size === 0) {
    return { ok: false, reason: "no_plan", error: "Today has no plan yet." };
  }

  const commitments = await loadActiveCommitments(supabase, userId, params.today);
  // Busy: fixed commitments, and the user's own timed tasks still to do.
  const ownTasks = tasks.flatMap((t) => {
    const start = clockToMinutes(t.start_time);
    return !isPlanTask(t) && !t.done && start !== null
      ? [{ start, end: start + (t.duration_minutes && t.duration_minutes > 0 ? t.duration_minutes : 30) }]
      : [];
  });
  const startMinute = params.startMinute ?? replanStartMinute(params.nowMinute);
  const endMinute = Math.min(24 * 60, startMinute + dayPlanMinutes(startMinute));
  const result = replanRestOfDay({
    tasks: open,
    date: params.today,
    startMinute,
    endMinute,
    busy: [...busyOn(commitments, params.today), ...ownTasks],
    missedNodeIds: missedIds,
    datedNodeIds: new Set([...nodes.values()].filter((n) => n.target_date).map((n) => n.id)),
  });

  const habitIds = new Set([...nodes.values()].filter((n) => n.node_type === "habit").map((n) => n.id));
  const ref = (t: DayPlanTask): NodeRef => ({ node_id: t.node_id as string, title: t.title });
  const missedOffPlan = [...missedIds]
    .filter((id) => !open.some((t) => t.node_id === id))
    .map((id) => ({ node_id: id, title: nodes.get(id)?.title ?? "" }));
  // Skips feed the stale check, which leaves habits alone (lib/planner/skips.ts).
  const skipped = [
    ...pastUnfinished(open, params.today, params.today, params.nowMinute),
    ...result.missed,
    ...result.didntFit,
  ]
    .filter((t) => !habitIds.has(t.node_id as string))
    .map(ref);
  const missedHabits = [
    ...result.missed.filter((t) => habitIds.has(t.node_id as string)).map(ref),
    ...missedOffPlan.filter((r) => habitIds.has(r.node_id)),
  ];

  const committed = await commitDayPlan(scope, {
    date: params.today,
    kind: "replan",
    superseded: open,
    tasks: result.placed.map(({ task, start, minutes }) => ({
      title: task.title,
      node_id: task.node_id,
      start_time: minutesToClock(start),
      duration_minutes: minutes,
    })),
    skipped,
    missed: missedHabits,
  });
  if (!committed.ok) return { ok: false, reason: "error", error: committed.error };
  return {
    ok: true,
    replacementId: committed.replacementId,
    result,
    missedOffPlan,
    habitIds,
    startMinute,
    endMinute,
  };
}

/** The replan as card rows (lib/chat/applied-marker AppliedMarkerPayload["applied"]). */
export function replanCardRows(outcome: ReplanOutcome) {
  const rows: Array<{
    node_id: string;
    title: string;
    action: string;
    detail: string;
    score_before: null;
    score_after: null;
  }> = [];
  const row = (node_id: string, title: string, action: string, detail: string) =>
    rows.push({ node_id, title, action, detail, score_before: null, score_after: null });
  for (const { task, start, minutes } of outcome.result.placed) {
    const was = clockToMinutes(task.start_time);
    const span = `${minutesToClock(start)}–${minutesToClock(start + minutes)}`;
    row(task.node_id as string, task.title, was === start ? "kept" : "moved", was === null || was === start ? span : `${span} (was ${minutesToClock(was)})`);
  }
  for (const task of outcome.result.missed) {
    const habit = outcome.habitIds.has(task.node_id as string);
    row(task.node_id as string, task.title, "missed", habit ? "Missed today — not marked done" : "Off today's plan");
  }
  for (const ref of outcome.missedOffPlan) {
    if (outcome.habitIds.has(ref.node_id)) row(ref.node_id, ref.title, "missed", "Missed today — not marked done");
  }
  for (const task of outcome.result.didntFit) {
    row(task.node_id as string, task.title, "unplanned", `Didn't fit before ${minutesToClock(outcome.endMinute)}`);
  }
  return rows;
}
