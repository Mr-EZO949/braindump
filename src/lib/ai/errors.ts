import { createHash } from "crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AIRunStatus, AIRunType } from "@/types/ai";
import { persistAIRun } from "@/lib/ai/telemetry";

export type AIErrorCode =
  | "rate_limit"
  | "timeout"
  | "network"
  | "malformed_output"
  | "misconfigured"
  | "upstream"
  | "unknown";

export interface NormalizedAIError {
  code: AIErrorCode;
  message: string;
  retryable: boolean;
  userMessage: string;
}

interface MalformedAIResponseErrorParams {
  message: string;
  rawOutput: string;
  runType: AIRunType;
  provider: string;
  modelName: string;
  promptVersion: string;
  inputHash?: string | null;
  outputHash?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  estimatedCost?: number | null;
  /** The answer hit max_tokens — cut off, not wrong. */
  truncated?: boolean;
  cause?: unknown;
}

export class MalformedAIResponseError extends Error {
  readonly rawOutput: string;
  readonly runType: AIRunType;
  readonly provider: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly estimatedCost: number | null;
  readonly truncated: boolean;

  constructor(params: MalformedAIResponseErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = "MalformedAIResponseError";
    this.rawOutput = params.rawOutput;
    this.runType = params.runType;
    this.provider = params.provider;
    this.modelName = params.modelName;
    this.promptVersion = params.promptVersion;
    this.inputHash = params.inputHash ?? null;
    this.outputHash = params.outputHash ?? null;
    this.inputTokens = params.inputTokens ?? null;
    this.outputTokens = params.outputTokens ?? null;
    this.latencyMs = params.latencyMs ?? null;
    this.estimatedCost = params.estimatedCost ?? null;
    this.truncated = params.truncated ?? false;
  }
}

export function isMalformedAIResponseError(error: unknown): error is MalformedAIResponseError {
  return error instanceof MalformedAIResponseError;
}

const MALFORMED_OUTPUT_PATTERNS = [
  "unexpected token",
  "unexpected end of json input",
  "must be an object",
  "missing proposed_nodes array",
  "missing prompt_version",
  "missing blocks array",
  "missing related",
  "invalid block_type",
  "duplicate local_ref",
  "references unknown",
  "missing or invalid duration_minutes",
];

export function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** What the user reads when a plan's answer ran out of room. */
export const PLAN_CUT_OFF_MESSAGE =
  "This plan was too long to finish in one go. Try a shorter window — or plan the morning now and the rest later.";

export function normalizeAIError(error: unknown, fallbackMessage = "AI request failed"): NormalizedAIError {
  if (isMalformedAIResponseError(error)) {
    return {
      code: "malformed_output",
      message: error.message,
      retryable: !error.truncated,
      userMessage: error.truncated
        ? error.runType === "plan"
          ? PLAN_CUT_OFF_MESSAGE
          : "The AI's answer was too long and got cut off. Try a shorter request."
        : "The AI returned an invalid response. Please retry.",
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : fallbackMessage;
  const normalized = message.toLowerCase();

  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota")
  ) {
    return {
      code: "rate_limit",
      message,
      retryable: true,
      userMessage: "The AI provider is rate-limiting requests right now. Please retry shortly.",
    };
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("deadline exceeded")
  ) {
    return {
      code: "timeout",
      message,
      retryable: true,
      userMessage: "The AI request timed out. Please retry.",
    };
  }

  if (
    normalized.includes("network") ||
    normalized.includes("fetch failed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound")
  ) {
    return {
      code: "network",
      message,
      retryable: true,
      userMessage: "The AI request was interrupted by a network issue. Please retry.",
    };
  }

  if (
    normalized.includes("not configured") ||
    normalized.includes("is not set") ||
    normalized.includes("add it to .env")
  ) {
    return {
      code: "misconfigured",
      message,
      retryable: false,
      userMessage: "AI is not configured correctly on the server.",
    };
  }

  if (MALFORMED_OUTPUT_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return {
      code: "malformed_output",
      message,
      retryable: true,
      userMessage: "The AI returned an invalid response. Please retry.",
    };
  }

  if (
    normalized.includes("service unavailable") ||
    normalized.includes("overloaded") ||
    normalized.includes("internal server error") ||
    normalized.includes("bad gateway")
  ) {
    return {
      code: "upstream",
      message,
      retryable: true,
      userMessage: "The AI provider is temporarily unavailable. Please retry shortly.",
    };
  }

  return {
    code: "unknown",
    message,
    retryable: false,
    userMessage: fallbackMessage,
  };
}

export function backoffDelayMs(attempt: number, baseMs = 250): number {
  return baseMs * 2 ** Math.max(0, attempt);
}

export async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(params: {
  maxRetries: number;
  operation: () => Promise<T>;
  onRetry?: (ctx: {
    attempt: number;
    error: NormalizedAIError;
    // The error as thrown — a malformed-output error carries the tokens and
    // cost of the call that produced it.
    cause: unknown;
    nextDelayMs: number;
  }) => Promise<void> | void;
  shouldRetry?: (ctx: {
    attempt: number;
    error: NormalizedAIError;
  }) => boolean;
}): Promise<T> {
  const { maxRetries, operation, onRetry, shouldRetry } = params;

  let attempt = 0;
  // attempt=0 is the first call; maxRetries counts additional retries.
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const normalized = normalizeAIError(error);
      const canRetry =
        attempt < maxRetries &&
        (shouldRetry ? shouldRetry({ attempt, error: normalized }) : normalized.retryable);

      if (!canRetry) {
        throw error;
      }

      const nextDelayMs = backoffDelayMs(attempt);
      await onRetry?.({ attempt, error: normalized, cause: error, nextDelayMs });
      await waitFor(nextDelayMs);
      attempt += 1;
    }
  }
}

export async function logFailedAIRun(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string | null;
  runType: AIRunType;
  provider: string;
  modelName: string;
  promptVersion: string;
  error: string;
  status?: AIRunStatus;
  inputHash?: string | null;
  outputHash?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  estimatedCost?: number | null;
}): Promise<string | null> {
  const {
    supabase,
    userId,
    workspaceId,
    runType,
    provider,
    modelName,
    promptVersion,
    error,
    status = "failed",
    inputHash = null,
    outputHash = null,
    inputTokens = null,
    outputTokens = null,
    latencyMs = null,
    estimatedCost = null,
  } = params;

  try {
    return await persistAIRun({
      supabase,
      userId,
      workspaceId,
      source: "errors",
      run: {
        run_type: runType,
        provider,
        model_name: modelName,
        prompt_version: promptVersion,
        input_hash: inputHash,
        output_hash: outputHash,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latencyMs,
        estimated_cost: estimatedCost,
        status,
        error_text: error,
      },
    });
  } catch (logError) {
    console.error("[ai/errors] failed to log ai_run failure:", logError);
    return null;
  }
}

export async function logMalformedOutputFailure(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string | null;
  error: MalformedAIResponseError;
  linkedEntityIds?: string[] | null;
  artifactType?: string;
}): Promise<string | null> {
  const {
    supabase,
    userId,
    workspaceId,
    error,
    linkedEntityIds = null,
    artifactType = "malformed_output",
  } = params;

  const aiRunId = await logFailedAIRun({
    supabase,
    userId,
    workspaceId,
    runType: error.runType,
    provider: error.provider,
    modelName: error.modelName,
    promptVersion: error.promptVersion,
    inputHash: error.inputHash,
    outputHash: error.outputHash,
    inputTokens: error.inputTokens,
    outputTokens: error.outputTokens,
    latencyMs: error.latencyMs,
    estimatedCost: error.estimatedCost,
    status: "failed",
    error: error.message,
  });

  if (!aiRunId) {
    return null;
  }

  try {
    await supabase.from("ai_artifacts").insert({
      ai_run_id: aiRunId,
      user_id: userId,
      artifact_type: artifactType,
      payload: {
        error: error.message,
        raw_output: error.rawOutput.slice(0, 16_000),
      },
      linked_entity_ids: linkedEntityIds,
    });
  } catch (artifactError) {
    console.error("[ai/errors] failed to log malformed output artifact:", artifactError);
  }

  return aiRunId;
}
