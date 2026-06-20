import { describe, expect, it } from "vitest";

import { validateMergeCheckOutput, validatePlanOutput } from "./validation";

function planRaw(blocks: unknown[]) {
  return { blocks, prompt_version: "plan-v3" };
}
const block = (over: Record<string, unknown> = {}) => ({
  node_id: null,
  title: "Work",
  start_offset: 0,
  duration_minutes: 30,
  reason: "because",
  block_type: "focus",
  ...over,
});

describe("validatePlanOutput", () => {
  it("accepts a well-formed block and defaults node_id/reason", () => {
    const out = validatePlanOutput(
      planRaw([{ title: "T", start_offset: 0, duration_minutes: 30, block_type: "focus" }]),
    );
    expect(out.blocks[0].node_id).toBeNull();
    expect(out.blocks[0].reason).toBeNull();
    expect(out.blocks[0].duration_minutes).toBe(30);
  });

  it("rejects a non-object, missing blocks, or missing prompt_version", () => {
    expect(() => validatePlanOutput(null)).toThrow();
    expect(() => validatePlanOutput({ prompt_version: "x" })).toThrow();
    expect(() => validatePlanOutput({ blocks: [] })).toThrow();
  });

  it("rejects non-positive / non-number duration and bad block_type", () => {
    expect(() => validatePlanOutput(planRaw([block({ duration_minutes: 0 })]))).toThrow();
    expect(() => validatePlanOutput(planRaw([block({ duration_minutes: "30" })]))).toThrow();
    expect(() => validatePlanOutput(planRaw([block({ block_type: "nap" })]))).toThrow();
  });

  it("clamps negative start_offset to 0", () => {
    const out = validatePlanOutput(planRaw([block({ start_offset: -15 })]));
    expect(out.blocks[0].start_offset).toBe(0);
  });

  it("rounds fractional durations (integer column)", () => {
    expect(
      validatePlanOutput(planRaw([block({ duration_minutes: 12.4 })])).blocks[0].duration_minutes,
    ).toBe(12);
    // sub-minute rounds up to a 1-min floor, never 0
    expect(
      validatePlanOutput(planRaw([block({ duration_minutes: 0.4 })])).blocks[0].duration_minutes,
    ).toBe(1);
  });

  // The plan-v3 regression guard: a block can't extend past the window.
  it("caps a block that would overflow the window", () => {
    const out = validatePlanOutput(planRaw([block({ start_offset: 0, duration_minutes: 120 })]), 60);
    expect(out.blocks[0].duration_minutes).toBe(60);
  });

  it("caps relative to start_offset so the block ends by the window", () => {
    const out = validatePlanOutput(planRaw([block({ start_offset: 40, duration_minutes: 60 })]), 60);
    expect(out.blocks[0].duration_minutes).toBe(20);
  });

  it("does not clamp when no window is given (back-compat)", () => {
    expect(
      validatePlanOutput(planRaw([block({ duration_minutes: 120 })])).blocks[0].duration_minutes,
    ).toBe(120);
  });
});

describe("validateMergeCheckOutput", () => {
  it("accepts valid merge-check output", () => {
    const output = validateMergeCheckOutput({
      same_entity: true,
      confidence: 0.91,
      reason: "These titles refer to the same project.",
      prompt_version: "merge-check-v1",
    });

    expect(output.same_entity).toBe(true);
    expect(output.confidence).toBe(0.91);
    expect(output.prompt_version).toBe("merge-check-v1");
  });

  it("rejects malformed merge-check output", () => {
    expect(() =>
      validateMergeCheckOutput({
        same_entity: "yes",
        confidence: 0.5,
        reason: "bad",
      }),
    ).toThrow("Merge-check output missing same_entity");
  });
});
