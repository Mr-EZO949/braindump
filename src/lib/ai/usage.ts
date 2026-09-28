// What an Anthropic call actually cost, priced from the usage block it returns.
//
// Input arrives in separately-billed buckets: fresh input (1×), cache reads
// (0.1×), cache writes at 1.25× (5-minute TTL) or 2× (1-hour TTL). Batch API
// calls are half price across the board. Every Claude caller prices through
// here so ai_runs.estimated_cost tracks the real invoice — it is what per-user
// budgets and the owner cost dashboard read.

import { AI_COST_PER_1M_TOKENS } from "./config";

// Shape of `usage` on a Messages API response / message_start event.
export interface ClaudeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

export interface UsageTotals {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export const EMPTY_USAGE: UsageTotals = {
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
};

export function readClaudeUsage(u: ClaudeUsage | null | undefined): UsageTotals {
  if (!u) return { ...EMPTY_USAGE };
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Without the per-TTL breakdown every write is a 5-minute write.
  const write5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : cacheWrite;
  return {
    input: u.input_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

// Every input token the model saw, whatever it was billed at.
export function totalInputTokens(t: UsageTotals): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}

function claudeRates(model: string): { input: number; output: number } {
  if (model.includes("haiku")) {
    return {
      input: AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_INPUT,
      output: AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_OUTPUT,
    };
  }
  return {
    input: AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_INPUT,
    output: AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_OUTPUT,
  };
}

export function claudeCostUSD(
  model: string,
  t: UsageTotals,
  opts: { batch?: boolean } = {},
): number {
  const r = claudeRates(model);
  const cost =
    (t.input * r.input +
      t.cacheWrite5m * r.input * 1.25 +
      t.cacheWrite1h * r.input * 2 +
      t.cacheRead * r.input * 0.1 +
      t.output * r.output) /
    1_000_000;
  return opts.batch ? cost / 2 : cost;
}
