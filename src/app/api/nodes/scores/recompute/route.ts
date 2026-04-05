// POST /api/nodes/scores/recompute
// Recomputes importance scores for all active nodes in a workspace.
// Writes to node_scores table and materializes final_score onto nodes.current_importance_score.
// Called automatically after node/edge acceptance and status changes.
// This endpoint queues the full workspace rescore so maintenance work stays off the request path.

import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { drainAIJobsWithAdminClient, enqueueAIJob } from "@/lib/ai/jobs";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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

  const job = await enqueueAIJob({
    supabase,
    userId: user.id,
    workspaceId: workspace_id,
    jobType: "score_recompute",
    payload: {
      workspace_id,
    },
  });

  after(async () => {
    try {
      await drainAIJobsWithAdminClient();
    } catch (error) {
      console.error("[api/nodes/scores/recompute] failed to drain AI jobs:", error);
    }
  });

  return NextResponse.json({
    queued: true,
    job_id: job.id,
    job_status: job.status,
  });
}
