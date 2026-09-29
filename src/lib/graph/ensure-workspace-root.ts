// Every workspace needs a root node to hang structure off.
//
// Without one, two things break silently and produce the "floating,
// unconnected, flat list" graph:
//   • runClusteringPass() bails at `if (!rootId) return []` — no auto-grouping
//     into subtrees, ever
//   • the accept path skips anchoring, so newly accepted nodes never get a
//     belongs_to edge and sit orphaned on the canvas
//
// The bootstrap wizard builds a rich root, but it is skippable, and workspace
// creation historically made none. This guarantees one exists. It is
// idempotent, so it never leaves a second, stray root behind.

import type { SupabaseClient } from "@supabase/supabase-js";

import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";

// Locked low (and pinned via manual_weight) so the root never dominates the
// canvas — its centrality approaches 1.0 once everything anchors to it, which
// would otherwise push it to the top of every workspace. Mirrors
// ROOT_IMPORTANCE in the bootstrap route.
export const ROOT_IMPORTANCE = 30;

export const ROOT_FALLBACK_TITLE = "My workspace";

export const ROOT_SUMMARY = "Everything in this workspace hangs off this anchor.";

/**
 * Returns the workspace's root node id, creating one if it's missing.
 * Returns null only if the workspace doesn't exist or the root can't be
 * persisted — callers should treat null as "skip anchoring", never as an id.
 */
export async function ensureWorkspaceRoot(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  const { supabase, userId, workspaceId } = params;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, bootstrap_root_node_id")
    .eq("id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!workspace) return null;

  // Reuse the existing root — but only if that node is actually still alive.
  // A deleted or archived root would otherwise keep clustering disabled
  // forever while the workspace still claims to have one.
  const existingId = workspace.bootstrap_root_node_id as string | null | undefined;
  if (existingId) {
    const { data: existing } = await supabase
      .from("nodes")
      .select("id")
      .eq("id", existingId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (existing) return existingId;
  }

  const title =
    ((workspace.name as string | null) ?? "").trim().slice(0, 80) || ROOT_FALLBACK_TITLE;

  const { data: created, error: insertError } = await supabase
    .from("nodes")
    .insert({
      user_id: userId,
      workspace_id: workspaceId,
      title,
      summary: ROOT_SUMMARY,
      raw_text: null,
      // The root is the user's whole life, never a goal (node types v2).
      node_type: "area",
      importance: getImportanceLabel(ROOT_IMPORTANCE),
      importance_index: ROOT_IMPORTANCE,
      manual_weight: ROOT_IMPORTANCE,
      manual_weight_set_at: new Date().toISOString(),
      color: NODE_COLOR_BY_TYPE.area,
      status: "active",
    })
    .select("id")
    .single();
  if (insertError || !created) return null;

  const rootId = created.id as string;

  const { error: pointError } = await supabase
    .from("workspaces")
    .update({ bootstrap_root_node_id: rootId })
    .eq("id", workspaceId)
    .eq("user_id", userId);

  if (pointError) {
    // Never leave a root the workspace doesn't point at — it would show up as
    // a stray node on the canvas and still not enable clustering.
    await supabase.from("nodes").delete().eq("id", rootId).eq("user_id", userId);
    return null;
  }

  return rootId;
}
