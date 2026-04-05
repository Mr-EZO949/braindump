// GET /api/cron/node-cleanup
// Nightly cron that permanently deletes stale completed and archived nodes.
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
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

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

  const result = {
    ok: !completedError && !archivedError,
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
