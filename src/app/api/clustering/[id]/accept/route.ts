// POST /api/clustering/[id]/accept
// Materializes a cluster_suggestion into a real umbrella node:
//   1. Create the umbrella node (auto-anchored to workspace root)
//   2. For each child: replace its existing belongs_to → root edge with
//      a new belongs_to → umbrella edge
//   3. Mark the suggestion as accepted
//
// The single-parent invariant is preserved by deleting any existing
// belongs_to edge from the child before inserting the new one. Children
// that had no parent get one for the first time.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import type { NodeType } from "@/types/graph";

const ALLOWED_TYPES = new Set<NodeType>(["area", "goal", "project", "big_task", "class"]);

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: suggestionId } = await params;
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

  const { data: suggestion } = await supabase
    .from("cluster_suggestions")
    .select("*")
    .eq("id", suggestionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!suggestion || suggestion.proposal_status !== "pending_review") {
    return NextResponse.json({ error: "Suggestion not found or already decided" }, { status: 404 });
  }

  const { workspace_id, suggested_title, suggested_node_type, child_node_ids } = suggestion as {
    workspace_id: string;
    suggested_title: string;
    suggested_node_type: string;
    child_node_ids: string[];
  };

  // Suggestions made before node types v2 may say "concept" — a grouping, so an area.
  const nodeType: NodeType = ALLOWED_TYPES.has(suggested_node_type as NodeType)
    ? (suggested_node_type as NodeType)
    : "area";

  // Lookup workspace root for auto-anchoring the umbrella.
  const { data: workspaceRow } = await supabase
    .from("workspaces")
    .select("bootstrap_root_node_id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const rootId = workspaceRow?.bootstrap_root_node_id as string | null | undefined;

  // 1. Create the umbrella node. Importance is mid (60) — descendants exist
  //    so it should read as a meaningful structural node, but we don't lock
  //    it because the user might want it to surface higher organically.
  const importance = 60;
  const { data: umbrella, error: umbrellaError } = await supabase
    .from("nodes")
    .insert({
      user_id: user.id,
      workspace_id,
      title: suggested_title,
      summary: `Auto-grouped from ${child_node_ids.length} related nodes.`,
      node_type: nodeType,
      importance: getImportanceLabel(importance),
      importance_index: importance,
      color: NODE_COLOR_BY_TYPE[nodeType] ?? null,
      status: "active",
    })
    .select("*")
    .single();
  if (umbrellaError || !umbrella) {
    return NextResponse.json(
      { error: "Failed to create umbrella node", detail: umbrellaError?.message },
      { status: 500 },
    );
  }

  // 2. Re-parent the children. Delete any existing belongs_to edge from
  //    them (per single-parent invariant we know there's at most one),
  //    then insert the new edge to the umbrella.
  await supabase
    .from("edges")
    .delete()
    .eq("user_id", user.id)
    .eq("workspace_id", workspace_id)
    .eq("edge_type", "belongs_to")
    .in("source_node_id", child_node_ids);

  const childEdgeRows = child_node_ids.map((childId) => ({
    user_id: user.id,
    workspace_id,
    source_node_id: childId,
    target_node_id: umbrella.id,
    edge_type: "belongs_to" as const,
    confidence: 0.85,
    explanation: `${suggested_title} groups related nodes auto-detected by clustering.`,
    status: "active",
    user_confirmed: true,
  }));

  // 3. Anchor the umbrella under the workspace root if available.
  if (rootId) {
    childEdgeRows.push({
      user_id: user.id,
      workspace_id,
      source_node_id: umbrella.id,
      target_node_id: rootId,
      edge_type: "belongs_to" as const,
      confidence: 0.85,
      explanation: `${suggested_title} anchored to workspace.`,
      status: "active",
      user_confirmed: true,
    });
  }

  const { data: insertedEdges, error: edgeError } = await supabase
    .from("edges")
    .insert(childEdgeRows)
    .select("*");
  if (edgeError) {
    // Roll back the umbrella node — we can't leave an orphan named cluster
    // sitting around if the edges failed.
    await supabase.from("nodes").delete().eq("id", umbrella.id);
    return NextResponse.json(
      { error: "Failed to create cluster edges", detail: edgeError.message },
      { status: 500 },
    );
  }

  await supabase
    .from("cluster_suggestions")
    .update({ proposal_status: "accepted", decided_at: new Date().toISOString() })
    .eq("id", suggestionId);

  return NextResponse.json({
    umbrella,
    edges: insertedEdges ?? [],
    accepted_child_count: child_node_ids.length,
  });
}
