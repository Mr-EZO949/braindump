// Embedding service for Phase 4.
// Generates, stores, and retrieves node embeddings.
// Failures are caught per-node — never block node acceptance.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider } from "@/lib/ai/index";
import { AI_FLAGS, AI_MODELS, AI_CANDIDATES, AI_INGESTION, AI_RETRY_QUEUE } from "@/lib/ai/config";
import {
  executeWithRetry,
  hashText,
  logFailedAIRun,
  logMalformedOutputFailure,
  normalizeAIError,
  type AIErrorCode,
  isMalformedAIResponseError,
} from "@/lib/ai/errors";
import { persistAIRun } from "@/lib/ai/telemetry";
import type { AIRetryJob } from "@/types/ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbedNodeParams {
  nodeId: string;
  title: string;
  summary: string | null;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}

export interface MatchNodesParams {
  queryText: string;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  excludeNodeId?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export interface MatchedNode {
  node_id: string;
  title: string;
  node_type: string;
  summary: string | null;
  similarity: number;
}

export type EmbedResult =
  | { ok: true }
  | { ok: false; error: string; errorCode: AIErrorCode; queued?: boolean };

const EMBEDDING_RETRY_JOB_TYPE = "embed_node";

function buildEmbeddingRetryDedupeKey(nodeId: string) {
  return `${EMBEDDING_RETRY_JOB_TYPE}:${nodeId}`;
}

async function upsertEmbeddingVector(params: {
  nodeId: string;
  workspaceId: string;
  userId: string;
  embeddingVector: number[];
  supabase: SupabaseClient;
}): Promise<EmbedResult> {
  const { nodeId, workspaceId, userId, embeddingVector, supabase } = params;

  const { error: upsertError } = await supabase
    .from("node_embeddings")
    .upsert(
      {
        node_id: nodeId,
        user_id: userId,
        workspace_id: workspaceId,
        embedding: JSON.stringify(embeddingVector),
        model: AI_MODELS.GEMINI_EMBEDDING,
        embedded_at: new Date().toISOString(),
      },
      { onConflict: "node_id" }
    );

  if (upsertError) {
    return { ok: false, error: upsertError.message, errorCode: "unknown" };
  }

  return { ok: true };
}

async function enqueueEmbeddingRetry(params: {
  nodeId: string;
  title: string;
  summary: string | null;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  error: string;
}): Promise<boolean> {
  const { nodeId, title, summary, workspaceId, userId, supabase, error } = params;
  const now = new Date();

  const { error: queueError } = await supabase.from("ai_retry_queue").upsert(
    {
      user_id: userId,
      workspace_id: workspaceId,
      job_type: EMBEDDING_RETRY_JOB_TYPE,
      dedupe_key: buildEmbeddingRetryDedupeKey(nodeId),
      payload: {
        node_id: nodeId,
        title,
        summary,
      },
      status: "queued",
      available_at: new Date(now.getTime() + AI_RETRY_QUEUE.DELAY_MS).toISOString(),
      last_error: error.slice(0, 1000),
      updated_at: now.toISOString(),
    },
    { onConflict: "dedupe_key" }
  );

  if (queueError) {
    console.error("[ai/embeddings] failed to queue retry:", queueError);
    return false;
  }

  return true;
}

async function requestEmbedding(params: {
  inputText: string;
  userId: string;
  workspaceId: string;
  supabase: SupabaseClient;
}) {
  const { inputText, userId, workspaceId, supabase } = params;

  const result = await executeWithRetry({
    maxRetries: AI_INGESTION.EMBEDDING_MAX_RETRIES,
    operation: () => aiProvider().generateEmbedding({ text: inputText }),
    onRetry: async ({ attempt, error }) => {
      await logFailedAIRun({
        supabase,
        userId,
        workspaceId,
        runType: "embed",
        provider: "gemini",
        modelName: AI_MODELS.GEMINI_EMBEDDING,
        promptVersion: "embed-v1",
        inputHash: hashText(inputText),
        status: "retrying",
        error: `Attempt ${attempt + 1} failed: ${error.message}`,
      });
    },
  });

  await persistAIRun({
    supabase,
    userId,
    workspaceId,
    source: "embeddings",
    run: result.run,
  });

  return result;
}

// ---------------------------------------------------------------------------
// generateAndStoreEmbedding
// Embeds a node's title + summary and upserts into node_embeddings.
// Safe to call after node acceptance — catches all errors internally.
// ---------------------------------------------------------------------------

export async function generateAndStoreEmbedding(
  params: EmbedNodeParams,
  options?: {
    allowQueue?: boolean;
  }
): Promise<EmbedResult> {
  if (!AI_FLAGS.EMBEDDING_ENABLED) {
    return { ok: false, error: "Embedding disabled", errorCode: "unknown" };
  }

  const { nodeId, title, summary, workspaceId, userId, supabase } = params;
  const allowQueue = options?.allowQueue ?? true;

  const inputText = [title, summary].filter(Boolean).join("\n").trim();
  if (!inputText) {
    return { ok: false, error: "Empty input text", errorCode: "unknown" };
  }

  let embeddingVector: number[];
  try {
    const result = await requestEmbedding({
      inputText,
      userId,
      workspaceId,
      supabase,
    });
    embeddingVector = result.output.embedding;
  } catch (err) {
    const normalized = normalizeAIError(err, "Embedding generation failed");

    if (isMalformedAIResponseError(err)) {
      await logMalformedOutputFailure({
        supabase,
        userId,
        workspaceId,
        error: err,
        linkedEntityIds: [nodeId],
      });
    } else {
      await logFailedAIRun({
        supabase,
        userId,
        workspaceId,
        runType: "embed",
        provider: "gemini",
        modelName: AI_MODELS.GEMINI_EMBEDDING,
        promptVersion: "embed-v1",
        inputHash: hashText(inputText),
        status: "failed",
        error: normalized.message,
      });
    }

    if (allowQueue && normalized.retryable) {
      const queued = await enqueueEmbeddingRetry({
        nodeId,
        title,
        summary,
        workspaceId,
        userId,
        supabase,
        error: normalized.message,
      });

      if (queued) {
        return {
          ok: false,
          error:
            normalized.code === "rate_limit"
              ? "Embedding generation is paused due to provider rate limits. It will resume shortly."
              : "Embedding generation was deferred and will retry shortly.",
          errorCode: normalized.code,
          queued: true,
        };
      }
    }

    return {
      ok: false,
      error: normalized.userMessage,
      errorCode: normalized.code,
    };
  }

  return upsertEmbeddingVector({
    nodeId,
    workspaceId,
    userId,
    embeddingVector,
    supabase,
  });
}

// ---------------------------------------------------------------------------
// matchNodes
// Embeds a query string then calls the match_nodes RPC.
// Returns similar nodes sorted by cosine similarity descending.
// ---------------------------------------------------------------------------

export async function matchNodes(
  params: MatchNodesParams
): Promise<MatchedNode[]> {
  const {
    queryText,
    workspaceId,
    userId,
    supabase,
    excludeNodeId,
    includeCompleted = false,
    limit = AI_CANDIDATES.RETRIEVAL_K,
  } = params;

  const result = await requestEmbedding({
    inputText: queryText,
    userId,
    workspaceId,
    supabase,
  }).catch(async (err) => {
    const normalized = normalizeAIError(err, "Embedding generation failed");

    if (isMalformedAIResponseError(err)) {
      await logMalformedOutputFailure({
        supabase,
        userId,
        workspaceId,
        error: err,
      });
    } else {
      await logFailedAIRun({
        supabase,
        userId,
        workspaceId,
        runType: "embed",
        provider: "gemini",
        modelName: AI_MODELS.GEMINI_EMBEDDING,
        promptVersion: "embed-v1",
        inputHash: hashText(queryText),
        status: "failed",
        error: normalized.message,
      });
    }

    throw new Error(normalized.userMessage);
  });

  const { data, error } = await supabase.rpc("match_nodes", {
    query_embedding: JSON.stringify(result.output.embedding),
    match_user_id: userId,
    match_workspace_id: workspaceId,
    match_count: limit,
    exclude_node_id: excludeNodeId ?? null,
    include_completed: includeCompleted,
  });

  if (error) throw new Error(`match_nodes RPC failed: ${error.message}`);

  return (data ?? []) as MatchedNode[];
}

// ---------------------------------------------------------------------------
// embedTexts — many texts, ONE provider call, one ai_run row.
// Used at ingestion (dump segments for retrieval, proposals for dedup).
// Throws on provider failure; callers treat retrieval/dedup as best-effort.
// ---------------------------------------------------------------------------

export async function embedTexts(params: {
  texts: string[];
  userId: string;
  workspaceId: string;
  supabase: SupabaseClient;
}): Promise<number[][]> {
  const { texts, userId, workspaceId, supabase } = params;
  if (texts.length === 0 || !AI_FLAGS.EMBEDDING_ENABLED) return [];

  const result = await executeWithRetry({
    maxRetries: AI_INGESTION.EMBEDDING_MAX_RETRIES,
    operation: () => aiProvider().generateEmbeddings({ texts }),
  });
  await persistAIRun({ supabase, userId, workspaceId, source: "embeddings", run: result.run });
  return result.output.embeddings;
}

// ---------------------------------------------------------------------------
// matchNodesByVector — match_nodes with a precomputed query vector (no embed
// call). Lets one batch embedding drive several similarity searches.
// ---------------------------------------------------------------------------

export async function matchNodesByVector(params: {
  vector: number[];
  userId: string;
  workspaceId: string;
  supabase: SupabaseClient;
  limit?: number;
  includeCompleted?: boolean;
}): Promise<MatchedNode[]> {
  const { data, error } = await params.supabase.rpc("match_nodes", {
    query_embedding: JSON.stringify(params.vector),
    match_user_id: params.userId,
    match_workspace_id: params.workspaceId,
    match_count: params.limit ?? AI_CANDIDATES.RETRIEVAL_K,
    exclude_node_id: null,
    include_completed: params.includeCompleted ?? false,
  });
  if (error) throw new Error(`match_nodes RPC failed: ${error.message}`);
  return (data ?? []) as MatchedNode[];
}

export async function processQueuedEmbeddingRetries(params: {
  supabase: SupabaseClient;
  userId?: string;
  workspaceId?: string;
  limit?: number;
}): Promise<{ processed: number; completed: number; requeued: number; failed: number }> {
  const { supabase, userId, workspaceId, limit = AI_RETRY_QUEUE.BATCH_SIZE } = params;

  let query = supabase
    .from("ai_retry_queue")
    .select("id, user_id, workspace_id, payload, attempt_count, status")
    .eq("job_type", EMBEDDING_RETRY_JOB_TYPE)
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
      console.error("[ai/embeddings] failed to fetch retry queue:", error);
    }
    return { processed: 0, completed: 0, requeued: 0, failed: 0 };
  }

  let processed = 0;
  let completed = 0;
  let requeued = 0;
  let failed = 0;

  for (const rawJob of jobs as Pick<
    AIRetryJob,
    "id" | "user_id" | "workspace_id" | "payload" | "attempt_count" | "status"
  >[]) {
    const jobPayload = rawJob.payload ?? {};
    const nodeId = typeof jobPayload.node_id === "string" ? jobPayload.node_id : null;
    const title = typeof jobPayload.title === "string" ? jobPayload.title : null;
    const summary = typeof jobPayload.summary === "string" ? jobPayload.summary : null;
    const nextAttempt = (rawJob.attempt_count ?? 0) + 1;

    processed += 1;

    if (!nodeId || !title || !rawJob.workspace_id) {
      await supabase
        .from("ai_retry_queue")
        .update({
          status: "failed",
          attempt_count: nextAttempt,
          last_error: "Retry job payload is missing required embedding fields",
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
      console.error("[ai/embeddings] failed to claim retry job:", lockError);
      continue;
    }

    const result = await generateAndStoreEmbedding(
      {
        nodeId,
        title,
        summary,
        workspaceId: rawJob.workspace_id,
        userId: rawJob.user_id,
        supabase,
      },
      { allowQueue: false }
    );

    if (result.ok) {
      await supabase
        .from("ai_retry_queue")
        .update({
          status: "completed",
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", rawJob.id);
      completed += 1;
      continue;
    }

    const retryableError =
      result.errorCode === "rate_limit" ||
      result.errorCode === "timeout" ||
      result.errorCode === "network" ||
      result.errorCode === "upstream" ||
      result.errorCode === "malformed_output";

    if (retryableError && nextAttempt < AI_RETRY_QUEUE.MAX_ATTEMPTS) {
      await supabase
        .from("ai_retry_queue")
        .update({
          status: "queued",
          available_at: new Date(Date.now() + AI_RETRY_QUEUE.DELAY_MS).toISOString(),
          last_error: result.error.slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", rawJob.id);
      requeued += 1;
      continue;
    }

    await supabase
      .from("ai_retry_queue")
      .update({
        status: "failed",
        last_error: result.error.slice(0, 1000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rawJob.id);
    failed += 1;
  }

  return { processed, completed, requeued, failed };
}

// ---------------------------------------------------------------------------
// backfillEmbeddings
// Finds accepted nodes in a workspace with no embedding and embeds them.
// Returns counts of successes and failures.
// ---------------------------------------------------------------------------

export async function backfillEmbeddings(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  limit?: number;
}): Promise<{ embedded: number; failed: number; skipped: number }> {
  if (!AI_FLAGS.EMBEDDING_ENABLED) {
    return { embedded: 0, failed: 0, skipped: 0 };
  }

  const { workspaceId, userId, supabase, limit = 50 } = params;

  // Find which nodes already have embeddings
  const { data: existing } = await supabase
    .from("node_embeddings")
    .select("node_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  const alreadyEmbedded = new Set((existing ?? []).map((r) => r.node_id as string));

  // Find active nodes in this workspace
  const { data: nodes, error } = await supabase
    .from("nodes")
    .select("id, title, summary")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(limit);

  if (error || !nodes) return { embedded: 0, failed: 0, skipped: 0 };

  const toEmbed = nodes.filter((n) => !alreadyEmbedded.has(n.id as string));
  if (toEmbed.length === 0) return { embedded: 0, failed: 0, skipped: nodes.length };

  let embedded = 0;
  let failed = 0;

  for (const node of toEmbed) {
    const result = await generateAndStoreEmbedding({
      nodeId: node.id as string,
      title: node.title as string,
      summary: node.summary as string | null,
      workspaceId,
      userId,
      supabase,
    });
    if (result.ok) embedded++;
    else failed++;
  }

  return { embedded, failed, skipped: 0 };
}
