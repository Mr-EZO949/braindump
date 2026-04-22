// GET /api/dev/scoring-diagnose?workspace_id=...
// Dev-only diagnostic. Returns:
//   - Score distribution histogram for the workspace
//   - Top 20 nodes with full signal breakdown
//   - Bottom 10 active nodes (to see what's being suppressed)
// Used to eyeball whether the heuristic scorer produces sensible rankings
// before layering AI on top.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production" }, { status: 404 });
  }

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let workspaceId = req.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) {
    const { data: workspaces } = await supabase
      .from("workspaces")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1);
    workspaceId = workspaces?.[0]?.id ?? null;
    if (!workspaceId) {
      return NextResponse.json({ error: "No workspace found" }, { status: 404 });
    }
  }

  const { data: nodes } = await supabase
    .from("nodes")
    .select(
      "id, title, node_type, status, importance, importance_index, current_importance_score, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .neq("status", "archived")
    .order("current_importance_score", { ascending: false });

  if (!nodes || nodes.length === 0) {
    return NextResponse.json({ error: "No nodes in workspace" }, { status: 404 });
  }

  const nodeIds = nodes.map((n) => n.id as string);

  const { data: scores } = await supabase
    .from("node_scores")
    .select(
      "node_id, urgency_score, goal_alignment_score, planner_score, recency_score, graph_centrality_score, user_confirmation_score, ai_prior_score, blocker_resolved_bonus, final_score, computed_at",
    )
    .in("node_id", nodeIds)
    .order("computed_at", { ascending: false });

  type ScoreRow = NonNullable<typeof scores>[number];
  const latestScoreByNode = new Map<string, ScoreRow>();
  for (const row of scores ?? []) {
    if (!latestScoreByNode.has(row.node_id as string)) {
      latestScoreByNode.set(row.node_id as string, row);
    }
  }

  const { count: edgeCount } = await supabase
    .from("edges")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .neq("status", "orphaned");

  const activeNodes = nodes.filter((n) => n.status !== "completed");
  const scoresOnly = activeNodes
    .map((n) => n.current_importance_score as number | null)
    .filter((s): s is number => typeof s === "number");

  const buckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 10}-${i * 10 + 10}`,
    count: 0,
  }));
  for (const s of scoresOnly) {
    const idx = Math.min(9, Math.floor(s / 10));
    buckets[idx].count += 1;
  }

  const sorted = [...scoresOnly].sort((a, b) => a - b);
  const stats = sorted.length
    ? {
        min: sorted[0],
        p10: sorted[Math.floor(sorted.length * 0.1)],
        p25: sorted[Math.floor(sorted.length * 0.25)],
        median: sorted[Math.floor(sorted.length * 0.5)],
        p75: sorted[Math.floor(sorted.length * 0.75)],
        p90: sorted[Math.floor(sorted.length * 0.9)],
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        count: sorted.length,
      }
    : null;

  const enrichedNodes = nodes.map((n) => {
    const s = latestScoreByNode.get(n.id as string);
    return {
      id: n.id,
      title: n.title,
      node_type: n.node_type,
      status: n.status,
      importance: n.importance,
      current_importance_score: n.current_importance_score,
      signals: s
        ? {
            urgency: Number(s.urgency_score),
            goal_alignment: Number(s.goal_alignment_score),
            planner: Number(s.planner_score),
            recency: Number(s.recency_score),
            centrality: Number(s.graph_centrality_score),
            user_confirmation: Number(s.user_confirmation_score),
            ai_prior: Number(s.ai_prior_score),
            blocker_resolved_bonus: Number(s.blocker_resolved_bonus),
            final_score: Number(s.final_score),
            computed_at: s.computed_at,
          }
        : null,
    };
  });

  const top20 = enrichedNodes
    .filter((n) => n.status !== "completed")
    .slice(0, 20);
  const bottom10 = [...enrichedNodes]
    .filter((n) => n.status !== "completed")
    .reverse()
    .slice(0, 10);

  return NextResponse.json({
    workspace_id: workspaceId,
    totals: {
      nodes_all: nodes.length,
      nodes_active: activeNodes.length,
      edges_active: edgeCount ?? 0,
    },
    distribution: {
      histogram: buckets,
      stats,
    },
    top_20: top20,
    bottom_10: bottom10,
  });
}
