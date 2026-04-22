// GET /api/assistant/nudges?workspace_id=<id>
// Returns up to 4 "proactive prompts" the assistant can surface when the
// chat is empty — things the user likely wants to think about:
//   1. Recent completions (celebrate / reflect)
//   2. Overdue calendar tasks (reschedule or drop)
//   3. Quiet goals (active goals with no activity in ≥14 days)
//   4. Archived-node leftovers (recently archived nodes the user may want to reconsider)
//
// Each nudge carries a short `title` for the chip and a `starter` string
// that gets sent as the user's first message if they tap the chip.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { Nudge } from "@/types/chat";

const RECENT_COMPLETION_WINDOW_HOURS = 48;
const QUIET_GOAL_DAYS = 14;
const MAX_NUDGES = 4;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  const workspaceId = searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json({ error: "Missing 'workspace_id'" }, { status: 400 });
  }

  // Verify workspace ownership — cheap and prevents leaking other users' counts.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const nudges: Nudge[] = [];

  // 1. Recent completions in the last 48h
  const since = new Date(Date.now() - RECENT_COMPLETION_WINDOW_HOURS * 3600_000).toISOString();
  const { data: recentCompletions } = await supabase
    .from("lifecycle_events")
    .select("node_id, nodes!inner(workspace_id, title)")
    .eq("user_id", user.id)
    .eq("new_status", "completed")
    .gte("created_at", since)
    .eq("nodes.workspace_id", workspaceId)
    .limit(20);
  if (recentCompletions && recentCompletions.length > 0) {
    nudges.push({
      id: "nudge_recent_completions",
      kind: "recent_completions",
      count: recentCompletions.length,
      title:
        recentCompletions.length === 1
          ? "You completed 1 thing recently"
          : `You completed ${recentCompletions.length} things recently`,
      starter:
        "Walk me through what I finished in the last couple of days — which ones actually moved the needle and what's a natural next step?",
    });
  }

  // 2. Overdue plan_tasks (scheduled before today, not done)
  const { data: overdueTasks } = await supabase
    .from("plan_tasks")
    .select("id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .eq("done", false)
    .lt("scheduled_date", todayISO())
    .limit(20);
  if (overdueTasks && overdueTasks.length > 0) {
    nudges.push({
      id: "nudge_overdue_tasks",
      kind: "overdue_tasks",
      count: overdueTasks.length,
      title:
        overdueTasks.length === 1
          ? "You have 1 overdue task"
          : `You have ${overdueTasks.length} overdue tasks`,
      starter:
        "I've got some overdue tasks on my calendar. Help me triage — what should I reschedule, drop, or knock out first?",
    });
  }

  // 3. Quiet goals — active goals with updated_at > 14 days ago
  const quietCutoff = new Date(Date.now() - QUIET_GOAL_DAYS * 24 * 3600_000).toISOString();
  const { data: quietGoals } = await supabase
    .from("nodes")
    .select("id, title")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .eq("node_type", "goal")
    .eq("status", "active")
    .lt("updated_at", quietCutoff)
    .limit(5);
  if (quietGoals && quietGoals.length > 0) {
    nudges.push({
      id: "nudge_quiet_goals",
      kind: "quiet_goals",
      count: quietGoals.length,
      title:
        quietGoals.length === 1
          ? "1 goal has gone quiet"
          : `${quietGoals.length} goals have gone quiet`,
      starter:
        "Some of my active goals haven't seen any movement in a while. Can you surface them and help me figure out whether to re-engage, re-scope, or archive?",
    });
  }

  // 4. Recently archived nodes — sometimes these are the user questioning themselves
  const archiveSince = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: recentArchives } = await supabase
    .from("nodes")
    .select("id, title")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .eq("status", "archived")
    .gte("archived_at", archiveSince)
    .limit(5);
  if (recentArchives && recentArchives.length >= 3) {
    nudges.push({
      id: "nudge_recent_archives",
      kind: "recent_archives",
      count: recentArchives.length,
      title: `${recentArchives.length} nodes archived this week`,
      starter:
        "I archived a bunch of stuff this week. Can you look at what I let go of and tell me if you see a pattern worth noticing?",
    });
  }

  return NextResponse.json({ nudges: nudges.slice(0, MAX_NUDGES) });
}
