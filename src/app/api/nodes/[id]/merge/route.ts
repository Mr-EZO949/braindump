// POST /api/nodes/[id]/merge — Phase 11.4
// Safe merge: reattach edges from the new/duplicate node to the existing/canonical node,
// preserve merge provenance, archive the duplicate, then trigger a ranking recompute.
//
// Body: { target_node_id: string; suggestion_id?: string }
//   - id (URL param): the node being absorbed (typically the newer duplicate)
//   - target_node_id: the canonical node to keep
//   - suggestion_id: if provided, marks the merge_suggestion as merged
//
// Edge reattachment semantics:
//   - For each edge on the source node, attempt to move it to target_node_id
//   - Skip if an equivalent edge (same type + same other endpoint) already exists on target
//   - Higher-confidence existing edges are always kept when there is a conflict
//
// Returns: { kept_node_id, archived_node_id, edges_moved, edges_skipped, provenance_relinked }

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { computeWorkspaceScores } from "@/lib/ai/scoring";

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function buildNodeSnapshot(node: {
  id: string;
  node_type: string | null;
  status: string | null;
  summary: string | null;
  title: string | null;
}) {
  return {
    id: node.id,
    node_type: node.node_type,
    status: node.status,
    summary: node.summary,
    title: node.title,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sourceNodeId } = await params;

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Parse body
  // -------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { target_node_id, suggestion_id = null } = body as {
    target_node_id: string;
    suggestion_id?: string | null;
  };

  if (!target_node_id || typeof target_node_id !== "string") {
    return NextResponse.json({ error: "target_node_id is required" }, { status: 400 });
  }
  if (target_node_id === sourceNodeId) {
    return NextResponse.json({ error: "Source and target must be different nodes" }, { status: 400 });
  }

  // -------------------------------------------------------------------------
  // Verify both nodes belong to this user and the same workspace
  // -------------------------------------------------------------------------
  const { data: nodes, error: nodeError } = await supabase
    .from("nodes")
    .select("id, workspace_id, title, summary, status, node_type")
    .in("id", [sourceNodeId, target_node_id])
    .eq("user_id", user.id);

  if (nodeError || !nodes || nodes.length < 2) {
    return NextResponse.json({ error: "One or both nodes not found" }, { status: 404 });
  }

  const sourceNode = nodes.find((n) => n.id === sourceNodeId);
  const targetNode = nodes.find((n) => n.id === target_node_id);

  if (!sourceNode || !targetNode) {
    return NextResponse.json({ error: "One or both nodes not found" }, { status: 404 });
  }

  if (sourceNode.workspace_id !== targetNode.workspace_id) {
    return NextResponse.json({ error: "Nodes must be in the same workspace" }, { status: 422 });
  }

  const workspaceId = sourceNode.workspace_id as string;

  const { data: sourceProposalRows, error: sourceProposalError } = await supabase
    .from("proposed_nodes")
    .select("id, ai_run_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("accepted_node_id", sourceNodeId);

  if (sourceProposalError) {
    return NextResponse.json(
      { error: "Failed to load merge provenance", detail: sourceProposalError.message },
      { status: 500 },
    );
  }

  const sourceProposedNodeIds = uniqueIds(
    ((sourceProposalRows ?? []) as Array<{ id: string | null }>).map((row) => row.id),
  );
  const sourceAiRunIds = uniqueIds(
    ((sourceProposalRows ?? []) as Array<{ ai_run_id: string | null }>).map((row) => row.ai_run_id),
  );

  // -------------------------------------------------------------------------
  // Load all edges touching the source node
  // -------------------------------------------------------------------------
  type EdgeRow = {
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    status: string;
    confidence: number | null;
  };

  const { data: sourceEdges } = await supabase
    .from("edges")
    .select("id, source_node_id, target_node_id, edge_type, status, confidence")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .or(`source_node_id.eq.${sourceNodeId},target_node_id.eq.${sourceNodeId}`)
    .neq("status", "orphaned");

  // Load edges already on target node (to detect conflicts); include confidence for Phase 11.4
  const { data: targetEdges } = await supabase
    .from("edges")
    .select("id, source_node_id, target_node_id, edge_type, confidence")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .or(`source_node_id.eq.${target_node_id},target_node_id.eq.${target_node_id}`)
    .neq("status", "orphaned");

  type TargetEdgeRow = {
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    confidence: number | null;
  };

  // Map from signature "type:otherNodeId" → existing target edge (for conflict resolution)
  const targetEdgeBySignature = new Map<string, TargetEdgeRow>();
  for (const e of (targetEdges ?? []) as TargetEdgeRow[]) {
    const otherId = e.source_node_id === target_node_id ? e.target_node_id : e.source_node_id;
    targetEdgeBySignature.set(`${e.edge_type}:${otherId}`, e);
  }
  const targetEdgeSignatures = new Set(targetEdgeBySignature.keys());

  let edgesMoved = 0;
  let edgesSkipped = 0;

  for (const edge of sourceEdges ?? []) {
    const typedEdge = edge as EdgeRow;
    const otherId =
      typedEdge.source_node_id === sourceNodeId
        ? typedEdge.target_node_id
        : typedEdge.source_node_id;

    // Skip self-referential edges (would create a loop on target)
    if (otherId === target_node_id) {
      edgesSkipped++;
      continue;
    }

    const signature = `${typedEdge.edge_type}:${otherId}`;
    if (targetEdgeSignatures.has(signature)) {
      // Phase 11.4 — conflict: equivalent edge already exists on target.
      // Keep the higher-confidence one; promote source edge's confidence if it's better.
      const existingEdge = targetEdgeBySignature.get(signature);
      const sourceConf = typedEdge.confidence ?? 0;
      const targetConf = existingEdge?.confidence ?? 0;
      if (existingEdge && sourceConf > targetConf) {
        await supabase
          .from("edges")
          .update({ confidence: sourceConf })
          .eq("id", existingEdge.id);
      }
      await supabase.from("edges").delete().eq("id", typedEdge.id);
      edgesSkipped++;
      continue;
    }

    // Move edge to point to/from target instead of source
    const updatePayload =
      typedEdge.source_node_id === sourceNodeId
        ? { source_node_id: target_node_id }
        : { target_node_id: target_node_id };

    const { error: moveError } = await supabase
      .from("edges")
      .update(updatePayload)
      .eq("id", typedEdge.id);

    if (!moveError) {
      targetEdgeSignatures.add(signature); // prevent re-adding in same loop
      edgesMoved++;
    } else {
      edgesSkipped++;
    }
  }

  // -------------------------------------------------------------------------
  // Preserve merge lineage before re-pointing provenance
  // -------------------------------------------------------------------------
  const { error: lineageError } = await supabase
    .from("node_merge_lineage")
    .upsert(
      {
        user_id: user.id,
        workspace_id: workspaceId,
        canonical_node_id: target_node_id,
        merged_node_id: sourceNodeId,
        merge_suggestion_id: suggestion_id,
        source_proposed_node_ids: sourceProposedNodeIds,
        source_ai_run_ids: sourceAiRunIds,
        source_snapshot: buildNodeSnapshot(sourceNode),
        canonical_snapshot: buildNodeSnapshot(targetNode),
      },
      { onConflict: "canonical_node_id,merged_node_id" },
    );

  if (lineageError) {
    return NextResponse.json(
      { error: "Failed to store merge lineage", detail: lineageError.message },
      { status: 500 },
    );
  }

  if (sourceProposedNodeIds.length > 0) {
    const { error: provenanceUpdateError } = await supabase
      .from("proposed_nodes")
      .update({ accepted_node_id: target_node_id })
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .eq("accepted_node_id", sourceNodeId);

    if (provenanceUpdateError) {
      return NextResponse.json(
        {
          error: "Failed to relink accepted proposal provenance",
          detail: provenanceUpdateError.message,
        },
        { status: 500 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Archive the source (duplicate) node
  // -------------------------------------------------------------------------
  await supabase
    .from("nodes")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("id", sourceNodeId)
    .eq("user_id", user.id);

  // -------------------------------------------------------------------------
  // Mark merge_suggestion as merged
  // -------------------------------------------------------------------------
  if (suggestion_id) {
    await supabase
      .from("merge_suggestions")
      .update({ status: "merged", updated_at: new Date().toISOString() })
      .eq("id", suggestion_id)
      .eq("user_id", user.id);
  }

  // -------------------------------------------------------------------------
  // Recompute embedding for target node (its context just changed)
  // -------------------------------------------------------------------------
  await generateAndStoreEmbedding({
    nodeId: target_node_id,
    title: targetNode.title as string,
    summary: targetNode.summary as string | null,
    workspaceId,
    userId: user.id,
    supabase,
  }).catch(() => {});

  // -------------------------------------------------------------------------
  // Recompute workspace ranking scores
  // -------------------------------------------------------------------------
  const scoreResult = await computeWorkspaceScores({
    workspaceId,
    userId: user.id,
    supabase,
  }).catch(() => ({ recomputed: 0, nodeUpdates: [] }));

  return NextResponse.json({
    kept_node_id: target_node_id,
    archived_node_id: sourceNodeId,
    edges_moved: edgesMoved,
    edges_skipped: edgesSkipped,
    provenance_relinked: sourceProposedNodeIds.length,
    recomputed_scores: scoreResult.nodeUpdates,
  });
}
