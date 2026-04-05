import { describe, expect, it } from "vitest";

import {
  buildCostSummary,
  buildErrorDashboard,
  buildLatencyMetrics,
  classifyAIRunError,
} from "./telemetry";

const baseRun = {
  workspace_id: "ws-1",
  input_tokens: 100,
  output_tokens: 50,
  prompt_version: "prompt-v1",
};

describe("classifyAIRunError", () => {
  it("detects rate limit failures", () => {
    expect(classifyAIRunError("429 rate limit exceeded")).toBe("rate_limit");
  });

  it("detects malformed output failures", () => {
    expect(classifyAIRunError("Plan output missing blocks array")).toBe("malformed_output");
  });
});

describe("buildLatencyMetrics", () => {
  it("groups runs by type and computes average, p95, and failure rate", () => {
    const metrics = buildLatencyMetrics([
      {
        ...baseRun,
        id: "run-1",
        created_at: "2026-04-03T10:00:00.000Z",
        error_text: null,
        estimated_cost: 0.001,
        latency_ms: 100,
        model_name: "claude-sonnet-4-6",
        provider: "claude",
        run_type: "extract",
        status: "success",
      },
      {
        ...baseRun,
        id: "run-2",
        created_at: "2026-04-03T10:01:00.000Z",
        error_text: "429 rate limit exceeded",
        estimated_cost: 0.001,
        latency_ms: 300,
        model_name: "claude-sonnet-4-6",
        provider: "claude",
        run_type: "extract",
        status: "failed",
      },
      {
        ...baseRun,
        id: "run-3",
        created_at: "2026-04-03T10:02:00.000Z",
        error_text: null,
        estimated_cost: 0.002,
        latency_ms: 220,
        model_name: "gemini-embedding-001",
        provider: "gemini",
        run_type: "embed",
        status: "success",
      },
    ]);

    expect(metrics).toEqual([
      {
        average_latency_ms: 220,
        failure_rate: 0,
        p95_latency_ms: 220,
        run_count: 1,
        run_type: "embed",
        success_count: 1,
      },
      {
        average_latency_ms: 200,
        failure_rate: 50,
        p95_latency_ms: 300,
        run_count: 2,
        run_type: "extract",
        success_count: 1,
      },
    ]);
  });
});

describe("buildErrorDashboard", () => {
  it("groups non-success runs by normalized error code", () => {
    const dashboard = buildErrorDashboard([
      {
        ...baseRun,
        id: "run-1",
        created_at: "2026-04-03T10:00:00.000Z",
        error_text: "429 rate limit exceeded",
        estimated_cost: 0.001,
        latency_ms: 100,
        model_name: "claude-sonnet-4-6",
        provider: "claude",
        run_type: "extract",
        status: "failed",
      },
      {
        ...baseRun,
        id: "run-2",
        created_at: "2026-04-03T12:00:00.000Z",
        error_text: "429 too many requests",
        estimated_cost: 0.001,
        latency_ms: 110,
        model_name: "gemini-embedding-001",
        provider: "gemini",
        run_type: "embed",
        status: "retrying",
      },
      {
        ...baseRun,
        id: "run-3",
        created_at: "2026-04-03T12:30:00.000Z",
        error_text: "service unavailable",
        estimated_cost: 0.001,
        latency_ms: 160,
        model_name: "claude-sonnet-4-6",
        provider: "claude",
        run_type: "assistant",
        status: "failed",
      },
    ]);

    expect(dashboard).toEqual([
      {
        count: 2,
        error_code: "rate_limit",
        latest_at: "2026-04-03T12:00:00.000Z",
        run_types: ["embed", "extract"],
      },
      {
        count: 1,
        error_code: "upstream",
        latest_at: "2026-04-03T12:30:00.000Z",
        run_types: ["assistant"],
      },
    ]);
  });
});

describe("buildCostSummary", () => {
  it("builds monthly totals, daily breakdowns, provider totals, and extract averages", () => {
    const summary = buildCostSummary(
      [
        {
          ...baseRun,
          id: "run-1",
          created_at: "2026-04-01T10:00:00.000Z",
          error_text: null,
          estimated_cost: 0.0015,
          latency_ms: 100,
          model_name: "claude-sonnet-4-6",
          provider: "claude",
          run_type: "extract",
          status: "success",
        },
        {
          ...baseRun,
          id: "run-2",
          created_at: "2026-04-01T11:00:00.000Z",
          error_text: null,
          estimated_cost: 0.0025,
          latency_ms: 150,
          model_name: "claude-sonnet-4-6",
          provider: "claude",
          run_type: "assistant",
          status: "success",
        },
        {
          ...baseRun,
          id: "run-3",
          created_at: "2026-04-02T09:00:00.000Z",
          error_text: null,
          estimated_cost: 0.0004,
          latency_ms: 70,
          model_name: "gemini-embedding-001",
          provider: "gemini",
          run_type: "embed",
          status: "success",
        },
        {
          ...baseRun,
          id: "run-4",
          created_at: "2026-03-30T09:00:00.000Z",
          error_text: null,
          estimated_cost: 0.9,
          latency_ms: 70,
          model_name: "claude-sonnet-4-6",
          provider: "claude",
          run_type: "extract",
          status: "success",
        },
      ],
      "2026-04-01T00:00:00.000Z",
    );

    expect(summary.monthly_total_usd).toBe(0.0044);
    expect(summary.average_brain_dump_session_cost_usd).toBe(0.0015);
    expect(summary.daily_by_run_type).toEqual([
      {
        date: "2026-04-02",
        run_type_costs: { embed: 0.0004 },
        total_cost_usd: 0.0004,
      },
      {
        date: "2026-04-01",
        run_type_costs: { assistant: 0.0025, extract: 0.0015 },
        total_cost_usd: 0.004,
      },
    ]);
    expect(summary.provider_totals).toEqual([
      {
        average_cost_usd: 0.002,
        model_name: "claude-sonnet-4-6",
        provider: "claude",
        run_count: 2,
        total_cost_usd: 0.004,
      },
      {
        average_cost_usd: 0.0004,
        model_name: "gemini-embedding-001",
        provider: "gemini",
        run_count: 1,
        total_cost_usd: 0.0004,
      },
    ]);
  });
});
