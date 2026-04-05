// Connection pipeline — Phase 5
// Retrieve similar nodes → rerank → infer edges → save proposed_edges
// Called after a node is accepted and embedded.
// Never blocks node acceptance — all failures are caught per-pair.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider, aiRerankProvider } from "@/lib/ai/index";
import { matchNodes, generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { AI_CANDIDATES, AI_CONFIDENCE, AI_FLAGS, AI_MODELS, AI_RETRY_QUEUE } from "@/lib/ai/config";
// MAX_INFERENCE_PAIRS is derived from AI_CANDIDATES.INFERENCE_MAX below
import { INFER_EDGE_PROMPT_VERSION } from "@/lib/ai/prompts/infer-edge";
import { buildWorkspaceProfileContext } from "./workspace-profile";
import {
  hashText,
  logFailedAIRun,
  logMalformedOutputFailure,
  normalizeAIError,
  isMalformedAIResponseError,
} from "./errors";
import { persistAIRun } from "./telemetry";
import type { AIRetryJob } from "@/types/ai";
import type { EmbedResult } from "@/lib/ai/embeddings";

// Max candidates sent to edge inference per node — keep in sync with AI_CANDIDATES.INFERENCE_MAX.
const MAX_INFERENCE_PAIRS = AI_CANDIDATES.INFERENCE_MAX;
const ANALYZE_RETRY_JOB_TYPE = "analyze_node";

export interface ConnectionResult {
  proposed: number;
  skipped: number;
  failed: number;
  paused: number;
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

function buildAnalyzeRetryDedupeKey(nodeId: string) {
  return `${ANALYZE_RETRY_JOB_TYPE}:${nodeId}`;
}

export async function queueConnectionAnalysisRetry(params: {
  nodeId: string;
  excludeNodeIds?: string[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  error: string;
}): Promise<boolean> {
  const { nodeId, excludeNodeIds = [], workspaceId, userId, supabase, error } = params;
  const now = new Date();

  const { error: queueError } = await supabase.from("ai_retry_queue").upsert(
    {
      user_id: userId,
      workspace_id: workspaceId,
      job_type: ANALYZE_RETRY_JOB_TYPE,
      dedupe_key: buildAnalyzeRetryDedupeKey(nodeId),
      payload: {
        node_id: nodeId,
        exclude_node_ids: excludeNodeIds,
      },
      status: "queued",
      available_at: new Date(now.getTime() + AI_RETRY_QUEUE.DELAY_MS).toISOString(),
      last_error: error.slice(0, 1000),
      updated_at: now.toISOString(),
    },
    { onConflict: "dedupe_key" }
  );

  if (queueError) {
    console.error("[connection] failed to queue analysis retry:", queueError);
    return false;
  }

  return true;
}

export async function runConnectionAnalysis(params: {
  nodeId: string;
  excludeNodeIds?: string[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<ConnectionResult> {
  if (!AI_FLAGS.EDGE_INFERENCE_ENABLED) {
    return { proposed: 0, skipped: 0, failed: 0, paused: 0 };
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
    return { proposed: 0, skipped: 0, failed: 0, paused: 0 };
  }

  const sourceTitle = sourceNode.title as string;
  const sourceSummary = sourceNode.summary as string | null;
  let workspaceContext: string | undefined;
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

  // 2. Ensure embedding exists (no-op if already embedded)
  const sourceEmbeddingResult = await generateAndStoreEmbedding({
    nodeId,
    title: sourceTitle,
    summary: sourceSummary,
    workspaceId,
    userId,
    supabase,
  }).catch((): EmbedResult => ({ ok: false, error: "Embedding generation failed", errorCode: "unknown" }));

  if (!sourceEmbeddingResult.ok) {
    return {
      proposed: 0,
      skipped: 0,
      failed: sourceEmbeddingResult.queued ? 0 : 1,
      paused: sourceEmbeddingResult.queued ? 1 : 0,
    };
  }

  // 3. Retrieve top K similar nodes via embedding
  const queryText = [sourceTitle, sourceSummary].filter(Boolean).join("\n");
  let matchedCandidates;
  try {
    matchedCandidates = await matchNodes({
      queryText,
      workspaceId,
      userId,
      supabase,
      excludeNodeId: nodeId,
      includeCompleted: false,
      limit: AI_CANDIDATES.RETRIEVAL_K,
    });
  } catch {
    return { proposed: 0, skipped: 0, failed: 1, paused: 0 };
  }
  const candidates = matchedCandidates.filter(
    (candidate) => !excludedNodeIds.has(candidate.node_id)
  );

  if (candidates.length === 0) {
    return { proposed: 0, skipped: 0, failed: 0, paused: 0 };
  }

  // 4. Rerank — fallback to embedding similarity order if Cohere fails
  let topIds: string[];
  let rerankScoreMap = new Map<string, number>();
  try {
    const reranker = aiRerankProvider();
    const reranked = await reranker.rerankCandidates({
      query: queryText,
      candidates: candidates.map((c) => ({
        id: c.node_id,
        text: [c.title, c.summary].filter(Boolean).join(". "),
      })),
    });
    void persistAIRun({
      supabase,
      userId,
      workspaceId,
      source: "connection-rerank",
      run: reranked.run,
    });
    const topRanked = reranked.output.ranked.slice(0, AI_CANDIDATES.RERANK_N);
    topIds = topRanked.map((r) => r.id);
    // Build score map for artifact logging (Phase 5.2)
    rerankScoreMap = new Map(topRanked.map((r) => [r.id, r.score]));
  } catch (err) {
    const normalized = normalizeAIError(err, "Candidate reranking failed");
    if (isMalformedAIResponseError(err)) {
      void logMalformedOutputFailure({
        supabase,
        userId,
        workspaceId,
        error: err,
        linkedEntityIds: [nodeId],
      });
    } else {
      void logFailedAIRun({
        supabase,
        userId,
        workspaceId,
        runType: "rerank",
        provider: "cohere",
        modelName: AI_MODELS.COHERE_RERANK,
        promptVersion: "rerank-v1",
        inputHash: hashText(queryText),
        error: normalized.message,
      });
    }
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
        rerank_score: rerankScoreMap.get(id) ?? null,
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

  const { data: canonicalEdges } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, status")
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

  type InferredEdgeCandidate = {
    candidateId: string;
    confidence: number;
    edge_type: string;
    explanation: string;
  };

  const inferredCandidates: InferredEdgeCandidate[] = [];

  // 7. Infer edges in parallel — failures are per-pair, never propagate
  let proposed = 0;
  let skipped = 0;
  let failed = 0;
  const paused = 0;

  await Promise.all(
    topIds.map(async (candidateId) => {
      const candidate = candidateMap.get(candidateId);
      if (!candidate) { skipped++; return; }

      const fwd = `${nodeId}:${candidateId}`;
      const rev = `${candidateId}:${nodeId}`;

      if (activePairs.has(fwd) || activePairs.has(rev)) { skipped++; return; }
      if (rejectedPairs.has(fwd) || rejectedPairs.has(rev)) { skipped++; return; }
      if (canonicalPairs.has(fwd) || canonicalPairs.has(rev)) { skipped++; return; }

      try {
        const result = await aiProvider().inferEdge({
          source_node: { id: nodeId, title: sourceTitle, summary: sourceSummary },
          target_node: {
            id: candidateId,
            title: candidate.title,
            summary: candidate.summary,
          },
          workspace_context: workspaceContext,
        });

        // Persist ai_run (best-effort)
        void persistAIRun({
          supabase,
          userId,
          workspaceId,
          source: "connection-infer-edge",
          run: {
            ...result.run,
            run_type: "infer_edge",
            prompt_version: INFER_EDGE_PROMPT_VERSION,
            status: "success",
          },
        });

        const out = result.output;
        if (
          out.related &&
          out.edge_type &&
          out.confidence >= AI_CONFIDENCE.EDGE_INFERENCE_MIN
        ) {
          inferredCandidates.push({
            candidateId,
            confidence: out.confidence,
            edge_type: out.edge_type,
            explanation: out.explanation,
          });
        } else {
          skipped++;
        }
      } catch (err) {
        const normalized = normalizeAIError(err, "Edge inference failed");
        console.error("[connection] inferEdge failed:", normalized.message);
        if (isMalformedAIResponseError(err)) {
          void logMalformedOutputFailure({
            supabase,
            userId,
            workspaceId,
            error: err,
            linkedEntityIds: [nodeId, candidateId],
          });
        } else {
          void logFailedAIRun({
            supabase,
            userId,
            workspaceId,
            runType: "infer_edge",
            provider: "claude",
            modelName: AI_MODELS.CLAUDE_SONNET,
            promptVersion: INFER_EDGE_PROMPT_VERSION,
            inputHash: hashText(`${sourceTitle}\n${candidate.title}`),
            error: normalized.message,
          });
        }
        if (normalized.code === "malformed_output") {
          skipped++;
        } else {
          failed++;
        }
      }
    })
  );

  if (inferredCandidates.length === 0) {
    return { proposed, skipped, failed, paused };
  }

  const structuralTypePriority: Record<string, number> = {
    belongs_to: 4,
    prerequisite_for: 3,
    required_for: 3,
    depends_on: 2,
  };

  const selected: InferredEdgeCandidate[] = [];

  const bestStructural = [...inferredCandidates]
    .filter((candidate) => candidate.edge_type in structuralTypePriority)
    .sort((a, b) => {
      const priorityDelta =
        structuralTypePriority[b.edge_type] - structuralTypePriority[a.edge_type];
      if (priorityDelta !== 0) return priorityDelta;
      return b.confidence - a.confidence;
    })[0];

  if (bestStructural) {
    selected.push(bestStructural);
  }

  const bestSemantic = [...inferredCandidates]
    .filter((candidate) => {
      if (bestStructural && candidate.candidateId === bestStructural.candidateId) return false;
      if (candidate.edge_type in structuralTypePriority) return false;
      if (candidate.edge_type === "related_to") return candidate.confidence >= 0.82;
      return candidate.confidence >= 0.7;
    })
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (bestSemantic) {
    selected.push(bestSemantic);
  }

  skipped += Math.max(inferredCandidates.length - selected.length, 0);

  for (const candidate of selected) {
    const normalized =
      candidate.edge_type === "depends_on"
        ? {
            edge_type: "required_for",
            source_node_id: candidate.candidateId,
            target_node_id: nodeId,
          }
        : {
            edge_type: candidate.edge_type,
            source_node_id: nodeId,
            target_node_id: candidate.candidateId,
          };

    const { error } = await supabase.from("proposed_edges").insert({
      workspace_id: workspaceId,
      user_id: userId,
      source_node_id: normalized.source_node_id,
      target_node_id: normalized.target_node_id,
      edge_type: normalized.edge_type,
      confidence: candidate.confidence,
      explanation: candidate.explanation,
      proposal_status: "pending_review",
    });
    if (error) failed++;
    else proposed++;
  }

  return { proposed, skipped, failed, paused };
}

export async function processQueuedConnectionAnalysisRetries(params: {
  supabase: SupabaseClient;
  userId?: string;
  workspaceId?: string;
  limit?: number;
}): Promise<{ processed: number; completed: number; requeued: number; failed: number }> {
  const { supabase, userId, workspaceId, limit = AI_RETRY_QUEUE.BATCH_SIZE } = params;

  let query = supabase
    .from("ai_retry_queue")
    .select("id, user_id, workspace_id, payload, attempt_count")
    .eq("job_type", ANALYZE_RETRY_JOB_TYPE)
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .order("available_at", { ascending: true })
    .limit(limit);

  if (userId) {
    query = query.eq("user_id", userId);
  }
  if (workspaceId) {
    query = query.eq("workspace_id", workspaceId);
  }

  const { data: jobs, error } = await query;
  if (error || !jobs?.length) {
    if (error) {
      console.error("[connection] failed to fetch analysis retry queue:", error);
    }
    return { processed: 0, completed: 0, requeued: 0, failed: 0 };
  }

  let processed = 0;
  let completed = 0;
  let requeued = 0;
  let failed = 0;

  for (const rawJob of jobs as Pick<
    AIRetryJob,
    "id" | "user_id" | "workspace_id" | "payload" | "attempt_count"
  >[]) {
    const jobPayload = rawJob.payload ?? {};
    const nodeId = typeof jobPayload.node_id === "string" ? jobPayload.node_id : null;
    const excludeNodeIds = Array.isArray(jobPayload.exclude_node_ids)
      ? jobPayload.exclude_node_ids.filter((value): value is string => typeof value === "string")
      : [];
    const nextAttempt = (rawJob.attempt_count ?? 0) + 1;

    processed += 1;

    if (!nodeId || !rawJob.workspace_id) {
      await supabase
        .from("ai_retry_queue")
        .update({
          status: "failed",
          attempt_count: nextAttempt,
          last_error: "Retry job payload is missing required analysis fields",
          updated_at: new Date().toISOString(),
        })
        .eq("id", rawJob.id);
      failed += 1;
      continue;
    }

    const { error: lockError } = await supabase
      .from("ai_retry_queue")
      .update({
        status: "processing",
        attempt_count: nextAttempt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rawJob.id)
      .eq("status", "queued");

    if (lockError) {
      console.error("[connection] failed to claim analysis retry job:", lockError);
      continue;
    }

    const result = await runConnectionAnalysis({
      nodeId,
      excludeNodeIds,
      workspaceId: rawJob.workspace_id,
      userId: rawJob.user_id,
      supabase,
    }).catch(() => ({ proposed: 0, skipped: 0, failed: 1, paused: 0 }));

    if (result.paused > 0 && nextAttempt < AI_RETRY_QUEUE.MAX_ATTEMPTS) {
      await supabase
        .from("ai_retry_queue")
        .update({
          status: "queued",
          available_at: new Date(Date.now() + AI_RETRY_QUEUE.DELAY_MS).toISOString(),
          last_error: "Connection analysis is still waiting on deferred embeddings",
          updated_at: new Date().toISOString(),
        })
        .eq("id", rawJob.id);
      requeued += 1;
      continue;
    }

    if (result.failed > 0 && result.proposed === 0 && nextAttempt < AI_RETRY_QUEUE.MAX_ATTEMPTS) {
      await supabase
        .from("ai_retry_queue")
        .update({
          status: "queued",
          available_at: new Date(Date.now() + AI_RETRY_QUEUE.DELAY_MS).toISOString(),
          last_error: `Connection analysis still failing (${result.failed})`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", rawJob.id);
      requeued += 1;
      continue;
    }

    await supabase
      .from("ai_retry_queue")
      .update({
        status: result.failed > 0 && result.proposed === 0 ? "failed" : "completed",
        last_error:
          result.failed > 0 && result.proposed === 0
            ? `Connection analysis failed (${result.failed})`
            : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rawJob.id);

    if (result.failed > 0 && result.proposed === 0) {
      failed += 1;
    } else {
      completed += 1;
    }
  }

  return { processed, completed, requeued, failed };
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
