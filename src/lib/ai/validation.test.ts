import { describe, expect, it } from "vitest";

import { validateExtractionOutput, validateMergeCheckOutput, validatePlanOutput } from "./validation";

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

  it("re-sequences overlapping blocks so they never collide (the 1h-plan bug)", () => {
    // A break and a buffer both at offset 50 in a 60-min window — the exact
    // collision the planner produced. Should pack contiguously, dropping what
    // doesn't fit.
    const out = validatePlanOutput(
      planRaw([
        block({ title: "Work", start_offset: 0, duration_minutes: 50, block_type: "focus" }),
        block({ title: "Break", start_offset: 50, duration_minutes: 10, block_type: "break" }),
        block({ title: "Buffer", start_offset: 50, duration_minutes: 10, block_type: "buffer" }),
      ]),
      60,
    );
    // Work 0–50, Break 50–60, Buffer dropped (no room left).
    expect(out.blocks.map((b) => [b.start_offset, b.duration_minutes])).toEqual([
      [0, 50],
      [50, 10],
    ]);
    // No block starts before the previous one ends — zero overlap.
    for (let i = 1; i < out.blocks.length; i++) {
      expect(out.blocks[i].start_offset).toBe(
        out.blocks[i - 1].start_offset + out.blocks[i - 1].duration_minutes,
      );
    }
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

const session = { workspace_id: "ws-1", user_id: "user-1", prompt_version: "extract-v21" };

describe("validateExtractionOutput (compact v20+ output)", () => {
  it("fills ids and prompt version from the session, not the model", () => {
    const out = validateExtractionOutput(
      { proposed_nodes: [{ local_ref: "n1", proposed_title: "Email the professor", proposed_node_type: "task", extraction_confidence: 0.9 }] },
      session,
    );
    expect(out.proposed_nodes[0]).toMatchObject({ workspace_id: "ws-1", user_id: "user-1", source_span: null, soft_links: [] });
    expect(out.prompt_version).toBe("extract-v21");
  });

  it("treats a missing node list as an update with nothing new", () => {
    const out = validateExtractionOutput({ complete_existing_node_ids: ["00000000-0000-0000-0000-000000000001"] }, session);
    expect(out.proposed_nodes).toEqual([]);
    expect(out.complete_existing_node_ids).toHaveLength(1);
  });

  it("still rejects a node list that isn't an array", () => {
    expect(() => validateExtractionOutput({ proposed_nodes: "nope" }, session)).toThrow();
  });

  it("accepts the v2 types and maps a legacy concept to a note", () => {
    const node = (local_ref: string, proposed_node_type: string) => ({
      local_ref,
      proposed_title: `Node ${local_ref}`,
      proposed_node_type,
      extraction_confidence: 0.9,
    });
    const out = validateExtractionOutput(
      { proposed_nodes: [node("n1", "big_task"), node("n2", "area"), node("n3", "concept")] },
      session,
    );
    expect(out.proposed_nodes.map((n) => n.proposed_node_type)).toEqual(["big_task", "area", "note"]);
    expect(() => validateExtractionOutput({ proposed_nodes: [node("n1", "journal")] }, session)).toThrow();
  });

  it("drops a dependency or soft link that points at the node's own parent", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [
          { local_ref: "p", proposed_title: "Build the app", proposed_node_type: "project", extraction_confidence: 0.9 },
          { local_ref: "x", proposed_title: "Write the landing page", proposed_node_type: "big_task", extraction_confidence: 0.9 },
          {
            local_ref: "m",
            proposed_title: "Market the app",
            proposed_node_type: "big_task",
            primary_parent_local_ref: "p",
            depends_on_local_refs: ["p", "x"],
            soft_links: [
              { target_local_ref: "p", edge_type: "supports" },
              { target_local_ref: "x", edge_type: "useful_for" },
            ],
            extraction_confidence: 0.9,
          },
        ],
      },
      session,
    );
    const market = out.proposed_nodes[2];
    expect(market.depends_on_local_refs).toEqual(["x"]);
    expect(market.soft_links.map((l) => l.target_local_ref)).toEqual(["x"]);
  });
});
