import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_JOBS } from "@/lib/ai/config";
import { runConnectionBatch } from "@/lib/ai/connection";
import { buildWorkspaceProfileContext } from "@/lib/ai/workspace-profile";
import { backfillEmbeddings } from "@/lib/ai/embeddings";
import {
  backoffDelayMs,
  hashText,
  normalizeAIError,
} from "@/lib/ai/errors";
import { runPrerequisiteCascade } from "@/lib/ai/lifecycle";
import { detectDuplicates } from "@/lib/ai/merge";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AIJob, AIJobType } from "@/types/ai";
import type { NodeType } from "@/types/graph";

export interface EnqueueAIJobParams {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string | null;
  jobType: AIJobType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  delayMs?: number;
}

export interface ProcessAIJobsBatchResult {
  completed: number;
  deadLettered: number;
  failed: number;
  processed: number;
  requeued: number;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function buildAIJobIdempotencyKey(jobType: AIJobType, payload: Record<string, unknown>) {
  return `${jobType}:${hashText(stableStringify(payload))}`;
}

export function nextAIJobDelayMs(attemptCount: number) {
  return Math.min(backoffDelayMs(attemptCount, 1_000), 60_000);
}

type JobSummary = Record<string, unknown>;

async function runAIJob(params: {
  job: AIJob;
  supabase: SupabaseClient;
}): Promise<JobSummary> {
  const { job, supabase } = params;

  switch (job.job_type) {
    case "embedding_backfill": {
      const workspaceId =
        typeof job.payload.workspace_id === "string" ? job.payload.workspace_id : job.workspace_id;
      const limit =
        typeof job.payload.limit === "number" && Number.isFinite(job.payload.limit)
          ? Math.max(1, Math.floor(job.payload.limit))
          : undefined;

      if (!workspaceId) {
        throw new Error("embedding_backfill job missing workspace_id");
      }

      return backfillEmbeddings({
        workspaceId,
        userId: job.user_id,
        supabase,
        limit,
      });
    }

    case "score_recompute": {
      const workspaceId =
        typeof job.payload.workspace_id === "string" ? job.payload.workspace_id : job.workspace_id;

      if (!workspaceId) {
        throw new Error("score_recompute job missing workspace_id");
      }

      return computeWorkspaceScores({
        workspaceId,
        userId: job.user_id,
        supabase,
      });
    }

    case "lifecycle_cascade": {
      const workspaceId =
        typeof job.payload.workspace_id === "string" ? job.payload.workspace_id : job.workspace_id;
      const triggeredByNodeId =
        typeof job.payload.triggered_by_node_id === "string"
          ? job.payload.triggered_by_node_id
          : null;
      const lifecycleEventId =
        typeof job.payload.lifecycle_event_id === "string"
          ? job.payload.lifecycle_event_id
          : null;
      const newStatus =
        job.payload.new_status === "completed" || job.payload.new_status === "active"
          ? job.payload.new_status
          : null;

      if (!workspaceId || !triggeredByNodeId || !lifecycleEventId || !newStatus) {
        throw new Error("lifecycle_cascade job missing required lifecycle payload");
      }

      const cascade = await runPrerequisiteCascade({
        triggeredByNodeId,
        newStatus,
        workspaceId,
        userId: job.user_id,
        lifecycleEventId,
        supabase,
      });

      return {
        cascade_count: cascade.cascadeCount,
        newly_available_count: cascade.newlyAvailable.length,
      };
    }

    case "connection_batch": {
      const workspaceId =
        typeof job.payload.workspace_id === "string" ? job.payload.workspace_id : job.workspace_id;
      const nodeIds = Array.isArray(job.payload.node_ids)
        ? job.payload.node_ids.filter((value): value is string => typeof value === "string")
        : [];

      if (!workspaceId || nodeIds.length === 0) {
        throw new Error("connection_batch job missing workspace_id or node_ids");
      }

      // Build workspace context ONCE for the batch — the same snapshot goes
      // into every inferEdge call of the batch (one per group of nodes).
      let batchWorkspaceContext: string | undefined;
      try {
        const context = await buildWorkspaceProfileContext({
          workspaceId,
          userId: job.user_id,
          supabase,
        });
        batchWorkspaceContext = context.workspaceContext;
      } catch {
        batchWorkspaceContext = undefined;
      }

      const results = await runConnectionBatch({
        nodeIds,
        excludeFor: (nodeId) => nodeIds.filter((candidateId) => candidateId !== nodeId),
        workspaceId,
        userId: job.user_id,
        supabase,
        workspaceContext: batchWorkspaceContext,
      });

      return results.reduce(
        (acc, result) => ({
          proposed: acc.proposed + result.proposed,
          skipped: acc.skipped + result.skipped,
          failed: acc.failed + result.failed,
          processed_nodes: nodeIds.length,
        }),
        { proposed: 0, skipped: 0, failed: 0, processed_nodes: nodeIds.length },
      );
    }

    case "duplicate_detection": {
      const workspaceId =
        typeof job.payload.workspace_id === "string" ? job.payload.workspace_id : job.workspace_id;
      const nodeIds = Array.isArray(job.payload.node_ids)
        ? job.payload.node_ids.filter((value): value is string => typeof value === "string")
        : [];

      if (!workspaceId || nodeIds.length === 0) {
        throw new Error("duplicate_detection job missing workspace_id or node_ids");
      }

      const { data: nodes, error } = await supabase
        .from("nodes")
        .select("id, title, summary, node_type")
        .in("id", nodeIds)
        .eq("workspace_id", workspaceId)
        .eq("user_id", job.user_id);

      if (error) {
        throw new Error(`duplicate_detection fetch failed: ${error.message}`);
      }

      const candidates = await detectDuplicates({
        newNodes: (nodes ?? []).map((node) => ({
          id: node.id as string,
          title: node.title as string,
          summary: node.summary as string | null,
          node_type: node.node_type as NodeType,
        })),
        workspaceId,
        userId: job.user_id,
        supabase,
      });

      return {
        processed_nodes: nodeIds.length,
        suggestions_created: candidates.length,
      };
    }
  }
}

async function markAIJobCompleted(params: {
  jobId: string;
  resultSummary: JobSummary;
  supabase: SupabaseClient;
}) {
  const { jobId, resultSummary, supabase } = params;

  await supabase
    .from("ai_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result_summary: resultSummary,
      last_error: null,
      dead_letter_reason: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function resetAIJobToQueued(params: {
  availableAt?: string;
  clearAttempts?: boolean;
  error?: string | null;
  job: AIJob;
  maxAttempts?: number;
  supabase: SupabaseClient;
}) {
  const {
    availableAt,
    clearAttempts = false,
    error = null,
    job,
    maxAttempts = job.max_attempts,
    supabase,
  } = params;
  const nextAvailableAt =
    availableAt ?? new Date(Date.now() + nextAIJobDelayMs(job.attempt_count)).toISOString();

  await supabase
    .from("ai_jobs")
    .update({
      status: "queued",
      attempt_count: clearAttempts ? 0 : job.attempt_count,
      max_attempts: maxAttempts,
      available_at: nextAvailableAt,
      completed_at: null,
      result_summary: {},
      locked_at: null,
      last_error: error ? error.slice(0, 1000) : null,
      dead_letter_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}

async function markAIJobFailed(params: {
  deadLetter: boolean;
  error: string;
  job: AIJob;
  supabase: SupabaseClient;
}) {
  const { deadLetter, error, job, supabase } = params;

  await supabase
    .from("ai_jobs")
    .update({
      status: deadLetter ? "dead_lettered" : "failed",
      dead_letter_reason: deadLetter ? error.slice(0, 1000) : null,
      last_error: error.slice(0, 1000),
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}

async function claimAIJobs(params: {
  limit: number;
  supabase: SupabaseClient;
}): Promise<AIJob[]> {
  const { limit, supabase } = params;

  const { data: queuedJobs, error } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .order("available_at", { ascending: true })
    .limit(limit);

  if (error || !queuedJobs?.length) {
    if (error) {
      console.error("[ai/jobs] failed to fetch queued jobs:", error);
    }
    return [];
  }

  const claimed: AIJob[] = [];

  for (const job of queuedJobs as AIJob[]) {
    const { data: claimedJob, error: claimError } = await supabase
      .from("ai_jobs")
      .update({
        status: "processing",
        attempt_count: (job.attempt_count ?? 0) + 1,
        locked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "queued")
      .select("*")
      .single();

    if (claimError || !claimedJob) {
      continue;
    }

    claimed.push(claimedJob as AIJob);
  }

  return claimed;
}

export async function enqueueAIJob(params: EnqueueAIJobParams): Promise<AIJob> {
  const {
    supabase,
    userId,
    workspaceId,
    jobType,
    payload,
    maxAttempts = AI_JOBS.MAX_ATTEMPTS,
    delayMs = 0,
  } = params;
  const idempotencyKey = params.idempotencyKey ?? buildAIJobIdempotencyKey(jobType, payload);

  const { data: existing } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existing) {
    const typedExisting = existing as AIJob;

    if (typedExisting.status === "queued" || typedExisting.status === "processing") {
      return typedExisting;
    }

    await resetAIJobToQueued({
      job: typedExisting,
      maxAttempts,
      clearAttempts: true,
      availableAt: new Date(Date.now() + delayMs).toISOString(),
      supabase,
    });

    const { data: resetJob, error: resetError } = await supabase
      .from("ai_jobs")
      .select("*")
      .eq("id", typedExisting.id)
      .single();

    if (resetError || !resetJob) {
      throw new Error(resetError?.message ?? "Failed to reset existing AI job");
    }

    return resetJob as AIJob;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("ai_jobs")
    .insert({
      user_id: userId,
      workspace_id: workspaceId,
      job_type: jobType,
      idempotency_key: idempotencyKey,
      payload,
      status: "queued",
      attempt_count: 0,
      max_attempts: maxAttempts,
      available_at: new Date(Date.now() + delayMs).toISOString(),
    })
    .select("*")
    .single();

  if (insertError || !inserted) {
    throw new Error(insertError?.message ?? "Failed to enqueue AI job");
  }

  return inserted as AIJob;
}

export async function drainAIJobsWithAdminClient(params?: {
  limit?: number;
}): Promise<ProcessAIJobsBatchResult | null> {
  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return null;
  }

  return processAIJobsBatch({
    supabase,
    limit: params?.limit,
  });
}

export async function processAIJobsBatch(params: {
  limit?: number;
  supabase: SupabaseClient;
}): Promise<ProcessAIJobsBatchResult> {
  const { supabase, limit = AI_JOBS.BATCH_SIZE } = params;
  const jobs = await claimAIJobs({ supabase, limit });

  if (jobs.length === 0) {
    return { processed: 0, completed: 0, requeued: 0, failed: 0, deadLettered: 0 };
  }

  let completed = 0;
  let requeued = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const job of jobs) {
    try {
      const resultSummary = await runAIJob({ job, supabase });
      await markAIJobCompleted({
        jobId: job.id,
        resultSummary,
        supabase,
      });
      completed += 1;
    } catch (error) {
      const normalized = normalizeAIError(error, "AI job failed");
      const exhaustedAttempts = job.attempt_count >= job.max_attempts;

      if (normalized.retryable && !exhaustedAttempts) {
        await resetAIJobToQueued({
          job,
          error: normalized.message,
          supabase,
        });
        requeued += 1;
        continue;
      }

      await markAIJobFailed({
        deadLetter: exhaustedAttempts,
        job,
        error: normalized.message,
        supabase,
      });

      if (exhaustedAttempts) {
        deadLettered += 1;
      } else {
        failed += 1;
      }
    }
  }

  return {
    processed: jobs.length,
    completed,
    requeued,
    failed,
    deadLettered,
  };
}
