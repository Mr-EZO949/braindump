// The one place that writes a node's PARENT.
//
// A parent is a `belongs_to` edge, child → parent, and a node has at most one
// live one (DB index idx_edges_single_parent). Layout, Todos, Roadmap, delete
// and the ranking all read that edge, so every write path — the change set
// (lib/graph/change-set.ts) and the review routes — goes through here instead
// of inserting edges itself.
//
// History (2026-09-30): chat used to insert `contains` edges (parent → child),
// which nothing treats as structure, and had no way to replace a parent — a
// re-parent hit the unique index and failed, and chat-created children floated
// until the connection engine guessed a parent for them.

import type { SupabaseClient } from "@supabase/supabase-js";

// Would making `newParentId` the parent of `nodeId` close a loop? True when
// the new parent is the node itself or sits anywhere below it.
export function wouldCreateCycle(
  parentByChild: Map<string, string>,
  nodeId: string,
  newParentId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = newParentId;
  while (current && !seen.has(current)) {
    if (current === nodeId) return true;
    seen.add(current);
    current = parentByChild.get(current);
  }
  return false;
}

export type SetParentResult =
  | {
      ok: true;
      // false when the node was already under that parent (nothing written).
      changed: boolean;
      nodeTitle: string;
      parentTitle: string;
      previousParentId: string | null;
      previousParentTitle: string | null;
    }
  | { ok: false; error: string };

interface ParentEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
}

// Puts `nodeId` under `parentId`, replacing whatever parent it had. Works for
// a brand-new node (no parent yet) and for a move.
export async function setNodeParent(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  nodeId: string;
  parentId: string;
  explanation?: string | null;
}): Promise<SetParentResult> {
  const { supabase, userId, workspaceId, nodeId, parentId } = params;
  if (!nodeId || !parentId) return { ok: false, error: "node and parent are required" };
  if (nodeId === parentId) return { ok: false, error: "a node can't be its own parent" };

  const [{ data: nodeRows }, { data: edgeRows }, { data: workspaceRow }] = await Promise.all([
    supabase
      .from("nodes")
      .select("id, title")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .in("id", [nodeId, parentId]),
    supabase
      .from("edges")
      .select("id, source_node_id, target_node_id")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .eq("edge_type", "belongs_to")
      .neq("status", "orphaned")
      .neq("status", "user_rejected"),
    supabase
      .from("workspaces")
      .select("bootstrap_root_node_id")
      .eq("id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const titleById = new Map(
    ((nodeRows ?? []) as Array<{ id: string; title: string }>).map((n) => [n.id, n.title]),
  );
  const nodeTitle = titleById.get(nodeId);
  const parentTitle = titleById.get(parentId);
  if (nodeTitle === undefined || parentTitle === undefined) {
    return { ok: false, error: "node or parent not found in this workspace" };
  }
  if ((workspaceRow?.bootstrap_root_node_id as string | null | undefined) === nodeId) {
    return { ok: false, error: `"${nodeTitle}" is the workspace root — it can't go under another node` };
  }

  const parentEdges = (edgeRows ?? []) as ParentEdgeRow[];
  const parentByChild = new Map(parentEdges.map((e) => [e.source_node_id, e.target_node_id]));
  const currentEdges = parentEdges.filter((e) => e.source_node_id === nodeId);
  const previousParentId = currentEdges[0]?.target_node_id ?? null;

  let previousParentTitle: string | null = null;
  if (previousParentId && previousParentId !== parentId) {
    const { data: previous } = await supabase
      .from("nodes")
      .select("title")
      .eq("id", previousParentId)
      .eq("user_id", userId)
      .maybeSingle();
    previousParentTitle = (previous?.title as string | undefined) ?? null;
  }

  if (previousParentId === parentId) {
    return {
      ok: true,
      changed: false,
      nodeTitle,
      parentTitle,
      previousParentId,
      previousParentTitle: parentTitle,
    };
  }

  if (wouldCreateCycle(parentByChild, nodeId, parentId)) {
    return {
      ok: false,
      error: `"${parentTitle}" sits under "${nodeTitle}" — moving it there would make a loop. Move "${parentTitle}" out first.`,
    };
  }

  const nowIso = new Date().toISOString();
  const previousEdgeIds = currentEdges.map((e) => e.id);
  if (previousEdgeIds.length > 0) {
    const { error: orphanErr } = await supabase
      .from("edges")
      .update({ status: "orphaned", updated_at: nowIso })
      .in("id", previousEdgeIds)
      .eq("user_id", userId);
    if (orphanErr) return { ok: false, error: `could not release the old parent: ${orphanErr.message}` };
  }

  const explanation =
    typeof params.explanation === "string" && params.explanation.trim().length > 0
      ? params.explanation.trim().slice(0, 1000)
      : null;
  const { error: insertErr } = await supabase.from("edges").insert({
    user_id: userId,
    workspace_id: workspaceId,
    source_node_id: nodeId,
    target_node_id: parentId,
    edge_type: "belongs_to",
    status: "active",
    explanation,
    user_confirmed: true,
  });

  if (insertErr) {
    // Put the old parent back rather than leave the node parentless.
    if (previousEdgeIds.length > 0) {
      await supabase
        .from("edges")
        .update({ status: "active", updated_at: nowIso })
        .in("id", previousEdgeIds)
        .eq("user_id", userId);
    }
    return { ok: false, error: `could not set the new parent: ${insertErr.message}` };
  }

  return { ok: true, changed: true, nodeTitle, parentTitle, previousParentId, previousParentTitle };
}

// The workspace root (an area) — where a new node goes when nobody said where.
export async function getWorkspaceRootId(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  const { data } = await params.supabase
    .from("workspaces")
    .select("bootstrap_root_node_id")
    .eq("id", params.workspaceId)
    .eq("user_id", params.userId)
    .maybeSingle();
  return (data?.bootstrap_root_node_id as string | null | undefined) ?? null;
}
