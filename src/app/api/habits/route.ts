// GET /api/habits?ids=a,b,c&days=N — every listed habit's last N days of
// completions + streak, in ONE request (same shape per habit as
// GET /api/habits/:nodeId). The Habits view used to send one request per
// habit, each its own function call with its own auth check and two queries,
// so the done days filled in one habit at a time (owner, 2026-09-30).

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { computeStreak, lastNDays } from "@/lib/habits/streak";
import { addDaysISO, isISODate } from "@/lib/time/local-date";
import { getRequestToday } from "@/lib/time/request-date";

const HISTORY_DAYS_DEFAULT = 30;
const HISTORY_DAYS_MAX = 365;
const MAX_IDS = 100;
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req: NextRequest) {
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
  const ids = [...new Set((searchParams.get("ids") ?? "").split(",").filter((id) => UUID.test(id)))].slice(
    0,
    MAX_IDS,
  );
  if (ids.length === 0) return NextResponse.json({ habits: {} });

  const daysParam = parseInt(searchParams.get("days") ?? "", 10);
  const days =
    Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, HISTORY_DAYS_MAX) : HISTORY_DAYS_DEFAULT;
  // The user's local date (bd_tz cookie), not the server's UTC date.
  const todayISO = searchParams.get("today") ?? (await getRequestToday());
  if (!isISODate(todayISO)) {
    return NextResponse.json({ error: "Invalid 'today' parameter" }, { status: 400 });
  }

  // A response holds at most 1000 rows (PostgREST max-rows): one habit has at
  // most days + 1 in the window, so each completions read covers few enough.
  const perRead = Math.max(1, Math.floor(1000 / (days + 1)));
  const idChunks: string[][] = [];
  for (let i = 0; i < ids.length; i += perRead) idChunks.push(ids.slice(i, i + perRead));
  const since = addDaysISO(todayISO, -days);
  const [nodesRes, ...completionReads] = await Promise.all([
    supabase
      .from("nodes")
      .select("id, node_type, habit_started_on, habit_target_per_week")
      .eq("user_id", user.id)
      .in("id", ids),
    ...idChunks.map((chunk) =>
      supabase
        .from("habit_completions")
        .select("node_id, completed_on")
        .eq("user_id", user.id)
        .in("node_id", chunk)
        .gte("completed_on", since),
    ),
  ]);
  if (nodesRes.error || completionReads.some((read) => read.error)) {
    return NextResponse.json({ error: "Failed to load habits" }, { status: 500 });
  }

  const datesByNode = new Map<string, string[]>();
  const completionRows = completionReads.flatMap(
    (read) => (read.data ?? []) as Array<{ node_id: string; completed_on: string }>,
  );
  for (const row of completionRows) {
    const dates = datesByNode.get(row.node_id) ?? [];
    dates.push(row.completed_on);
    datesByNode.set(row.node_id, dates);
  }

  const habits: Record<string, unknown> = {};
  for (const node of (nodesRes.data ?? []) as Array<{
    id: string;
    node_type: string;
    habit_started_on: string | null;
    habit_target_per_week: number | null;
  }>) {
    if (node.node_type !== "habit") continue;
    const dates = datesByNode.get(node.id) ?? [];
    habits[node.id] = {
      streak: computeStreak(dates, todayISO),
      history: lastNDays(dates, todayISO, days),
      started_on: node.habit_started_on ?? null,
      target_per_week: node.habit_target_per_week ?? null,
    };
  }
  return NextResponse.json({ habits });
}
