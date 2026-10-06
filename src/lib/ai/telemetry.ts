import type { SupabaseClient } from "@supabase/supabase-js";

import type { AIRunStatus, AIRunType } from "@/types/ai";

import { cacheTokenFields, claudeCostUSD, totalInputTokens, type UsageTotals } from "./usage";

export type AIRunErrorCode =
  | "rate_limit"
  | "timeout"
  | "network"
  | "malformed_output"
  | "misconfigured"
  | "upstream"
  | "unknown";

export interface PersistAIRunParams {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string | null;
  run: {
    run_type: AIRunType;
    provider: string;
    model_name: string;
    prompt_version: string;
    input_hash?: string | null;
    output_hash?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_tokens?: number | null;
    cache_write_tokens?: number | null;
    latency_ms?: number | null;
    estimated_cost?: number | null;
    status?: AIRunStatus;
    error_text?: string | null;
  };
  source?: string;
}

type AIRunRow = {
  created_at: string;
  error_text: string | null;
  estimated_cost: number | string | null;
  id: string;
  input_tokens: number | null;
  latency_ms: number | null;
  model_name: string;
  output_tokens: number | null;
  prompt_version: string;
  provider: string;
  run_type: AIRunType;
  status: AIRunStatus;
  workspace_id: string | null;
};

type CountResponse = {
  count: number | null;
};

export interface RecentAIRunSummary {
  created_at: string;
  error_code: AIRunErrorCode | null;
  error_text: string | null;
  estimated_cost: number | null;
  id: string;
  input_tokens: number | null;
  latency_ms: number | null;
  model_name: string;
  output_tokens: number | null;
  prompt_version: string;
  provider: string;
  run_type: AIRunType;
  status: AIRunStatus;
  workspace_id: string | null;
  workspace_name: string | null;
}

export interface LatencyMetric {
  average_latency_ms: number | null;
  failure_rate: number | null;
  p95_latency_ms: number | null;
  run_count: number;
  run_type: AIRunType;
  success_count: number;
}

export interface ErrorDashboardRow {
  count: number;
  error_code: AIRunErrorCode;
  latest_at: string;
  run_types: AIRunType[];
}

export interface ProviderCostMetric {
  average_cost_usd: number | null;
  model_name: string;
  provider: string;
  run_count: number;
  total_cost_usd: number;
}

export interface DailyCostMetric {
  date: string;
  run_type_costs: Partial<Record<AIRunType, number>>;
  total_cost_usd: number;
}

export interface ObservabilityRateMetric {
  denominator: number;
  label: string;
  numerator: number;
  rate: number | null;
}

export interface PlanRateMetric {
  acceptance: ObservabilityRateMetric;
  edits_after_acceptance: ObservabilityRateMetric;
}

export interface AICostSummary {
  average_brain_dump_session_cost_usd: number | null;
  daily_by_run_type: DailyCostMetric[];
  monthly_total_usd: number;
  provider_totals: ProviderCostMetric[];
}

export interface AIObservabilitySnapshot {
  cost_summary: AICostSummary;
  counter_metrics: {
    assistant_save_to_graph_usage: ObservabilityRateMetric;
    edge_proposal_acceptance_rate: ObservabilityRateMetric;
    lifecycle_cascade_trigger_frequency: ObservabilityRateMetric;
    merge_suggestion_precision: ObservabilityRateMetric;
    node_completion_rate: ObservabilityRateMetric;
    node_proposal_acceptance_rate: ObservabilityRateMetric;
    plan_rate: PlanRateMetric;
    rate_limit_hit_frequency: ObservabilityRateMetric;
  };
  error_dashboard: ErrorDashboardRow[];
  latency_by_run_type: LatencyMetric[];
  recent_runs: RecentAIRunSummary[];
  window: {
    cost_month_start: string;
    recent_start: string;
  };
}

function normalizeNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }

  return roundTo((numerator / denominator) * 100, 1);
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function truncateErrorText(errorText: string | null | undefined) {
  if (!errorText) {
    return null;
  }

  return errorText.length > 220 ? `${errorText.slice(0, 217)}...` : errorText;
}

function toDateKey(isoTimestamp: string) {
  return isoTimestamp.slice(0, 10);
}

function buildRateMetric(label: string, numerator: number, denominator: number): ObservabilityRateMetric {
  return {
    label,
    numerator,
    denominator,
    rate: formatRate(numerator, denominator),
  };
}

function structuredLogLevel(status: AIRunStatus) {
  if (status === "failed") {
    return "error";
  }

  if (status === "retrying") {
    return "warn";
  }

  return "info";
}

export function classifyAIRunError(errorText: string | null | undefined): AIRunErrorCode | null {
  if (!errorText) {
    return null;
  }

  const normalized = errorText.toLowerCase();

  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota")
  ) {
    return "rate_limit";
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("deadline exceeded")
  ) {
    return "timeout";
  }

  if (
    normalized.includes("network") ||
    normalized.includes("fetch failed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound")
  ) {
    return "network";
  }

  if (
    normalized.includes("unexpected token") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("must be an object") ||
    normalized.includes("missing prompt_version") ||
    normalized.includes("missing blocks array") ||
    normalized.includes("missing related") ||
    normalized.includes("duplicate local_ref") ||
    normalized.includes("invalid block_type")
  ) {
    return "malformed_output";
  }

  if (
    normalized.includes("not configured") ||
    normalized.includes("is not set") ||
    normalized.includes("add it to .env")
  ) {
    return "misconfigured";
  }

  if (
    normalized.includes("service unavailable") ||
    normalized.includes("overloaded") ||
    normalized.includes("internal server error") ||
    normalized.includes("bad gateway")
  ) {
    return "upstream";
  }

  return "unknown";
}

export function emitAIRunStructuredLog(params: {
  aiRunId?: string | null;
  source?: string;
  userId?: string | null;
  workspaceId?: string | null;
  run: PersistAIRunParams["run"];
}) {
  const { aiRunId = null, source = "app", userId = null, workspaceId = null, run } = params;
  const status = run.status ?? "success";
  const event = {
    event: "ai_run",
    source,
    ai_run_id: aiRunId,
    user_id: userId,
    workspace_id: workspaceId,
    run_type: run.run_type,
    provider: run.provider,
    model_name: run.model_name,
    prompt_version: run.prompt_version,
    status,
    input_tokens: run.input_tokens ?? null,
    output_tokens: run.output_tokens ?? null,
    latency_ms: run.latency_ms ?? null,
    estimated_cost_usd: run.estimated_cost ?? null,
    error_code: classifyAIRunError(run.error_text),
    error_text: truncateErrorText(run.error_text),
    created_at: new Date().toISOString(),
  };

  const level = structuredLogLevel(status);
  const payload = `[ai/run] ${JSON.stringify(event)}`;

  if (level === "error") {
    console.error(payload);
    return;
  }

  if (level === "warn") {
    console.warn(payload);
    return;
  }

  console.info(payload);
}

export async function persistAIRun(params: PersistAIRunParams): Promise<string | null> {
  const { supabase, userId, workspaceId, run, source = "app" } = params;

  const insertPayload = {
    user_id: userId,
    workspace_id: workspaceId,
    run_type: run.run_type,
    provider: run.provider,
    model_name: run.model_name,
    prompt_version: run.prompt_version,
    input_hash: run.input_hash ?? null,
    output_hash: run.output_hash ?? null,
    input_tokens: run.input_tokens ?? null,
    output_tokens: run.output_tokens ?? null,
    latency_ms: run.latency_ms ?? null,
    estimated_cost: run.estimated_cost ?? null,
    status: run.status ?? "success",
    error_text: run.error_text ? run.error_text.slice(0, 1000) : null,
    // Only when reported: runs without them (Cohere, embeddings) insert as before.
    ...(run.cache_read_tokens != null ? { cache_read_tokens: run.cache_read_tokens } : {}),
    ...(run.cache_write_tokens != null ? { cache_write_tokens: run.cache_write_tokens } : {}),
  };

  try {
    const { data, error } = await supabase
      .from("ai_runs")
      .insert(insertPayload)
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    const aiRunId = (data?.id as string | undefined) ?? null;
    emitAIRunStructuredLog({
      aiRunId,
      source,
      userId,
      workspaceId,
      run: {
        ...run,
        status: insertPayload.status,
        error_text: insertPayload.error_text,
      },
    });

    return aiRunId;
  } catch (error) {
    console.error(
      `[ai/run] ${JSON.stringify({
        event: "ai_run_persist_failed",
        source,
        user_id: userId,
        workspace_id: workspaceId,
        run_type: run.run_type,
        provider: run.provider,
        model_name: run.model_name,
        prompt_version: run.prompt_version,
        status: run.status ?? "success",
        insert_error: error instanceof Error ? error.message : String(error),
      })}`,
    );
    return null;
  }
}

// Who a Claude call is billed to. Library helpers take it optionally so they
// stay usable from tests/scripts; routes always pass it.
export interface AIUsageScope {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string | null;
}

// Log one Claude call with its real cost (see usage.ts). Best-effort: never
// throws, and a missing scope is a no-op.
export async function recordClaudeRun(params: {
  scope: AIUsageScope | null | undefined;
  source: string;
  model: string;
  promptVersion: string;
  usage: UsageTotals;
  latencyMs: number;
  runType?: AIRunType;
  status?: AIRunStatus;
  errorText?: string | null;
  inputHash?: string | null;
  outputHash?: string | null;
}): Promise<string | null> {
  const { scope } = params;
  if (!scope) return null;
  return persistAIRun({
    supabase: scope.supabase,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    source: params.source,
    run: {
      run_type: params.runType ?? "auxiliary",
      provider: "claude",
      model_name: params.model,
      prompt_version: params.promptVersion,
      input_hash: params.inputHash ?? null,
      output_hash: params.outputHash ?? null,
      input_tokens: totalInputTokens(params.usage),
      output_tokens: params.usage.output,
      ...cacheTokenFields(params.usage),
      latency_ms: params.latencyMs,
      estimated_cost: claudeCostUSD(params.model, params.usage),
      status: params.status ?? "success",
      error_text: params.errorText ?? null,
    },
  });
}

export function buildLatencyMetrics(runs: AIRunRow[]): LatencyMetric[] {
  const grouped = new Map<AIRunType, AIRunRow[]>();

  for (const run of runs) {
    const bucket = grouped.get(run.run_type) ?? [];
    bucket.push(run);
    grouped.set(run.run_type, bucket);
  }

  return [...grouped.entries()]
    .map(([runType, group]) => {
      const latencies = group
        .map((run) => normalizeNumber(run.latency_ms))
        .filter((value): value is number => value != null);
      const successCount = group.filter((run) => run.status === "success").length;

      return {
        run_type: runType,
        run_count: group.length,
        success_count: successCount,
        average_latency_ms:
          latencies.length > 0
            ? roundTo(latencies.reduce((sum, value) => sum + value, 0) / latencies.length, 1)
            : null,
        p95_latency_ms: percentile(latencies, 95),
        failure_rate: formatRate(group.length - successCount, group.length),
      };
    })
    .sort((a, b) => a.run_type.localeCompare(b.run_type));
}

export function buildErrorDashboard(runs: AIRunRow[]): ErrorDashboardRow[] {
  const grouped = new Map<AIRunErrorCode, { count: number; latestAt: string; runTypes: Set<AIRunType> }>();

  for (const run of runs) {
    if (run.status === "success") {
      continue;
    }

    const errorCode = classifyAIRunError(run.error_text) ?? "unknown";
    const existing = grouped.get(errorCode) ?? {
      count: 0,
      latestAt: run.created_at,
      runTypes: new Set<AIRunType>(),
    };
    existing.count += 1;
    if (run.created_at > existing.latestAt) {
      existing.latestAt = run.created_at;
    }
    existing.runTypes.add(run.run_type);
    grouped.set(errorCode, existing);
  }

  return [...grouped.entries()]
    .map(([errorCode, group]) => ({
      error_code: errorCode,
      count: group.count,
      latest_at: group.latestAt,
      run_types: [...group.runTypes].sort(),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.latest_at.localeCompare(a.latest_at);
    });
}

export function buildCostSummary(runs: AIRunRow[], monthStartIso: string): AICostSummary {
  const monthlyRuns = runs.filter((run) => run.created_at >= monthStartIso);
  const extractCosts = monthlyRuns
    .filter((run) => run.run_type === "extract")
    .map((run) => normalizeNumber(run.estimated_cost))
    .filter((value): value is number => value != null);

  const dailyTotals = new Map<string, DailyCostMetric>();
  const providerTotals = new Map<string, ProviderCostMetric>();

  for (const run of monthlyRuns) {
    const cost = normalizeNumber(run.estimated_cost);
    if (cost == null) {
      continue;
    }

    const dateKey = toDateKey(run.created_at);
    const existingDaily = dailyTotals.get(dateKey) ?? {
      date: dateKey,
      run_type_costs: {},
      total_cost_usd: 0,
    };
    existingDaily.total_cost_usd = roundTo(existingDaily.total_cost_usd + cost, 6);
    existingDaily.run_type_costs[run.run_type] = roundTo(
      (existingDaily.run_type_costs[run.run_type] ?? 0) + cost,
      6,
    );
    dailyTotals.set(dateKey, existingDaily);

    const providerKey = `${run.provider}:${run.model_name}`;
    const existingProvider = providerTotals.get(providerKey) ?? {
      provider: run.provider,
      model_name: run.model_name,
      run_count: 0,
      total_cost_usd: 0,
      average_cost_usd: null,
    };
    existingProvider.run_count += 1;
    existingProvider.total_cost_usd = roundTo(existingProvider.total_cost_usd + cost, 6);
    existingProvider.average_cost_usd = roundTo(
      existingProvider.total_cost_usd / existingProvider.run_count,
      6,
    );
    providerTotals.set(providerKey, existingProvider);
  }

  const monthlyTotalUsd = roundTo(
    monthlyRuns.reduce((sum, run) => sum + (normalizeNumber(run.estimated_cost) ?? 0), 0),
    6,
  );

  return {
    monthly_total_usd: monthlyTotalUsd,
    average_brain_dump_session_cost_usd:
      extractCosts.length > 0
        ? roundTo(extractCosts.reduce((sum, value) => sum + value, 0) / extractCosts.length, 6)
        : null,
    daily_by_run_type: [...dailyTotals.values()].sort((a, b) => b.date.localeCompare(a.date)),
    provider_totals: [...providerTotals.values()].sort(
      (a, b) => b.total_cost_usd - a.total_cost_usd,
    ),
  };
}

function countOrZero(response: CountResponse) {
  return response.count ?? 0;
}

export async function getAIObservabilitySnapshot(params: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<AIObservabilitySnapshot> {
  const { supabase, userId } = params;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const recentStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentStartIso = recentStart.toISOString();
  const monthStartIso = monthStart.toISOString();

  const [
    recentRunsResult,
    recentWindowRunsResult,
    workspacesResult,
    acceptedNodeResult,
    reviewedNodeResult,
    acceptedEdgeResult,
    reviewedEdgeResult,
    mergedSuggestionResult,
    resolvedSuggestionResult,
    acceptedPlanResult,
    finalizedPlanResult,
    editedAcceptedPlanResult,
    assistantSaveResult,
    totalRawEntryResult,
    completedNodeResult,
    totalNodeResult,
    cascadeTriggeredResult,
    totalLifecycleEventResult,
  ] = await Promise.all([
    supabase
      .from("ai_runs")
      .select(
        "id, workspace_id, run_type, provider, model_name, prompt_version, input_tokens, output_tokens, latency_ms, estimated_cost, status, error_text, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("ai_runs")
      .select(
        "id, workspace_id, run_type, provider, model_name, prompt_version, input_tokens, output_tokens, latency_ms, estimated_cost, status, error_text, created_at",
      )
      .eq("user_id", userId)
      .gte("created_at", recentStartIso)
      .order("created_at", { ascending: false })
      .limit(2_000),
    supabase
      .from("workspaces")
      .select("id, name")
      .eq("user_id", userId),
    supabase
      .from("proposed_nodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("proposal_status", "accepted"),
    supabase
      .from("proposed_nodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("proposal_status", ["accepted", "rejected"]),
    supabase
      .from("proposed_edges")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("proposal_status", "accepted"),
    supabase
      .from("proposed_edges")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("proposal_status", ["accepted", "rejected"]),
    supabase
      .from("merge_suggestions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "merged"),
    supabase
      .from("merge_suggestions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", ["merged", "dismissed", "never"]),
    supabase
      .from("plan_feedback")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("accepted", true),
    supabase
      .from("plan_feedback")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .or("accepted.eq.true,rejected.eq.true"),
    supabase
      .from("plan_feedback")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("accepted", true)
      .eq("edited", true),
    supabase
      .from("raw_entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("source_type", "assistant_save"),
    supabase
      .from("raw_entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabase
      .from("nodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "completed"),
    supabase
      .from("nodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabase
      .from("lifecycle_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("cascade_triggered", true),
    supabase
      .from("lifecycle_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);

  const recentWindowRuns = ((recentWindowRunsResult.data ?? []) as AIRunRow[]).filter(
    (run) => run.created_at >= recentStartIso,
  );
  const workspaceNames = new Map(
    ((workspacesResult.data ?? []) as Array<{ id: string; name: string }>).map((workspace) => [
      workspace.id,
      workspace.name,
    ]),
  );

  const recentRuns = ((recentRunsResult.data ?? []) as AIRunRow[]).map((run) => ({
    ...run,
    estimated_cost: normalizeNumber(run.estimated_cost),
    error_code: classifyAIRunError(run.error_text),
    error_text: truncateErrorText(run.error_text),
    workspace_name: run.workspace_id ? workspaceNames.get(run.workspace_id) ?? null : null,
  }));

  const rateLimitHits = recentWindowRuns.filter(
    (run) => classifyAIRunError(run.error_text) === "rate_limit",
  ).length;

  return {
    window: {
      recent_start: recentStartIso,
      cost_month_start: monthStartIso,
    },
    recent_runs: recentRuns,
    latency_by_run_type: buildLatencyMetrics(recentWindowRuns),
    error_dashboard: buildErrorDashboard(recentWindowRuns),
    cost_summary: buildCostSummary(recentWindowRuns, monthStartIso),
    counter_metrics: {
      node_proposal_acceptance_rate: buildRateMetric(
        "Node proposal acceptance rate",
        countOrZero(acceptedNodeResult),
        countOrZero(reviewedNodeResult),
      ),
      edge_proposal_acceptance_rate: buildRateMetric(
        "Edge proposal acceptance rate",
        countOrZero(acceptedEdgeResult),
        countOrZero(reviewedEdgeResult),
      ),
      merge_suggestion_precision: buildRateMetric(
        "Merge suggestion precision",
        countOrZero(mergedSuggestionResult),
        countOrZero(resolvedSuggestionResult),
      ),
      plan_rate: {
        acceptance: buildRateMetric(
          "Plan acceptance rate",
          countOrZero(acceptedPlanResult),
          countOrZero(finalizedPlanResult),
        ),
        edits_after_acceptance: buildRateMetric(
          "Plan edit rate after acceptance",
          countOrZero(editedAcceptedPlanResult),
          countOrZero(acceptedPlanResult),
        ),
      },
      assistant_save_to_graph_usage: buildRateMetric(
        "Assistant save-to-graph usage",
        countOrZero(assistantSaveResult),
        countOrZero(totalRawEntryResult),
      ),
      node_completion_rate: buildRateMetric(
        "Node completion rate",
        countOrZero(completedNodeResult),
        countOrZero(totalNodeResult),
      ),
      lifecycle_cascade_trigger_frequency: buildRateMetric(
        "Lifecycle cascade trigger frequency",
        countOrZero(cascadeTriggeredResult),
        countOrZero(totalLifecycleEventResult),
      ),
      rate_limit_hit_frequency: buildRateMetric(
        "Rate limit hit frequency",
        rateLimitHits,
        recentWindowRuns.length,
      ),
    },
  };
}
