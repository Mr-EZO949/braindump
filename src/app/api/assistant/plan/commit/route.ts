// POST /api/assistant/plan/commit — the Planner's Accept writes a plan's tasks
// onto a day here (docs/replan.md). One plan per day: the old plan's
// unfinished tasks there — node-less blocks too — leave the day and the
// response carries the Undo handle ("back to the earlier plan"). Ticked tasks
// and hand-typed ones stay.
//
// Body: { workspace_id, date, tasks: [{ title, node_id, start_time, duration_minutes }],
//         session_id?, plan_end? ("HH:MM", where the new plan ends; omitted = end of day),
//         now_minute?, client_today? }

import { NextRequest, NextResponse } from "next/server";

import { commitDayPlan, loadDayTasks, loadPlanMadeIds, type NewPlanTask } from "@/lib/planner/plan-replace";
import { planRequest } from "@/lib/planner/plan-route-scope";
import { clockToMinutes, minutesToClock, pastUnfinished, supersededTasks } from "@/lib/planner/replan";
import { isISODate } from "@/lib/time/local-date";

const MAX_TASKS = 40;

function parseTasks(raw: unknown): NewPlanTask[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TASKS) return null;
  const tasks: NewPlanTask[] = [];
  for (const item of raw) {
    const row = (item ?? {}) as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim().slice(0, 200) : "";
    if (!title) return null;
    const start = clockToMinutes(typeof row.start_time === "string" ? row.start_time : null);
    const duration =
      typeof row.duration_minutes === "number" && Number.isFinite(row.duration_minutes)
        ? Math.max(5, Math.min(600, Math.round(row.duration_minutes)))
        : null;
    tasks.push({
      title,
      node_id: typeof row.node_id === "string" && row.node_id ? row.node_id : null,
      start_time: start === null ? null : minutesToClock(start),
      duration_minutes: duration,
    });
  }
  return tasks;
}

export async function POST(req: NextRequest) {
  const request = await planRequest(req);
  if (request instanceof NextResponse) return request;
  const { scope, body, today, nowMinute } = request;

  const date = body.date;
  if (!isISODate(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  const tasks = parseTasks(body.tasks);
  if (!tasks) return NextResponse.json({ error: "tasks must be a list of up to 40 tasks" }, { status: 400 });

  // Links only to this workspace's nodes; anything else becomes a plain task.
  const nodeIds = [...new Set(tasks.flatMap((t) => (t.node_id ? [t.node_id] : [])))];
  if (nodeIds.length > 0) {
    const { data } = await scope.supabase
      .from("nodes")
      .select("id")
      .eq("user_id", scope.userId)
      .eq("workspace_id", scope.workspaceId)
      .in("id", nodeIds);
    const owned = new Set(((data ?? []) as { id: string }[]).map((n) => n.id));
    for (const task of tasks) if (task.node_id && !owned.has(task.node_id)) task.node_id = null;
  }

  let sessionId: string | null = null;
  if (typeof body.session_id === "string" && body.session_id) {
    const { data } = await scope.supabase
      .from("plan_sessions")
      .select("id")
      .eq("id", body.session_id)
      .eq("user_id", scope.userId)
      .maybeSingle();
    sessionId = (data as { id: string } | null)?.id ?? null;
  }

  const planEnd = clockToMinutes(typeof body.plan_end === "string" ? body.plan_end : null);
  const [dayTasks, planMade] = await Promise.all([loadDayTasks(scope, date), loadPlanMadeIds(scope, date)]);
  const superseded = tasks.length > 0 ? supersededTasks(dayTasks, date, planEnd, planMade) : [];
  const skipped = pastUnfinished(superseded, date, today, nowMinute).map((t) => ({
    node_id: t.node_id as string,
    title: t.title,
  }));

  const result = await commitDayPlan(scope, { date, tasks, superseded, skipped, kind: "plan", sessionId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({
    tasks: result.inserted,
    replacement: result.replacementId ? { id: result.replacementId, replaced: result.replaced, date } : null,
  });
}
