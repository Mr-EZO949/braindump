// GET /api/cron/node-cleanup
// Nightly cron that permanently deletes stale completed and archived nodes,
// then rescores workspaces whose ranking depends on the date (ranking v2).
//
// Triggered by Vercel Cron (see vercel.json). Vercel automatically passes
// Authorization: Bearer <CRON_SECRET> on every scheduled call.
//
// All FK-cascaded child rows are removed by the database:
//   edges, node_embeddings, lifecycle_events, lifecycle_cascade_effects,
//   node_importance_scores, merge_suggestions, proposed_edges.
// Rows with ON DELETE SET NULL (plan_blocks.node_id etc.) are nulled automatically.

import { type NextRequest, NextResponse } from "next/server";

import { AI_LIFECYCLE } from "@/lib/ai/config";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// Deadline pressure, check-back dates and decaying "focus on X" move with the
// calendar even when nobody touches the graph, so their workspaces rescore
// nightly (ranking v2). Deterministic — no model calls.
async function refreshTimeSensitiveScores(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  now: number,
): Promise<{ workspaces: number; failed: number }> {
  const steerSince = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [dated, steered] = await Promise.all([
    supabase
      .from("nodes")
      .select("workspace_id, user_id")
      .in("status", ["active", "paused"])
      .or("target_date.not.is.null,resume_on.not.is.null"),
    supabase
      .from("feedback_events")
      .select("workspace_id, user_id")
      .in("event_type", ["boost_node", "demote_node"])
      .gte("created_at", steerSince),
  ]);
  const targets = new Map<string, string>();
  for (const row of [...(dated.data ?? []), ...(steered.data ?? [])] as Array<{
    workspace_id: string | null;
    user_id: string | null;
  }>) {
    if (row.workspace_id && row.user_id) targets.set(row.workspace_id, row.user_id);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  let failed = 0;
  // Sequential on purpose: a handful of cheap DB round trips per workspace,
  // and no reason to burst the database at 3am.
  for (const [workspaceId, userId] of targets) {
    try {
      await computeWorkspaceScores({ workspaceId, userId, supabase, today });
    } catch (error) {
      failed++;
      console.error("[cron/node-cleanup] rescore failed:", workspaceId, error);
    }
  }
  return { workspaces: targets.size, failed };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const now = Date.now();

  const completedCutoff = new Date(
    now - AI_LIFECYCLE.COMPLETED_DELETE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const archivedCutoff = new Date(
    now - AI_LIFECYCLE.ARCHIVED_DELETE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Delete completed nodes whose completed_at has passed the retention window.
  const { count: completedDeleted, error: completedError } = await supabase
    .from("nodes")
    .delete({ count: "exact" })
    .eq("status", "completed")
    .lt("completed_at", completedCutoff);

  if (completedError) {
    console.error("[cron/node-cleanup] completed delete failed:", completedError.message);
  }

  // Delete archived nodes whose archived_at has passed the retention window.
  const { count: archivedDeleted, error: archivedError } = await supabase
    .from("nodes")
    .delete({ count: "exact" })
    .eq("status", "archived")
    .lt("archived_at", archivedCutoff);

  if (archivedError) {
    console.error("[cron/node-cleanup] archived delete failed:", archivedError.message);
  }

  const rescored = await refreshTimeSensitiveScores(supabase, now).catch((error: unknown) => {
    console.error("[cron/node-cleanup] rescore pass failed:", error);
    return { workspaces: 0, failed: -1 };
  });

  const result = {
    ok: !completedError && !archivedError,
    rescored_workspaces: rescored.workspaces,
    rescore_failures: rescored.failed,
    completed_deleted: completedDeleted ?? 0,
    archived_deleted: archivedDeleted ?? 0,
    completed_cutoff: completedCutoff,
    archived_cutoff: archivedCutoff,
    ran_at: new Date(now).toISOString(),
  };

  console.log("[cron/node-cleanup]", result);

  return NextResponse.json(result, {
    status: completedError ?? archivedError ? 207 : 200,
  });
}
