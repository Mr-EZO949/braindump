// POST /api/assistant/top-now
// Returns the top 3 active nodes to focus on right now, using the same
// heuristic ranking as the planner but without any AI call. Cheap, instant,
// safe to invoke on-demand from a floating button.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildPlannerCandidates } from "@/lib/ai/planner";

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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { workspace_id, client_today, client_tz_offset } = body as {
    workspace_id?: string;
    client_today?: string;
    client_tz_offset?: number;
  };
  if (!workspace_id || typeof workspace_id !== "string") {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  const { candidates } = await buildPlannerCandidates({
    workspaceId: workspace_id,
    userId: user.id,
    supabase,
    clientToday: client_today,
    clientTzOffsetMinutes: client_tz_offset,
  });

  return NextResponse.json({
    top: candidates.slice(0, 3).map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      node_type: c.node_type,
      current_importance_score: c.current_importance_score,
      planning_signals: c.planning_signals,
      check_back: c.check_back ?? false,
    })),
  });
}
