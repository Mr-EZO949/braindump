// POST /api/nodes/scores/recompute
// Recomputes importance scores for all active nodes in a workspace.
// Writes to node_scores table and materializes final_score onto nodes.current_importance_score.
// Called automatically after node/edge acceptance and status changes.
// Can also be called manually (e.g., from a settings panel) to force a full rescore.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { computeWorkspaceScores } from "@/lib/ai/scoring";

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

  const { workspace_id } = body as { workspace_id: string };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const result = await computeWorkspaceScores({
    workspaceId: workspace_id,
    userId: user.id,
    supabase,
  });

  return NextResponse.json(result);
}
