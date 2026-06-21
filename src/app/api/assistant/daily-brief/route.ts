// POST /api/assistant/daily-brief
// One-shot endpoint that returns everything the news-style daily brief needs:
//   - top: top-3 priority nodes (same as /top-now)
//   - nudges: proactive prompts (same shape as /nudges)
//   - today_schedule: plan_tasks scheduled for today
//   - yesterday_wins: nodes completed in the last 24h
//   - weekly_pulse: rolling 7-day stats (completed, created, scheduled, rate)
//   - headline: 1-2 sentence AI debrief on the morning
//
// Single endpoint avoids the 2-3 round trips the old DailyBriefOverlay was
// doing. Headline runs on Haiku — ~$0.001/call, fires once per user per day.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildPlannerCandidates } from "@/lib/ai/planner";
import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";
import type { Nudge } from "@/types/chat";

const RECENT_COMPLETION_WINDOW_HOURS = 24;
const QUIET_GOAL_DAYS = 14;
const MAX_NUDGES = 4;
const PULSE_DAYS = 7;
const MAX_TODAY_SCHEDULE = 8;
const MAX_YESTERDAY_WINS = 5;

function todayISO(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function dateNDaysAgoISO(days: number, now = new Date()): string {
  const d = new Date(now);
  d.setDate(now.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Returns the ISO date of this calendar week's Monday (UTC).
// Used as the lower bound for the weekly completion-rate window — the rate
// resets every Monday rather than rolling 7 days.
//
// All date math here uses UTC for consistency with `todayISO`. There's a
// small TZ-fuzzy band near midnight where a user's local "today" doesn't
// match the server's UTC "today" — acceptable for this metric.
function thisWeekMondayISO(now = new Date()): string {
  const d = new Date(now);
  // Sunday=0, Mon=1 ... Sat=6 → days to subtract to land on Monday
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function generateHeadline(stats: {
  topTitle: string | null;
  scheduledToday: number;
  yesterdayWins: number;
  weeklyCompleted: number;
  weeklyRate: number | null;
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const ratePart =
    stats.weeklyRate !== null ? ` (${Math.round(stats.weeklyRate * 100)}% completion rate this week)` : "";

  const prompt = `Write a 1-2 sentence morning brief for a user opening their planning app. Plain text, no markdown, no greetings. Stats:
- Top focus right now: ${stats.topTitle ?? "nothing active"}
- Tasks scheduled for today: ${stats.scheduledToday}
- Things completed yesterday: ${stats.yesterdayWins}
- This week so far: ${stats.weeklyCompleted} completions${ratePart}

Tone: a sharp morning anchor — observational, specific, brief. Reference one concrete thing from the stats. Don't be saccharine. End with momentum, not advice.`;

  try {
    const client = new Anthropic({ apiKey });
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 160,
      temperature: AI_TEMPERATURE.ASSISTANT,
      system:
        "You are a daily brief writer. Be direct, specific, and brief. Never use markdown. Never use bullet points. Maximum 2 sentences.",
      messages: [{ role: "user", content: prompt }],
    });
    const block = r.content[0];
    return block?.type === "text" ? block.text.trim() : null;
  } catch (err) {
    console.error("[daily-brief] headline generation failed", err);
    return null;
  }
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

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const today = todayISO();
  const sinceCompletionsISO = new Date(
    Date.now() - RECENT_COMPLETION_WINDOW_HOURS * 3600_000,
  ).toISOString();
  const weekStartISO = dateNDaysAgoISO(PULSE_DAYS - 1);
  // Plan rate window: this calendar week (Monday → today, exclusive of today).
  // Resets every Monday. Today's tasks are excluded so a still-pending task
  // scheduled for this morning doesn't drag the rate down.
  const planRateStartISO = thisWeekMondayISO();

  // Run independent reads in parallel — RLS already scopes them.
  const [
    plannerResult,
    todayScheduleResult,
    yesterdayCompletionsResult,
    weeklyCompletionsResult,
    weeklyCreationsResult,
    weeklyScheduledResult,
    overdueResult,
    quietGoalsResult,
  ] = await Promise.all([
    buildPlannerCandidates({
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
      clientToday: client_today,
      clientTzOffsetMinutes: client_tz_offset,
    }).catch(() => ({ candidates: [] })),

    supabase
      .from("plan_tasks")
      .select("id, title, start_time, duration_minutes, done, node_id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .eq("scheduled_date", today)
      .order("start_time", { ascending: true, nullsFirst: false })
      .limit(MAX_TODAY_SCHEDULE),

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
      .from("lifecycle_events")
      .select("id, nodes!inner(workspace_id)", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("new_status", "completed")
      .eq("nodes.workspace_id", workspace_id)
      .gte("created_at", `${weekStartISO}T00:00:00.000Z`),

    supabase
      .from("nodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .gte("created_at", `${weekStartISO}T00:00:00.000Z`),

    // Plan-rate query: tasks scheduled this calendar week (Mon → today),
    // EXCLUDING today (incomplete tasks for today shouldn't count yet).
    supabase
      .from("plan_tasks")
      .select("done")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .gte("scheduled_date", planRateStartISO)
      .lt("scheduled_date", today),

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

  // ── top focus ────────────────────────────────────────────────────────────
  const top = plannerResult.candidates.slice(0, 3).map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    node_type: c.node_type,
    current_importance_score: c.current_importance_score,
    planning_signals: c.planning_signals,
  }));

  // ── today's schedule ─────────────────────────────────────────────────────
  const today_schedule = (todayScheduleResult.data ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    start_time: row.start_time as string | null,
    duration_minutes: row.duration_minutes as number | null,
    done: row.done as boolean,
    node_id: row.node_id as string | null,
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

  // ── weekly pulse ─────────────────────────────────────────────────────────
  const weekly_completed = weeklyCompletionsResult.count ?? 0;
  const weekly_created = weeklyCreationsResult.count ?? 0;
  const weekly_scheduled_rows = weeklyScheduledResult.data ?? [];
  const weekly_scheduled = weekly_scheduled_rows.length;
  const weekly_scheduled_done = weekly_scheduled_rows.filter((r) => r.done).length;
  const weekly_completion_rate =
    weekly_scheduled > 0 ? weekly_scheduled_done / weekly_scheduled : null;

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

  // ── AI headline ──────────────────────────────────────────────────────────
  const headline = await generateHeadline({
    topTitle: top[0]?.title ?? null,
    scheduledToday: today_schedule.length,
    yesterdayWins: yesterday_wins.length,
    weeklyCompleted: weekly_completed,
    weeklyRate: weekly_completion_rate,
  });

  return NextResponse.json({
    headline,
    top,
    today_schedule,
    yesterday_wins,
    weekly_pulse: {
      completed: weekly_completed,
      created: weekly_created,
      scheduled: weekly_scheduled,
      scheduled_done: weekly_scheduled_done,
      completion_rate: weekly_completion_rate,
    },
    nudges: nudges.slice(0, MAX_NUDGES),
  });
}
