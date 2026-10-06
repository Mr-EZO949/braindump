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

// The cache columns of an ai_runs row (migration 20261006000000).
export function cacheTokenFields(t: UsageTotals): { cache_read_tokens: number; cache_write_tokens: number } {
  return { cache_read_tokens: t.cacheRead, cache_write_tokens: t.cacheWrite5m + t.cacheWrite1h };
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

// Gemini reports prompt tokens (cached ones included) and output tokens
// (thinking included). Implicitly-cached prompt tokens bill at 0.1×.
export interface GeminiUsage {
  prompt: number;
  cached: number;
  output: number;
}

function geminiRates(model: string): { input: number; output: number } {
  if (model.includes("2.5-flash-lite")) {
    return {
      input: AI_COST_PER_1M_TOKENS.GEMINI_FLASH_LITE_25_INPUT,
      output: AI_COST_PER_1M_TOKENS.GEMINI_FLASH_LITE_25_OUTPUT,
    };
  }
  if (model.includes("flash-lite")) {
    return {
      input: AI_COST_PER_1M_TOKENS.GEMINI_FLASH_LITE_31_INPUT,
      output: AI_COST_PER_1M_TOKENS.GEMINI_FLASH_LITE_31_OUTPUT,
    };
  }
  return {
    input: AI_COST_PER_1M_TOKENS.GEMINI_FLASH_INPUT,
    output: AI_COST_PER_1M_TOKENS.GEMINI_FLASH_OUTPUT,
  };
}

export function geminiCostUSD(model: string, u: GeminiUsage): number {
  const r = geminiRates(model);
  const cached = Math.min(u.cached, u.prompt);
  return ((u.prompt - cached) * r.input + cached * r.input * 0.1 + u.output * r.output) / 1_000_000;
}

// What a run's output tokens cost — the rest of estimated_cost is input
// (cached or not). For the spend drill-down; 0 for providers without output.
export function outputCostUSD(provider: string, model: string, outputTokens: number | null): number {
  if (!outputTokens) return 0;
  if (provider === "claude") return (outputTokens * claudeRates(model).output) / 1_000_000;
  if (provider === "gemini" && !model.includes("embedding")) return (outputTokens * geminiRates(model).output) / 1_000_000;
  return 0;
}
