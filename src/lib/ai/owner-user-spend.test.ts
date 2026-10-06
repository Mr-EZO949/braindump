import { describe, expect, it } from "vitest";

import { operationLabel, promptFamily, summarizeUserSpend, type SpendRunRow } from "./owner-user-spend";

const HAIKU = "claude-haiku-4-5-20251001";
const run = (over: Partial<SpendRunRow>): SpendRunRow => ({
  run_type: "assistant",
  provider: "claude",
  model_name: HAIKU,
  prompt_version: "assistant-v34:explain",
  estimated_cost: 0.005,
  input_tokens: 10_000,
  output_tokens: 200,
  latency_ms: 2000,
  status: "success",
  error_text: null,
  created_at: "2026-10-06T10:00:00Z",
  ...over,
});

describe("operation labels", () => {
  it("drops versions and modes, names Accept presses apart", () => {
    expect(promptFamily("judgment_v3")).toBe("judgment");
    expect(promptFamily("extract-light-v9")).toBe("extract-light");
    expect(operationLabel({ prompt_version: "assistant-v32:explain:resume-accept" })).toBe("Chat — after Accept / choice");
    expect(operationLabel({ prompt_version: "steps-v1:roadmap" })).toBe("Steps / roadmap");
    expect(operationLabel({ prompt_version: "something-new-v2" })).toBe("something-new");
  });
});

describe("summarizeUserSpend", () => {
  const rows = [
    // a chat turn, 8k of its 10k input tokens from the cache
    run({ estimated_cost: 0.004, cache_read_tokens: 8000, cache_write_tokens: 0 }),
    run({ estimated_cost: 0.006, created_at: "2026-10-06T21:30:00Z", cache_read_tokens: 0, cache_write_tokens: 10_000 }), // 23:30 in Rome
    run({ estimated_cost: 0.07, model_name: "claude-sonnet-5", prompt_version: "extract-v28", run_type: "extract", output_tokens: 4000, created_at: "2026-10-06T22:30:00Z" }), // next day in Rome
    run({ estimated_cost: 0, provider: "gemini", model_name: "gemini-3.1-flash-lite", prompt_version: "assistant-qa-v3:explain:error", status: "failed", input_tokens: null, output_tokens: null }),
  ];
  const s = summarizeUserSpend(rows);

  it("totals, splits input vs output and counts Rome days", () => {
    expect(s.runs).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.cost).toBeCloseTo(0.08);
    // output: 2 × 200 Haiku tokens at $5/M + 4000 Sonnet tokens at $10/M
    expect(s.output_cost).toBeCloseTo(0.002 + 0.04);
    expect(s.input_cost).toBeCloseTo(0.08 - 0.042);
    expect(s.by_day.map((d) => d.day)).toEqual(["2026-10-07", "2026-10-06"]);
    expect(s.projected_30d).toBeCloseTo((0.08 / 2) * 30);
  });

  it("groups by operation × model, most expensive first, with the cache share", () => {
    expect(s.by_operation[0]).toMatchObject({ label: "Long dump — graph builder", model: "claude-sonnet-5", runs: 1 });
    const chat = s.by_operation.find((g) => g.label === "Chat")!;
    expect(chat).toMatchObject({ runs: 2, avg_input_tokens: 10_000, avg_output_tokens: 200 });
    expect(chat.cache_read_share).toBeCloseTo(0.4);
    expect(s.cache_write_tokens).toBe(10_000);
    expect(s.most_expensive[0].label).toBe("Long dump — graph builder");
    expect(s.recent[0].created_at).toBe("2026-10-06T22:30:00Z");
  });
});
