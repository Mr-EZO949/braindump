// POST /api/assistant/daily-brief
// One-shot endpoint that returns everything the news-style daily brief needs:
//   - top: top-3 priority nodes (same as /top-now)
//   - nudges: proactive prompts (same shape as /nudges)
//   - yesterday_wins: nodes completed in the last 24h
//   - headline: always null (the Focus redesign dropped it; kept for shape)
//
// Single endpoint avoids the 2-3 round trips the old DailyBriefOverlay was
// doing. NO AI runs here — everything is SQL, so opening Focus costs $0.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildPlannerCandidates } from "@/lib/ai/planner";
import type { Nudge } from "@/types/chat";
import { isISODate } from "@/lib/time/local-date";
import { getRequestToday } from "@/lib/time/request-date";

const RECENT_COMPLETION_WINDOW_HOURS = 24;
const QUIET_GOAL_DAYS = 14;
const MAX_NUDGES = 4;
const MAX_YESTERDAY_WINS = 5;


function dateNDaysAgoISO(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setDate(now.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspace_id, client_today, client_tz_offset } = body as {
    workspace_id?: string;
    client_today?: string;
    client_tz_offset?: number;
  };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  // The user's local date: prefer what the client sent, else the bd_tz
  // cookie — never the server's UTC date (overdue tasks were off by a day).
  const today = isISODate(client_today) ? client_today : await getRequestToday();
  const sinceCompletionsISO = new Date(
    Date.now() - RECENT_COMPLETION_WINDOW_HOURS * 3600_000,
  ).toISOString();

  // Only fetch data rendered in the Focus dialog. The previous response also
  // loaded today's schedule and weekly statistics, which this dialog no
  // longer uses. The ownership check rides in the same round trip — every
  // query here is read-only and scoped to this user.
  const [
    { data: workspace },
    plannerResult,
    yesterdayCompletionsResult,
    overdueResult,
    quietGoalsResult,
  ] = await Promise.all([
    supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspace_id)
      .eq("user_id", user.id)
      .maybeSingle(),

    buildPlannerCandidates({
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
      clientToday: client_today,
      clientTzOffsetMinutes: client_tz_offset,
      // A short gap before a class → what fits it leads (docs/commitments.md).
      fitToFreeTime: true,
    }).catch(() => ({ candidates: [], busy_today: [] })),

    supabase
      .from("lifecycle_events")
      .select("created_at, node_id, nodes!inner(workspace_id, title, node_type)")
      .eq("user_id", user.id)
      .eq("new_status", "completed")
      .eq("nodes.workspace_id", workspace_id)
      .gte("created_at", sinceCompletionsISO)
      .order("created_at", { ascending: false })
      .limit(MAX_YESTERDAY_WINS),

    supabase
      .from("plan_tasks")
      .select("id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .eq("done", false)
      .lt("scheduled_date", today)
      .limit(20),

    supabase
      .from("nodes")
      .select("id, title")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .eq("node_type", "goal")
      .eq("status", "active")
      .lt("updated_at", dateNDaysAgoISO(QUIET_GOAL_DAYS) + "T00:00:00.000Z")
      .order("updated_at", { ascending: true })
      .limit(3),
  ]);

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // ── top focus ────────────────────────────────────────────────────────────
  const top = plannerResult.candidates.slice(0, 3).map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    node_type: c.node_type,
    current_importance_score: c.current_importance_score,
    planning_signals: c.planning_signals,
    check_back: c.check_back ?? false,
  }));

  // ── yesterday wins ───────────────────────────────────────────────────────
  const yesterday_wins = (yesterdayCompletionsResult.data ?? [])
    .map((row) => {
      const nodes = row.nodes as
        | { title?: string; node_type?: string }
        | { title?: string; node_type?: string }[]
        | null;
      const node = Array.isArray(nodes) ? nodes[0] : nodes;
      if (!node?.title) return null;
      return {
        node_id: row.node_id as string,
        title: node.title,
        node_type: (node.node_type as string | undefined) ?? "task",
        completed_at: row.created_at as string,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // ── nudges ───────────────────────────────────────────────────────────────
  const nudges: Nudge[] = [];

  if (yesterday_wins.length > 0) {
    nudges.push({
      id: "nudge_recent_completions",
      kind: "recent_completions",
      count: yesterday_wins.length,
      title:
        yesterday_wins.length === 1
          ? "You shipped 1 thing in the last 24h"
          : `You shipped ${yesterday_wins.length} things in the last 24h`,
      starter:
        "Walk me through what I finished — which ones actually moved the needle and what's a natural next step?",
    });
  }

  const overdueCount = (overdueResult.data ?? []).length;
  if (overdueCount > 0) {
    nudges.push({
      id: "nudge_overdue",
      kind: "overdue_tasks",
      count: overdueCount,
      title:
        overdueCount === 1
          ? "1 scheduled task slipped past its date"
          : `${overdueCount} scheduled tasks slipped past their dates`,
      starter:
        "I have overdue scheduled tasks. Help me triage — which to reschedule, which to drop, which still matter.",
    });
  }

  const quietGoals = quietGoalsResult.data ?? [];
  if (quietGoals.length > 0) {
    nudges.push({
      id: "nudge_quiet_goals",
      kind: "quiet_goals",
      count: quietGoals.length,
      title:
        quietGoals.length === 1
          ? `"${quietGoals[0].title}" has been quiet for 2+ weeks`
          : `${quietGoals.length} goals have been quiet for 2+ weeks`,
      starter:
        "Some of my goals haven't moved in a while. Help me decide if they're still worth pursuing or should be archived.",
    });
  }

  // No AI headline: the Focus redesign no longer displays it, so generating one
  // per open was pure wasted token spend. Focus-open is now $0 (all SQL).
  return NextResponse.json({
    headline: null,
    top,
    yesterday_wins,
    nudges: nudges.slice(0, MAX_NUDGES),
    // Fixed commitments: today's busy time — Focus computes its "45 min free ·
    // Stats at 14:00" line from it on the clock, and "Plan my day" skips it
    // (docs/commitments.md).
    busy_today: plannerResult.busy_today,
  });
}
