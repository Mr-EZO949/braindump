// Connection pipeline — Phase 5
// Retrieve similar nodes → rerank → infer edges → save proposed_edges
// Called after a node is accepted and embedded.
// Never blocks node acceptance — all failures are caught per-pair.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider, aiRerankProvider } from "@/lib/ai/index";
import { matchNodes, generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { AI_CANDIDATES, AI_CONFIDENCE, AI_FLAGS } from "@/lib/ai/config";
// MAX_INFERENCE_PAIRS is derived from AI_CANDIDATES.INFERENCE_MAX below
import { INFER_EDGE_PROMPT_VERSION } from "@/lib/ai/prompts/infer-edge";

// Max candidates sent to edge inference per node — keep in sync with AI_CANDIDATES.INFERENCE_MAX.
const MAX_INFERENCE_PAIRS = AI_CANDIDATES.INFERENCE_MAX;

export interface ConnectionResult {
  proposed: number;
  skipped: number;
  failed: number;
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
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<ConnectionResult> {
  if (!AI_FLAGS.EDGE_INFERENCE_ENABLED) {
    return { proposed: 0, skipped: 0, failed: 0 };
  }

  const { nodeId, workspaceId, userId, supabase } = params;

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

  // 2. Ensure embedding exists (no-op if already embedded)
  await generateAndStoreEmbedding({
    nodeId,
    title: sourceTitle,
    summary: sourceSummary,
    workspaceId,
    userId,
    supabase,
  }).catch(() => {});

  // 3. Retrieve top K similar nodes via embedding
  const queryText = [sourceTitle, sourceSummary].filter(Boolean).join("\n");
  const candidates = await matchNodes({
    queryText,
    workspaceId,
    userId,
    supabase,
    excludeNodeId: nodeId,
    includeCompleted: false,
    limit: AI_CANDIDATES.RETRIEVAL_K,
  }).catch(() => []);

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

  // 5. Store candidate set as ai_artifact (best-effort)
  void supabase.from("ai_artifacts").insert({
    artifact_type: "connection_candidates",
    user_id: userId,
    payload: {
      source_node_id: nodeId,
      workspace_id: workspaceId,
      candidates: topIds.map((id) => ({
        node_id: id,
        title: candidateMap.get(id)?.title,
        similarity: candidateMap.get(id)?.similarity ?? 0,
      })),
    },
  });

  // 6. Load existing proposals for this node to avoid duplicates
  const { data: existing } = await supabase
    .from("proposed_edges")
    .select("source_node_id, target_node_id, proposal_status")
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

  // 7. Infer edges in parallel — failures are per-pair, never propagate
  let proposed = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    topIds.map(async (candidateId) => {
      const candidate = candidateMap.get(candidateId);
      if (!candidate) { skipped++; return; }

      const fwd = `${nodeId}:${candidateId}`;
      const rev = `${candidateId}:${nodeId}`;

      if (activePairs.has(fwd) || activePairs.has(rev)) { skipped++; return; }
      if (rejectedPairs.has(fwd) || rejectedPairs.has(rev)) { skipped++; return; }

      try {
        const result = await aiProvider().inferEdge({
          source_node: { id: nodeId, title: sourceTitle, summary: sourceSummary },
          target_node: {
            id: candidateId,
            title: candidate.title,
            summary: candidate.summary,
          },
        });

        // Persist ai_run (best-effort)
        void supabase.from("ai_runs").insert({
          ...result.run,
          run_type: "infer_edge",
          provider: "gemini",
          prompt_version: INFER_EDGE_PROMPT_VERSION,
          status: "success",
          user_id: userId,
          workspace_id: workspaceId,
        });

        const out = result.output;
        if (
          out.related &&
          out.edge_type &&
          out.confidence >= AI_CONFIDENCE.EDGE_INFERENCE_MIN
        ) {
          const { error } = await supabase.from("proposed_edges").insert({
            workspace_id: workspaceId,
            user_id: userId,
            source_node_id: nodeId,
            target_node_id: candidateId,
            edge_type: out.edge_type,
            confidence: out.confidence,
            explanation: out.explanation,
            proposal_status: "pending_review",
          });
          if (error) failed++;
          else proposed++;
        } else {
          skipped++;
        }
      } catch {
        failed++;
      }
    })
  );

  return { proposed, skipped, failed };
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
