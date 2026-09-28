import { describe, expect, it } from "vitest";

import { AI_MODELS } from "./config";
import { addUsage, claudeCostUSD, readClaudeUsage, totalInputTokens } from "./usage";

describe("readClaudeUsage", () => {
  it("splits cache writes by TTL when the breakdown is present", () => {
    const t = readClaudeUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 8000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    });
    expect(t).toEqual({ input: 100, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 8000, output: 50 });
    expect(totalInputTokens(t)).toBe(11_100);
  });

  it("treats writes without a breakdown as 5-minute writes", () => {
    const t = readClaudeUsage({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 500 });
    expect(t.cacheWrite5m).toBe(500);
    expect(t.cacheWrite1h).toBe(0);
  });

  it("handles a missing usage block", () => {
    expect(totalInputTokens(readClaudeUsage(null))).toBe(0);
  });
});

describe("claudeCostUSD", () => {
  const oneMillion = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

  it("prices each bucket at its real multiplier", () => {
    // Haiku 4.5: $1/M in, $5/M out
    const h = AI_MODELS.CLAUDE_HAIKU;
    expect(claudeCostUSD(h, oneMillion)).toBeCloseTo(1);
    expect(claudeCostUSD(h, { ...oneMillion, input: 0, cacheWrite5m: 1_000_000 })).toBeCloseTo(1.25);
    expect(claudeCostUSD(h, { ...oneMillion, input: 0, cacheWrite1h: 1_000_000 })).toBeCloseTo(2);
    expect(claudeCostUSD(h, { ...oneMillion, input: 0, cacheRead: 1_000_000 })).toBeCloseTo(0.1);
    expect(claudeCostUSD(h, { ...oneMillion, input: 0, output: 1_000_000 })).toBeCloseTo(5);
  });

  it("uses Sonnet rates for Sonnet and halves Batch calls", () => {
    const s = AI_MODELS.CLAUDE_SONNET;
    expect(claudeCostUSD(s, oneMillion)).toBeCloseTo(2);
    expect(claudeCostUSD(s, oneMillion, { batch: true })).toBeCloseTo(1);
  });

  it("accumulates across tool rounds", () => {
    const round = readClaudeUsage({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 9000 });
    const both = addUsage(round, round);
    expect(totalInputTokens(both)).toBe(20_000);
    expect(both.output).toBe(200);
  });
});
