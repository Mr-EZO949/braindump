// Connection pipeline — Phase 5
// Retrieve similar nodes → rerank → infer edges → save proposed_edges
// Called after nodes are accepted and embedded, for the batch at once.
// Never blocks node acceptance — a failed call only costs its group's links.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider, aiRerankProvider } from "@/lib/ai/index";
import { matchNodes, generateAndStoreEmbedding, loadStoredEmbeddings } from "@/lib/ai/embeddings";
import { AI_CANDIDATES, AI_FLAGS } from "@/lib/ai/config";
// MAX_INFERENCE_PAIRS is derived from AI_CANDIDATES.INFERENCE_MAX below
import { INFER_EDGE_PROMPT_VERSION } from "@/lib/ai/prompts/infer-edge";
import {
  buildLinkStructure,
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
}

// The workspace's tree — edge-selection.ts never links a node to its own
// ancestor or descendant. Batch callers load it once.
export async function loadLinkStructure(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<LinkStructure> {
  const { workspaceId, userId, supabase } = params;
  const { data } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, edge_type, status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("edge_type", "belongs_to");
  // A null status is a live edge, so filter here, not with .neq (SQL drops nulls).
  const live = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => r.status !== "orphaned");
  return buildLinkStructure({
    edges: live.map((r) => ({
      source_node_id: r.source_node_id as string,
      target_node_id: r.target_node_id as string,
      edge_type: r.edge_type as string,
    })),
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

// One node's side of the connection analysis, no model involved: its
// candidates after retrieval, rerank and the already-decided pairs.
interface PreparedSource {
  nodeId: string;
  title: string;
  summary: string | null;
  type: string | null;
  hasParent: boolean;
  candidates: { id: string; title: string; summary: string | null; node_type: string | null }[];
  // Shown to the model, with their similarity — for "why didn't it link X?".
  shown: { node_id: string; title: string | undefined; similarity: number }[];
  skipped: number;
}

async function prepareConnectionSource(params: {
  nodeId: string;
  excludeNodeIds: string[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  embedding?: number[];
  structure?: LinkStructure;
}): Promise<PreparedSource | null> {
  const { nodeId, workspaceId, userId, supabase, structure } = params;
  const excludedNodeIds = new Set(params.excludeNodeIds);

  // 1. Fetch source node
  const { data: sourceNode } = await supabase
    .from("nodes")
    .select("id, title, summary, node_type, status")
    .eq("id", nodeId)
    .eq("user_id", userId)
    .single();

  if (!sourceNode || (sourceNode.status as string) === "archived") return null;

  const sourceTitle = sourceNode.title as string;
  const sourceSummary = sourceNode.summary as string | null;
  const sourceType = (sourceNode.node_type as string | null) ?? null;

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
  // A node's own ancestors and descendants are never asked about: the tree
  // already links them (and a parent link to a descendant would be a cycle).
  const candidates = matchedCandidates.filter((candidate) => {
    if (excludedNodeIds.has(candidate.node_id)) return false;
    const relation = structure ? treeRelation(structure, nodeId, candidate.node_id) : null;
    return relation !== "ancestor" && relation !== "descendant";
  });

  if (candidates.length === 0) return null;

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
    // Cohere bills per search (~$0.002): one per analysed node, unlogged until 2026-10-06.
    await persistAIRun({ supabase, userId, workspaceId, source: "connection", run: reranked.run });
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

  // 6. Build the eligible candidate set — skip pairs already decided on
  let skipped = 0;
  const eligibleCandidates: PreparedSource["candidates"] = [];
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

  return {
    nodeId,
    title: sourceTitle,
    summary: sourceSummary,
    type: sourceType,
    hasParent: alreadyHasParent,
    candidates: eligibleCandidates,
    shown: topIds.map((id) => ({
      node_id: id,
      title: candidateMap.get(id)?.title,
      similarity: candidateMap.get(id)?.similarity ?? 0,
    })),
    skipped,
  };
}

// One model call for a group of prepared nodes, then each node's links
// through edge-selection.ts and into proposed_edges.
async function inferGroup(params: {
  group: PreparedSource[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  workspaceContext?: string;
  structure?: LinkStructure;
}): Promise<Array<{ nodeId: string } & ConnectionResult>> {
  const { group, workspaceId, userId, supabase, structure } = params;
  let output;
  try {
    const result = await aiProvider().inferEdge({
      sources: group.map((source) => ({
        source_node: {
          id: source.nodeId,
          title: source.title,
          summary: source.summary,
          node_type: source.type,
          has_parent: source.hasParent,
        },
        candidates: source.candidates,
      })),
      workspace_context: params.workspaceContext,
    });
    output = result.output;

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
    // What the model was shown for these nodes — for "why didn't it link X?".
    if (runId) {
      await supabase
        .from("ai_artifacts")
        .insert({
          ai_run_id: runId,
          user_id: userId,
          artifact_type: "connection_candidates",
          linked_entity_ids: group.map((source) => source.nodeId),
          payload: {
            workspace_id: workspaceId,
            sources: group.map((source) => ({ source_node_id: source.nodeId, candidates: source.shown })),
            links: output.results,
          },
        })
        .then(
          () => undefined,
          () => undefined,
        );
    }
  } catch (err) {
    console.error("[connection] inferEdge failed:", err instanceof Error ? err.message : err);
    return group.map((source) => ({
      nodeId: source.nodeId,
      proposed: 0,
      skipped: source.skipped,
      failed: source.candidates.length,
    }));
  }

  return Promise.all(
    group.map(async (source) => {
      const selected = selectEdgeProposals({
        sourceId: source.nodeId,
        sourceType: source.type,
        sourceHasParent: source.hasParent,
        results: output.results.filter((link) => link.source_id === source.nodeId),
        candidateTypeById: new Map(source.candidates.map((c) => [c.id, c.node_type])),
        titleById: new Map([
          [source.nodeId, source.title],
          ...source.candidates.map((c) => [c.id, c.title] as [string, string]),
        ]),
        structure,
      });
      const written = await insertEdgeProposals({ proposals: selected, workspaceId, userId, supabase });
      return {
        nodeId: source.nodeId,
        proposed: written.proposed,
        skipped: source.skipped + Math.max(source.candidates.length - selected.length, 0),
        failed: written.failed,
      };
    }),
  );
}

// Connection analysis for a batch of nodes (a dump's accepted nodes): the
// tree and the workspace context loaded once, every node's candidates found
// in parallel, then ONE model call per group of
// AI_CANDIDATES.INFERENCE_SOURCES_PER_CALL nodes (infer-edge-v8). Shared by
// /api/nodes/analyze and the connection_batch job.
export async function runConnectionBatch(params: {
  nodeIds: string[];
  // Candidates each node must not be asked about (the batch's other nodes,
  // so a pair is judged once).
  excludeFor: (nodeId: string) => string[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  // Built once per batch; built here when omitted.
  workspaceContext?: string;
  embeddings?: Map<string, number[]>;
}): Promise<Array<{ nodeId: string } & ConnectionResult>> {
  if (!AI_FLAGS.EDGE_INFERENCE_ENABLED) {
    return params.nodeIds.map((nodeId) => ({ nodeId, proposed: 0, skipped: 0, failed: 0 }));
  }

  const { workspaceId, userId, supabase } = params;
  const [structure, workspaceContext] = await Promise.all([
    loadLinkStructure({ workspaceId, userId, supabase }).catch(() => undefined),
    params.workspaceContext !== undefined
      ? Promise.resolve(params.workspaceContext)
      : buildWorkspaceProfileContext({ workspaceId, userId, supabase }).then(
          (context) => context.workspaceContext,
          () => undefined,
        ),
  ]);

  const prepared = await Promise.all(
    params.nodeIds.map(async (nodeId) => {
      try {
        const source = await prepareConnectionSource({
          nodeId,
          excludeNodeIds: params.excludeFor(nodeId),
          workspaceId,
          userId,
          supabase,
          embedding: params.embeddings?.get(nodeId),
          structure,
        });
        return { nodeId, source, failed: 0 };
      } catch {
        return { nodeId, source: null, failed: 1 };
      }
    }),
  );

  const results = new Map<string, ConnectionResult>();
  const ready: PreparedSource[] = [];
  for (const { nodeId, source, failed } of prepared) {
    if (source && source.candidates.length > 0) ready.push(source);
    else results.set(nodeId, { proposed: 0, skipped: source?.skipped ?? 0, failed });
  }

  const groups: PreparedSource[][] = [];
  for (let i = 0; i < ready.length; i += AI_CANDIDATES.INFERENCE_SOURCES_PER_CALL) {
    groups.push(ready.slice(i, i + AI_CANDIDATES.INFERENCE_SOURCES_PER_CALL));
  }
  const inferred = await Promise.all(
    groups.map((group) => inferGroup({ group, workspaceId, userId, supabase, workspaceContext, structure })),
  );
  for (const { nodeId, ...result } of inferred.flat()) results.set(nodeId, result);

  return params.nodeIds.map((nodeId) => ({
    nodeId,
    ...(results.get(nodeId) ?? { proposed: 0, skipped: 0, failed: 0 }),
  }));
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
