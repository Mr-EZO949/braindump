// POST /api/nodes/analyze
// Triggers connection analysis for a set of newly-accepted nodes.
// Small interactive batches run inline; larger batches are queued for the durable worker.
// Inline runs still return pending proposed edges for immediate review.

import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  runConnectionAnalysis,
  fetchPendingEdges,
  processQueuedConnectionAnalysisRetries,
  queueConnectionAnalysisRetry,
} from "@/lib/ai/connection";
import { generateAndStoreEmbedding, processQueuedEmbeddingRetries } from "@/lib/ai/embeddings";
import { detectDuplicates } from "@/lib/ai/merge";
import { drainAIJobsWithAdminClient, enqueueAIJob } from "@/lib/ai/jobs";
import { AI_FLAGS, AI_JOBS, AI_RATE_LIMITS, AI_RETRY_QUEUE } from "@/lib/ai/config";
import { waitFor } from "@/lib/ai/errors";
import { checkAIRunRateLimit, rateLimitResponse } from "@/lib/ai/rate-limit";
import type { EmbedResult } from "@/lib/ai/embeddings";

function normalizeNodeIds(nodeIds: string[]) {
  return Array.from(
    new Set(nodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string" && nodeId.length > 0)),
  ).sort();
}

export async function POST(req: NextRequest) {
  if (!AI_FLAGS.EDGE_INFERENCE_ENABLED) {
    return NextResponse.json({ proposed_edges: [], skipped: true });
  }

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { node_ids, workspace_id, async: asyncRequested } = body as {
    node_ids?: string[];
    workspace_id?: string;
    async?: boolean;
  };
  const normalizedNodeIds = Array.isArray(node_ids) ? normalizeNodeIds(node_ids) : [];

  if (normalizedNodeIds.length === 0) {
    return NextResponse.json({ error: "node_ids must be a non-empty array" }, { status: 400 });
  }
  if (!workspace_id || typeof workspace_id !== "string") {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  // Verify workspace belongs to this user — prevents cross-workspace job injection
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  // Rate limit: max N connection-analysis batches per hour
  const rl = await checkAIRunRateLimit({
    supabase,
    userId: user.id,
    runType: "infer_edge",
    maxPerHour: AI_RATE_LIMITS.ANALYSES_PER_HOUR,
  });
  if (!rl.allowed) return rateLimitResponse(rl);

  let asyncFallbackWarning: string | null = null;
  const shouldQueueAsync =
    asyncRequested === true || normalizedNodeIds.length >= AI_JOBS.ANALYZE_ASYNC_THRESHOLD;

  if (shouldQueueAsync) {
    const payload = {
      workspace_id,
      node_ids: normalizedNodeIds,
    };

    try {
      const [connectionJob, duplicateJob] = await Promise.all([
        enqueueAIJob({
          supabase,
          userId: user.id,
          workspaceId: workspace_id,
          jobType: "connection_batch",
          payload,
        }),
        enqueueAIJob({
          supabase,
          userId: user.id,
          workspaceId: workspace_id,
          jobType: "duplicate_detection",
          payload,
        }),
      ]);

      after(async () => {
        try {
          await drainAIJobsWithAdminClient();
        } catch (error) {
          console.error("[api/nodes/analyze] failed to drain AI jobs:", error);
        }
      });

      return NextResponse.json({
        proposed_edges: [],
        merge_candidates: [],
        proposed: 0,
        skipped: 0,
        failed: 0,
        paused: 0,
        queued: true,
        job_ids: [connectionJob.id, duplicateJob.id],
        warning:
          normalizedNodeIds.length === 1
            ? "Connection analysis was queued for 1 node and will continue in the background."
            : `Connection analysis was queued for ${normalizedNodeIds.length} nodes and will continue in the background.`,
      });
    } catch (error) {
      console.error("[api/nodes/analyze] failed to queue async jobs:", error);
      asyncFallbackWarning =
        "Background queue was unavailable, so connection analysis ran inline instead.";
    }
  }

  // Step 1: Fetch all node titles/summaries and embed them — sequentially so each
  // node is in node_embeddings before matchNodes runs on any sibling.
  // This ensures "neural nets" can find "ML class" even though both were just accepted.
  const { data: nodeRows } = await supabase
    .from("nodes")
    .select("id, title, summary")
    .in("id", normalizedNodeIds)
    .eq("workspace_id", workspace_id)
    .eq("user_id", user.id);

  let paused = 0;

  for (const node of nodeRows ?? []) {
    const embedResult = await generateAndStoreEmbedding({
      nodeId: node.id as string,
      title: node.title as string,
      summary: node.summary as string | null,
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
    }).catch((): EmbedResult => ({ ok: false, error: "Embedding generation failed", errorCode: "unknown" }));

    if (!embedResult.ok && embedResult.queued) {
      paused += 1;
      await queueConnectionAnalysisRetry({
        nodeId: node.id as string,
        excludeNodeIds: normalizedNodeIds.filter((candidateId) => candidateId !== node.id),
        workspaceId: workspace_id,
        userId: user.id,
        supabase,
        error: embedResult.error,
      });
    }
  }

  // Step 2: Run connection analysis for each node in parallel — failures are per-node.
  const results = await Promise.all(
    normalizedNodeIds.map((nodeId) =>
      runConnectionAnalysis({
        nodeId,
        excludeNodeIds: normalizedNodeIds.filter((candidateId) => candidateId !== nodeId),
        workspaceId: workspace_id,
        userId: user.id,
        supabase,
      })
        .catch(() => ({ proposed: 0, skipped: 0, failed: 1, paused: 0 }))
    )
  );

  await Promise.all(
    results.map((result, index) => {
      if (result.paused <= 0) {
        return Promise.resolve();
      }

      return queueConnectionAnalysisRetry({
        nodeId: normalizedNodeIds[index],
        excludeNodeIds: normalizedNodeIds.filter((candidateId) => candidateId !== normalizedNodeIds[index]),
        workspaceId: workspace_id,
        userId: user.id,
        supabase,
        error: "Connection analysis is waiting on deferred embeddings",
      });
    })
  );

  const totals = results.reduce(
    (acc, r) => ({
      proposed: acc.proposed + r.proposed,
      skipped: acc.skipped + r.skipped,
      failed: acc.failed + r.failed,
      paused: acc.paused + r.paused,
    }),
    { proposed: 0, skipped: 0, failed: 0, paused }
  );

  const proposed_edges = await fetchPendingEdges({
    workspaceId: workspace_id,
    userId: user.id,
    nodeIds: normalizedNodeIds,
    supabase,
  });

  // Phase 6 — detect near-duplicate nodes among the newly accepted batch
  const merge_candidates = await detectDuplicates({
    newNodes: (nodeRows ?? []).map((n) => ({
      id: n.id as string,
      title: n.title as string,
      summary: n.summary as string | null,
    })),
    workspaceId: workspace_id,
    userId: user.id,
    supabase,
  });

  const warnings: string[] = [];
  if (asyncFallbackWarning) {
    warnings.push(asyncFallbackWarning);
  }
  if (totals.failed > 0) {
    warnings.push(
      totals.proposed > 0
        ? `Some connection checks failed (${totals.failed}), but partial results are still shown.`
        : `Some connection checks failed (${totals.failed}). Retry when ready.`,
    );
  }
  if (totals.paused > 0) {
    warnings.push(
      totals.paused === 1
        ? "Connection analysis is paused for 1 node because embedding retries were queued. It will resume shortly."
        : `Connection analysis is paused for ${totals.paused} nodes because embedding retries were queued. It will resume shortly.`,
    );
  }

  after(async () => {
    try {
      await drainAIJobsWithAdminClient();
    } catch (error) {
      console.error("[api/nodes/analyze] failed to drain AI jobs:", error);
    }

    await processQueuedEmbeddingRetries({
      supabase,
      userId: user.id,
      workspaceId: workspace_id,
    });
    await processQueuedConnectionAnalysisRetries({
      supabase,
      userId: user.id,
      workspaceId: workspace_id,
    });

    if (totals.paused > 0) {
      await waitFor(AI_RETRY_QUEUE.DELAY_MS);
      await processQueuedEmbeddingRetries({
        supabase,
        userId: user.id,
        workspaceId: workspace_id,
      });
      await processQueuedConnectionAnalysisRetries({
        supabase,
        userId: user.id,
        workspaceId: workspace_id,
      });
    }
  });

  return NextResponse.json({
    proposed_edges,
    merge_candidates,
    warning: warnings.join(" "),
    ...totals,
  });
}
