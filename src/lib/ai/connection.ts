// Connection pipeline — Phase 5
// Retrieve similar nodes → rerank → infer edges → save proposed_edges
// Called after a node is accepted and embedded.
// Never blocks node acceptance — all failures are caught per-pair.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider, aiRerankProvider } from "@/lib/ai/index";
import { matchNodes, generateAndStoreEmbedding, loadStoredEmbeddings } from "@/lib/ai/embeddings";
import { AI_CANDIDATES, AI_FLAGS } from "@/lib/ai/config";
// MAX_INFERENCE_PAIRS is derived from AI_CANDIDATES.INFERENCE_MAX below
import { INFER_EDGE_PROMPT_VERSION } from "@/lib/ai/prompts/infer-edge";
import {
  buildLinkStructure,
  capWeakLinks,
  selectEdgeProposals,
  treeRelation,
  type EdgeProposal,
  type LinkStructure,
} from "@/lib/ai/edge-selection";
import { persistAIRun } from "@/lib/ai/telemetry";
import { buildWorkspaceProfileContext } from "./workspace-profile";

// Max candidates sent to edge inference per node — keep in sync with AI_CANDIDATES.INFERENCE_MAX.
const MAX_INFERENCE_PAIRS = AI_CANDIDATES.INFERENCE_MAX;

export interface ConnectionResult {
  proposed: number;
  skipped: number;
  failed: number;
  // What was selected; with `insert: false` the caller writes them.
  proposals?: EdgeProposal[];
}

// The workspace's tree, links and pending proposals — what edge-selection.ts
// needs to cut links the graph already says. Batch callers load it once.
export async function loadLinkStructure(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<LinkStructure> {
  const { workspaceId, userId, supabase } = params;
  const [edges, pending, nodes, workspace] = await Promise.all([
    supabase
      .from("edges")
      .select("source_node_id, target_node_id, edge_type, status")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId),
    supabase
      .from("proposed_edges")
      .select("source_node_id, target_node_id, edge_type")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("proposal_status", "pending_review"),
    supabase
      .from("nodes")
      .select("id, node_type")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .neq("status", "archived"),
    supabase.from("workspaces").select("bootstrap_root_node_id").eq("id", workspaceId).maybeSingle(),
  ]);
  const rows = (data: unknown) =>
    ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      source_node_id: r.source_node_id as string,
      target_node_id: r.target_node_id as string,
      edge_type: r.edge_type as string,
      status: (r.status as string | null | undefined) ?? null,
    }));
  return buildLinkStructure({
    edges: rows(edges.data).filter((e) => e.status !== "orphaned"),
    pending: rows(pending.data),
    nodeTypes: new Map(
      ((nodes.data ?? []) as Array<{ id: string; node_type: string | null }>).map((n) => [n.id, n.node_type]),
    ),
    rootId: (workspace.data?.bootstrap_root_node_id as string | null | undefined) ?? null,
  });
}

// Writes selected links as proposals for review. Returns how many failed.
export async function insertEdgeProposals(params: {
  proposals: EdgeProposal[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<{ proposed: number; failed: number }> {
  let proposed = 0;
  let failed = 0;
  for (const edge of params.proposals) {
    const { error } = await params.supabase.from("proposed_edges").insert({
      workspace_id: params.workspaceId,
      user_id: params.userId,
      source_node_id: edge.source_node_id,
      target_node_id: edge.target_node_id,
      edge_type: edge.edge_type,
      confidence: edge.confidence,
      explanation: edge.explanation,
      proposal_status: "pending_review",
    });
    if (error) failed++;
    else proposed++;
  }
  return { proposed, failed };
}

export interface ProposedEdgeWithNodes {
  id: string;
  source_node_id: string;
  source_title: string;
  source_node_type: string;
  target_node_id: string;
  target_title: string;
  target_node_type: string;
  edge_type: string;
  confidence: number;
  explanation: string;
  proposal_status: string;
}

export async function runConnectionAnalysis(params: {
  nodeId: string;
  excludeNodeIds?: string[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  // Optional pre-built workspace context. Batch callers should build this once
  // and pass the same snapshot to every call in the batch so the shared prefix
  // becomes stable bytes across calls — enabling prompt-cache hits on Claude.
  // If omitted, each call builds its own (legacy path, safe fallback).
  workspaceContext?: string;
  // The node's stored embedding when the caller already loaded it.
  embedding?: number[];
  // The workspace's tree and links (loadLinkStructure) — batch callers load
  // it once. Loaded here when omitted.
  structure?: LinkStructure;
  // false: select only, return `proposals`, write nothing — the batch caller
  // caps weak links across the whole batch (capWeakLinks) and inserts.
  insert?: boolean;
}): Promise<ConnectionResult> {
  if (!AI_FLAGS.EDGE_INFERENCE_ENABLED) {
    return { proposed: 0, skipped: 0, failed: 0 };
  }

  const { nodeId, workspaceId, userId, supabase } = params;
  const excludedNodeIds = new Set(params.excludeNodeIds ?? []);

  // 1. Fetch source node
  const { data: sourceNode } = await supabase
    .from("nodes")
    .select("id, title, summary, node_type, status")
    .eq("id", nodeId)
    .eq("user_id", userId)
    .single();

  if (!sourceNode || (sourceNode.status as string) === "archived") {
    return { proposed: 0, skipped: 0, failed: 0 };
  }

  const sourceTitle = sourceNode.title as string;
  const sourceSummary = sourceNode.summary as string | null;
  const sourceType = (sourceNode.node_type as string | null) ?? null;
  let workspaceContext: string | undefined = params.workspaceContext;
  if (workspaceContext === undefined) {
    try {
      const context = await buildWorkspaceProfileContext({
        workspaceId,
        userId,
        supabase,
      });
      workspaceContext = context.workspaceContext;
    } catch {
      workspaceContext = undefined;
    }
  }

  // 2. The node's embedding: the stored one (it is the vector of this same
  // title + summary, so it is also the query below), or a new one.
  const embedding =
    params.embedding ??
    (await loadStoredEmbeddings({ nodeIds: [nodeId], workspaceId, userId, supabase }).catch(() => null))?.get(nodeId);
  if (!embedding) {
    await generateAndStoreEmbedding({
      nodeId,
      title: sourceTitle,
      summary: sourceSummary,
      workspaceId,
      userId,
      supabase,
    }).catch(() => {});
  }

  // 3. Retrieve top K similar nodes via embedding
  const queryText = [sourceTitle, sourceSummary].filter(Boolean).join("\n");
  const matchedCandidates = await matchNodes({
    queryText,
    queryEmbedding: embedding,
    workspaceId,
    userId,
    supabase,
    excludeNodeId: nodeId,
    includeCompleted: false,
    limit: AI_CANDIDATES.RETRIEVAL_K,
  }).catch(() => []);
  const structure =
    params.structure ??
    (await loadLinkStructure({ workspaceId, userId, supabase }).catch(() => undefined));
  // A node's own ancestors and descendants are never asked about: the tree
  // already links them (and a parent link to a descendant would be a cycle).
  const candidates = matchedCandidates.filter((candidate) => {
    if (excludedNodeIds.has(candidate.node_id)) return false;
    const relation = structure ? treeRelation(structure, nodeId, candidate.node_id) : null;
    return relation !== "ancestor" && relation !== "descendant";
  });

  if (candidates.length === 0) {
    return { proposed: 0, skipped: 0, failed: 0 };
  }

  // 4. Rerank — fallback to embedding similarity order if Cohere fails
  let topIds: string[];
  try {
    const reranker = aiRerankProvider();
    const reranked = await reranker.rerankCandidates({
      query: queryText,
      candidates: candidates.map((c) => ({
        id: c.node_id,
        text: [c.title, c.summary].filter(Boolean).join(". "),
      })),
    });
    topIds = reranked.output.ranked
      .slice(0, AI_CANDIDATES.RERANK_N)
      .map((r) => r.id);
  } catch {
    // Cohere down or quota — use embedding similarity order as fallback
    topIds = candidates.slice(0, AI_CANDIDATES.RERANK_N).map((c) => c.node_id);
  }

  topIds = topIds.slice(0, MAX_INFERENCE_PAIRS);
  const candidateMap = new Map(candidates.map((c) => [c.node_id, c]));

  // 5. Load existing proposals for this node to avoid duplicates
  const { data: existing } = await supabase
    .from("proposed_edges")
    .select("source_node_id, target_node_id, proposal_status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`);

  const { data: canonicalEdges } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, edge_type, status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`);

  const rejectedPairs = new Set(
    (existing ?? [])
      .filter((p) => (p.proposal_status as string) === "rejected")
      .map((p) => `${p.source_node_id as string}:${p.target_node_id as string}`)
  );
  const activePairs = new Set(
    (existing ?? [])
      .filter((p) => (p.proposal_status as string) !== "rejected")
      .map((p) => `${p.source_node_id as string}:${p.target_node_id as string}`)
  );
  const canonicalPairs = new Set(
    (canonicalEdges ?? [])
      .filter((edge) => (edge.status as string | null) !== "orphaned")
      .map((edge) => `${edge.source_node_id as string}:${edge.target_node_id as string}`)
  );

  // Check if this node already has a belongs_to parent — enforce single parent
  const alreadyHasParent = (canonicalEdges ?? []).some(
    (edge) =>
      (edge.source_node_id as string) === nodeId &&
      (edge.edge_type as string) === "belongs_to" &&
      (edge.status as string | null) !== "orphaned"
  );

  let skipped = 0;
  let failed = 0;

  // 6. Build the eligible candidate set — skip pairs already decided on
  const eligibleCandidates: {
    id: string;
    title: string;
    summary: string | null;
    node_type: string | null;
  }[] = [];
  for (const candidateId of topIds) {
    const candidate = candidateMap.get(candidateId);
    if (!candidate) { skipped++; continue; }

    const fwd = `${nodeId}:${candidateId}`;
    const rev = `${candidateId}:${nodeId}`;

    if (activePairs.has(fwd) || activePairs.has(rev)) { skipped++; continue; }
    if (rejectedPairs.has(fwd) || rejectedPairs.has(rev)) { skipped++; continue; }
    if (canonicalPairs.has(fwd) || canonicalPairs.has(rev)) { skipped++; continue; }

    eligibleCandidates.push({
      id: candidateId,
      title: candidate.title,
      summary: candidate.summary,
      node_type: candidate.node_type ?? null,
    });
  }

  if (eligibleCandidates.length === 0) {
    return { proposed: 0, skipped, failed };
  }

  // 7. Single batched inference call — evaluates all eligible candidates at once
  let selected: EdgeProposal[] = [];
  try {
    const result = await aiProvider().inferEdge({
      source_node: {
        id: nodeId,
        title: sourceTitle,
        summary: sourceSummary,
        node_type: sourceType,
        has_parent: alreadyHasParent,
      },
      candidates: eligibleCandidates,
      workspace_context: workspaceContext,
    });

    // Awaited: a supabase-js query only runs once it is awaited. The old
    // `void supabase.from("ai_runs").insert(...)` never sent anything, so no
    // infer_edge run was logged (or priced) from April to September 2026.
    const runId = await persistAIRun({
      supabase,
      userId,
      workspaceId,
      source: "connection",
      run: {
        ...result.run,
        run_type: "infer_edge",
        prompt_version: INFER_EDGE_PROMPT_VERSION,
        status: "success",
      },
    });
    // What the model was shown for this node — for "why didn't it link X?".
    if (runId) {
      await supabase
        .from("ai_artifacts")
        .insert({
          ai_run_id: runId,
          user_id: userId,
          artifact_type: "connection_candidates",
          linked_entity_ids: [nodeId],
          payload: {
            source_node_id: nodeId,
            workspace_id: workspaceId,
            candidates: topIds.map((id) => ({
              node_id: id,
              title: candidateMap.get(id)?.title,
              similarity: candidateMap.get(id)?.similarity ?? 0,
            })),
            verdicts: result.output.results,
          },
        })
        .then(
          () => undefined,
          () => undefined,
        );
    }

    selected = selectEdgeProposals({
      sourceId: nodeId,
      sourceType,
      sourceHasParent: alreadyHasParent,
      results: result.output.results,
      candidateTypeById: new Map(eligibleCandidates.map((c) => [c.id, c.node_type])),
      titleById: new Map([[nodeId, sourceTitle], ...eligibleCandidates.map((c) => [c.id, c.title] as [string, string])]),
      structure,
    });

    // Account for any candidates the model failed to return a verdict for
    const returnedIds = new Set(result.output.results.map((r) => r.candidate_id));
    for (const c of eligibleCandidates) {
      if (!returnedIds.has(c.id)) failed++;
    }
    skipped += Math.max(eligibleCandidates.length - failed - selected.length, 0);
  } catch (err) {
    console.error("[connection] inferEdge failed:", err instanceof Error ? err.message : err);
    failed += eligibleCandidates.length;
  }

  if (params.insert === false) {
    return { proposed: 0, skipped, failed, proposals: selected };
  }
  const capped = capWeakLinks(selected, structure?.weakCount ?? new Map());
  skipped += selected.length - capped.length;
  const written = await insertEdgeProposals({ proposals: capped, workspaceId, userId, supabase });
  return { proposed: written.proposed, skipped, failed: failed + written.failed, proposals: capped };
}

// Connection analysis for a batch of nodes (a dump's accepted nodes): the
// tree and links loaded once, every node analysed in parallel, then the
// weak-link cap across the whole batch (best first) and the writes. Shared by
// /api/nodes/analyze and the connection_batch job.
export async function runConnectionBatch(params: {
  nodeIds: string[];
  // Candidates each node must not be asked about (the batch's other nodes,
  // so a pair is judged once).
  excludeFor: (nodeId: string) => string[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  workspaceContext?: string;
  embeddings?: Map<string, number[]>;
}): Promise<Array<{ nodeId: string } & ConnectionResult>> {
  const { workspaceId, userId, supabase } = params;
  const structure = await loadLinkStructure({ workspaceId, userId, supabase }).catch(() => undefined);
  const results = await Promise.all(
    params.nodeIds.map(async (nodeId) => {
      try {
        const result = await runConnectionAnalysis({
          nodeId,
          excludeNodeIds: params.excludeFor(nodeId),
          workspaceId,
          userId,
          supabase,
          workspaceContext: params.workspaceContext,
          embedding: params.embeddings?.get(nodeId),
          structure,
          insert: false,
        });
        return { nodeId, ...result };
      } catch {
        return { nodeId, proposed: 0, skipped: 0, failed: 1, proposals: [] as EdgeProposal[] };
      }
    }),
  );

  const selected = results.flatMap((r) => (r.proposals ?? []).map((p) => ({ ...p, nodeId: r.nodeId })));
  const kept = capWeakLinks(selected, structure?.weakCount ?? new Map());
  for (const r of results) {
    const mine = kept.filter((p) => p.nodeId === r.nodeId);
    r.skipped += (r.proposals ?? []).length - mine.length;
    const written = await insertEdgeProposals({
      proposals: mine, // insertEdgeProposals writes only the link's own fields
      workspaceId,
      userId,
      supabase,
    });
    r.proposed += written.proposed;
    r.failed += written.failed;
    r.proposals = mine;
  }
  return results;
}

// Fetch pending proposed edges with joined node details.
// Used by the analyze route to return results immediately.
export async function fetchPendingEdges(params: {
  workspaceId: string;
  userId: string;
  nodeIds?: string[]; // narrow to edges involving specific nodes
  supabase: SupabaseClient;
}): Promise<ProposedEdgeWithNodes[]> {
  const { workspaceId, userId, nodeIds, supabase } = params;

  let query = supabase
    .from("proposed_edges")
    .select(`
      id,
      source_node_id,
      target_node_id,
      edge_type,
      confidence,
      explanation,
      proposal_status
    `)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("proposal_status", "pending_review")
    .order("confidence", { ascending: false });

  if (nodeIds && nodeIds.length > 0) {
    // Filter to edges where source OR target is one of the new nodes
    query = query.or(
      `source_node_id.in.(${nodeIds.join(",")}),target_node_id.in.(${nodeIds.join(",")})`
    );
  }

  const { data: edges, error } = await query;
  if (error || !edges || edges.length === 0) return [];

  // Collect all node IDs to join in one query
  const allNodeIds = Array.from(
    new Set(edges.flatMap((e) => [e.source_node_id as string, e.target_node_id as string]))
  );

  const { data: nodes } = await supabase
    .from("nodes")
    .select("id, title, node_type")
    .in("id", allNodeIds)
    .eq("user_id", userId);

  const nodeMap = new Map((nodes ?? []).map((n) => [n.id as string, n]));

  return edges.flatMap((edge) => {
    const src = nodeMap.get(edge.source_node_id as string);
    const tgt = nodeMap.get(edge.target_node_id as string);
    if (!src || !tgt) return [];
    return [{
      id: edge.id as string,
      source_node_id: edge.source_node_id as string,
      source_title: src.title as string,
      source_node_type: src.node_type as string,
      target_node_id: edge.target_node_id as string,
      target_title: tgt.title as string,
      target_node_type: tgt.node_type as string,
      edge_type: edge.edge_type as string,
      confidence: edge.confidence as number,
      explanation: edge.explanation as string,
      proposal_status: edge.proposal_status as string,
    }];
  });
}
