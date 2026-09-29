// GET  /api/habits/:nodeId — returns last N days of completions + streak
// POST /api/habits/:nodeId — body { date: "YYYY-MM-DD" } marks that date done
// DELETE /api/habits/:nodeId?date=YYYY-MM-DD — undoes that date
//
// All three require the node to be habit-typed and owned by the auth user.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { computeStreak, lastNDays } from "@/lib/habits/streak";
import { getRequestToday } from "@/lib/time/request-date";

const HISTORY_DAYS_DEFAULT = 30;
const HISTORY_DAYS_MAX = 365;
const ALLOWED_BACKFILL_DAYS = 1; // user can mark today + yesterday only

function isISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function dateMinusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function loadHabitNode(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  nodeId: string,
  userId: string,
) {
  // Try with habit_started_on first. If the column doesn't exist yet
  // (Postgres error 42703 — undefined_column) the migration hasn't been
  // run; fall back to the base columns so the app keeps working.
  const primary = await supabase
    .from("nodes")
    .select("id, user_id, node_type, habit_started_on")
    .eq("id", nodeId)
    .eq("user_id", userId)
    .maybeSingle();

  if (primary.error && primary.error.code === "42703") {
    const fallback = await supabase
      .from("nodes")
      .select("id, user_id, node_type")
      .eq("id", nodeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!fallback.data) return null;
    return { ...fallback.data, habit_started_on: null as string | null };
  }

  return primary.data;
}

// ?days=N (clamped); the Habits view and the Details streak ask for 90 so a
// tick's response doesn't shrink the history they already show.
function parseDays(searchParams: URLSearchParams): number {
  const daysParam = parseInt(searchParams.get("days") ?? "", 10);
  return Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(daysParam, HISTORY_DAYS_MAX)
    : HISTORY_DAYS_DEFAULT;
}

async function buildResponse(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  nodeId: string,
  userId: string,
  todayISO: string,
  days: number,
  startedOn: string | null = null,
) {
  const since = dateMinusDaysISO(todayISO, days);
  const [completionsRes, nodeRes] = await Promise.all([
    supabase
      .from("habit_completions")
      .select("completed_on, source")
      .eq("node_id", nodeId)
      .eq("user_id", userId)
      .gte("completed_on", since)
      .order("completed_on", { ascending: false }),
    supabase
      .from("nodes")
      .select("habit_target_per_week")
      .eq("id", nodeId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const dates = (completionsRes.data ?? []).map((r) => r.completed_on as string);
  const streak = computeStreak(dates, todayISO);
  const history = lastNDays(dates, todayISO, days);
  // target_per_week may be absent on un-migrated DBs → null (graceful).
  const targetPerWeek =
    (nodeRes.data as { habit_target_per_week?: number | null } | null)
      ?.habit_target_per_week ?? null;
  return { streak, history, started_on: startedOn, target_per_week: targetPerWeek };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  const { nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  // The user's local date (bd_tz cookie), not the server's UTC date — a
  // "today" off by one broke streaks and rejected ticks after local midnight.
  const todayISO = searchParams.get("today") ?? (await getRequestToday());
  const validToday = isISODate(todayISO);
  const days = parseDays(searchParams);

  // The ownership/type check and the history read go out together (one round
  // trip, not two); the history is discarded if the check fails. Both queries
  // are scoped to this user.
  const [node, payload] = await Promise.all([
    loadHabitNode(supabase, nodeId, user.id),
    validToday ? buildResponse(supabase, nodeId, user.id, todayISO, days) : null,
  ]);
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }
  if (node.node_type !== "habit") {
    return NextResponse.json({ error: "Not a habit node" }, { status: 400 });
  }
  if (!payload) {
    return NextResponse.json({ error: "Invalid 'today' parameter" }, { status: 400 });
  }

  return NextResponse.json({
    ...payload,
    started_on: (node as { habit_started_on?: string | null }).habit_started_on ?? null,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  const { nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const node = await loadHabitNode(supabase, nodeId, user.id);
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }
  if (node.node_type !== "habit") {
    return NextResponse.json({ error: "Not a habit node" }, { status: 400 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults to today
  }
  const requestedDate = (body as { date?: unknown })?.date;
  const todayISO = await getRequestToday();
  const dateToMark = isISODate(requestedDate) ? requestedDate : todayISO;

  // Only allow today and yesterday — backfill any further breaks the
  // honesty of streaks. Users can override by passing a custom client TZ
  // via `today=` on GET; that doesn't affect this validation.
  const earliest = dateMinusDaysISO(todayISO, ALLOWED_BACKFILL_DAYS);
  if (dateToMark < earliest || dateToMark > todayISO) {
    return NextResponse.json(
      { error: `Date out of range. Allowed: ${earliest} to ${todayISO}` },
      { status: 400 },
    );
  }

  // Idempotent insert: the unique constraint on (node_id, completed_on)
  // means re-tapping the same day is a no-op. We swallow the duplicate
  // error rather than return 409 so the UI just feels "already done".
  const { error: insertError } = await supabase.from("habit_completions").insert({
    user_id: user.id,
    node_id: nodeId,
    completed_on: dateToMark,
    source: "manual",
  });
  // Postgres unique-violation code is 23505. Anything else surfaces as 500.
  if (insertError && insertError.code !== "23505") {
    console.error("[habits] insert failed", insertError);
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // Cascade to plan_tasks scheduled for that date — keeps habits ↔ planner
  // in sync. A habit ticked off in the calendar should check off the
  // matching planner row, and vice-versa via the status route. Independent of
  // the history read, so both go out together.
  const [{ data: doneTasks }, payload] = await Promise.all([
    supabase
      .from("plan_tasks")
      .update({ done: true })
      .eq("user_id", user.id)
      .eq("node_id", nodeId)
      .eq("scheduled_date", dateToMark)
      .eq("done", false)
      .select("id"),
    buildResponse(
      supabase,
      nodeId,
      user.id,
      todayISO,
      parseDays(new URL(req.url).searchParams),
      (node as { habit_started_on?: string | null }).habit_started_on ?? null,
    ),
  ]);
  const updatedTaskIds = (doneTasks ?? []).map((row) => row.id as string);
  return NextResponse.json({ ...payload, updated_task_ids: updatedTaskIds });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  const { nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const node = await loadHabitNode(supabase, nodeId, user.id);
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }
  if (node.node_type !== "habit") {
    return NextResponse.json({ error: "Not a habit node" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date");
  const todayISO = await getRequestToday();
  const dateToDelete = isISODate(dateParam) ? dateParam : todayISO;

  await supabase
    .from("habit_completions")
    .delete()
    .eq("node_id", nodeId)
    .eq("user_id", user.id)
    .eq("completed_on", dateToDelete);

  // Reverse the planner cascade: any plan_task scheduled for that date and
  // linked to this habit gets un-marked (alongside the history read).
  const [{ data: reopenedTasks }, payload] = await Promise.all([
    supabase
      .from("plan_tasks")
      .update({ done: false })
      .eq("user_id", user.id)
      .eq("node_id", nodeId)
      .eq("scheduled_date", dateToDelete)
      .eq("done", true)
      .select("id"),
    buildResponse(
      supabase,
      nodeId,
      user.id,
      todayISO,
      parseDays(searchParams),
      (node as { habit_started_on?: string | null }).habit_started_on ?? null,
    ),
  ]);
  const updatedTaskIds = (reopenedTasks ?? []).map((row) => row.id as string);
  return NextResponse.json({ ...payload, updated_task_ids: updatedTaskIds });
}

// PATCH /api/habits/:nodeId — body { started_on: "YYYY-MM-DD" | null }
// Sets or clears the habit's per-user start date. Stats math anchors here.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  const { nodeId } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const node = await loadHabitNode(supabase, nodeId, user.id);
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }
  if (node.node_type !== "habit") {
    return NextResponse.json({ error: "Not a habit node" }, { status: 400 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const bodyObj = (body ?? {}) as {
    started_on?: unknown;
    target_per_week?: unknown;
  };
  const todayISO = await getRequestToday();
  const updates: Record<string, unknown> = {};

  // Effective habit_started_on — kept as-is unless this request changes it.
  let startedOn: string | null =
    (node as { habit_started_on?: string | null }).habit_started_on ?? null;

  if ("started_on" in bodyObj) {
    const requested = bodyObj.started_on;
    if (requested === null || requested === "") {
      startedOn = null;
    } else if (isISODate(requested)) {
      startedOn = requested;
    } else {
      return NextResponse.json(
        { error: "started_on must be YYYY-MM-DD or null" },
        { status: 400 },
      );
    }
    if (startedOn !== null && startedOn > todayISO) {
      return NextResponse.json(
        { error: "started_on cannot be in the future" },
        { status: 400 },
      );
    }
    updates.habit_started_on = startedOn;
  }

  if ("target_per_week" in bodyObj) {
    const t = bodyObj.target_per_week;
    if (t === null) {
      updates.habit_target_per_week = null;
    } else if (typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= 7) {
      updates.habit_target_per_week = t;
    } else {
      return NextResponse.json(
        { error: "target_per_week must be an integer 1–7 or null" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from("nodes")
    .update(updates)
    .eq("id", nodeId)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const payload = await buildResponse(
    supabase,
    nodeId,
    user.id,
    todayISO,
    parseDays(new URL(req.url).searchParams),
    startedOn,
  );
  return NextResponse.json(payload);
}
