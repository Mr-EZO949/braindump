// Shared merge core. Single implementation used by:
//   • /api/nodes/[id]/merge (the HTTP route)
//   • propose_merge mutation tool (chat-driven merge)
//
// Behaviour mirrors the original route exactly: re-point active edges from
// the source to the target, resolve duplicates by confidence, preserve
// merge lineage + proposal provenance, archive the source (stamping
// archived_at so the cleanup cron can purge it), update any merge
// suggestion, then re-embed the target and recompute workspace scores.

import type { SupabaseClient } from "@supabase/supabase-js";

import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { computeWorkspaceScores } from "@/lib/ai/scoring";

function uniqueIds(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

type NodeSnapshotInput = {
  id: string;
  node_type: string | null;
  status: string | null;
  summary: string | null;
  title: string | null;
};

function buildNodeSnapshot(node: NodeSnapshotInput) {
  return {
    id: node.id,
    node_type: node.node_type,
    status: node.status,
    summary: node.summary,
    title: node.title,
  };
}

export type MergeNodesSuccess = {
  ok: true;
  kept_node_id: string;
  archived_node_id: string;
  edges_moved: number;
  edges_skipped: number;
  provenance_relinked: number;
  recomputed_scores: unknown[];
};

export type MergeNodesFailure = {
  ok: false;
  status: number;
  error: string;
  detail?: string;
};

export type MergeNodesResult = MergeNodesSuccess | MergeNodesFailure;

export async function mergeNodes(
  supabase: SupabaseClient,
  userId: string,
  sourceNodeId: string,
  targetNodeId: string,
  suggestionId?: string | null,
): Promise<MergeNodesResult> {
  if (sourceNodeId === targetNodeId) {
    return {
      ok: false,
      status: 400,
      error: "Source and target must be different nodes",
    };
  }

  // Verify both nodes belong to this user and the same workspace.
  const { data: nodes, error: nodeError } = await supabase
    .from("nodes")
    .select("id, workspace_id, title, summary, status, node_type")
    .in("id", [sourceNodeId, targetNodeId])
    .eq("user_id", userId);

  if (nodeError || !nodes || nodes.length < 2) {
    return { ok: false, status: 404, error: "One or both nodes not found" };
  }

  const sourceNode = nodes.find((n) => n.id === sourceNodeId) as
    | NodeSnapshotInput
    | undefined;
  const targetNode = nodes.find((n) => n.id === targetNodeId) as
    | NodeSnapshotInput
    | undefined;
  if (!sourceNode || !targetNode) {
    return { ok: false, status: 404, error: "One or both nodes not found" };
  }
  const sourceWs = (sourceNode as { workspace_id?: string }).workspace_id;
  const targetWs = (targetNode as { workspace_id?: string }).workspace_id;
  if (!sourceWs || !targetWs || sourceWs !== targetWs) {
    return {
      ok: false,
      status: 422,
      error: "Nodes must be in the same workspace",
    };
  }
  const workspaceId = sourceWs;

  // Merge provenance: which proposed_nodes accepted into the source.
  const { data: sourceProposalRows, error: sourceProposalError } = await supabase
    .from("proposed_nodes")
    .select("id, ai_run_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("accepted_node_id", sourceNodeId);
  if (sourceProposalError) {
    return {
      ok: false,
      status: 500,
      error: "Failed to load merge provenance",
      detail: sourceProposalError.message,
    };
  }
  const sourceProposedNodeIds = uniqueIds(
    (sourceProposalRows ?? []).map(
      (row) => (row as { id: string | null }).id,
    ),
  );
  const sourceAiRunIds = uniqueIds(
    (sourceProposalRows ?? []).map(
      (row) => (row as { ai_run_id: string | null }).ai_run_id,
    ),
  );

  // Load edges touching source + target; ignore already-orphaned ones.
  type EdgeRow = {
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    status: string;
    confidence: number | null;
  };
  type TargetEdgeRow = {
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    confidence: number | null;
  };

  const { data: sourceEdges } = await supabase
    .from("edges")
    .select("id, source_node_id, target_node_id, edge_type, status, confidence")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .or(`source_node_id.eq.${sourceNodeId},target_node_id.eq.${sourceNodeId}`)
    .neq("status", "orphaned");
  const { data: targetEdges } = await supabase
    .from("edges")
    .select("id, source_node_id, target_node_id, edge_type, confidence")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .or(`source_node_id.eq.${targetNodeId},target_node_id.eq.${targetNodeId}`)
    .neq("status", "orphaned");

  // Map edges already on target by "type:otherNodeId" for conflict detection.
  const targetEdgeBySignature = new Map<string, TargetEdgeRow>();
  for (const e of (targetEdges ?? []) as TargetEdgeRow[]) {
    const otherId =
      e.source_node_id === targetNodeId ? e.target_node_id : e.source_node_id;
    targetEdgeBySignature.set(`${e.edge_type}:${otherId}`, e);
  }
  const targetEdgeSignatures = new Set(targetEdgeBySignature.keys());

  let edgesMoved = 0;
  let edgesSkipped = 0;

  for (const edge of (sourceEdges ?? []) as EdgeRow[]) {
    const otherId =
      edge.source_node_id === sourceNodeId
        ? edge.target_node_id
        : edge.source_node_id;
    if (otherId === targetNodeId) {
      // Would create a self-loop on the target. Drop it.
      edgesSkipped++;
      continue;
    }
    const signature = `${edge.edge_type}:${otherId}`;
    if (targetEdgeSignatures.has(signature)) {
      // Conflict: keep the higher-confidence one; delete the source edge.
      const existingEdge = targetEdgeBySignature.get(signature);
      const sourceConf = edge.confidence ?? 0;
      const targetConf = existingEdge?.confidence ?? 0;
      if (existingEdge && sourceConf > targetConf) {
        await supabase
          .from("edges")
          .update({ confidence: sourceConf })
          .eq("id", existingEdge.id);
      }
      await supabase.from("edges").delete().eq("id", edge.id);
      edgesSkipped++;
      continue;
    }
    const updatePayload =
      edge.source_node_id === sourceNodeId
        ? { source_node_id: targetNodeId }
        : { target_node_id: targetNodeId };
    const { error: moveError } = await supabase
      .from("edges")
      .update(updatePayload)
      .eq("id", edge.id);
    if (!moveError) {
      targetEdgeSignatures.add(signature);
      edgesMoved++;
    } else {
      edgesSkipped++;
    }
  }

  // Preserve merge lineage.
  const { error: lineageError } = await supabase
    .from("node_merge_lineage")
    .upsert(
      {
        user_id: userId,
        workspace_id: workspaceId,
        canonical_node_id: targetNodeId,
        merged_node_id: sourceNodeId,
        merge_suggestion_id: suggestionId ?? null,
        source_proposed_node_ids: sourceProposedNodeIds,
        source_ai_run_ids: sourceAiRunIds,
        source_snapshot: buildNodeSnapshot(sourceNode),
        canonical_snapshot: buildNodeSnapshot(targetNode),
      },
      { onConflict: "canonical_node_id,merged_node_id" },
    );
  if (lineageError) {
    return {
      ok: false,
      status: 500,
      error: "Failed to store merge lineage",
      detail: lineageError.message,
    };
  }

  if (sourceProposedNodeIds.length > 0) {
    const { error: provenanceUpdateError } = await supabase
      .from("proposed_nodes")
      .update({ accepted_node_id: targetNodeId })
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("accepted_node_id", sourceNodeId);
    if (provenanceUpdateError) {
      return {
        ok: false,
        status: 500,
        error: "Failed to relink accepted proposal provenance",
        detail: provenanceUpdateError.message,
      };
    }
  }

  // Archive the source (duplicate) node. archived_at lets the cleanup cron
  // purge it eventually.
  await supabase
    .from("nodes")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("id", sourceNodeId)
    .eq("user_id", userId);

  if (suggestionId) {
    await supabase
      .from("merge_suggestions")
      .update({ status: "merged", updated_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("user_id", userId);
  }

  // Best-effort re-embed and re-score; never fail the merge on these.
  await generateAndStoreEmbedding({
    nodeId: targetNodeId,
    title: targetNode.title as string,
    summary: targetNode.summary as string | null,
    workspaceId,
    userId,
    supabase,
  }).catch(() => {});

  const scoreResult = await computeWorkspaceScores({
    workspaceId,
    userId,
    supabase,
  }).catch(() => ({ recomputed: 0, nodeUpdates: [] as unknown[] }));

  return {
    ok: true,
    kept_node_id: targetNodeId,
    archived_node_id: sourceNodeId,
    edges_moved: edgesMoved,
    edges_skipped: edgesSkipped,
    provenance_relinked: sourceProposedNodeIds.length,
    recomputed_scores: scoreResult.nodeUpdates ?? [],
  };
}
