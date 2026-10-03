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

  it("drops a block that only restates busy time, so later blocks keep their minutes", () => {
    // 15-hour day, 660 free minutes: Sonnet wrote a 4-hour "Stats lecture"
    // placeholder and everything after it was cut (e2e 2026-10-03).
    const out = validatePlanOutput(
      planRaw([
        block({ title: "Study", start_offset: 0, duration_minutes: 360 }),
        block({ title: "Stats Lecture", start_offset: 360, duration_minutes: 120 }),
        block({ title: "Dinner", start_offset: 480, duration_minutes: 60, block_type: "break" }),
        block({ title: "Stats lecture", node_id: "n1", start_offset: 540, duration_minutes: 60 }),
      ]),
      660,
      ["Stats lecture"],
    );
    // The linked block is real work on the class — it stays.
    expect(out.blocks.map((b) => b.title)).toEqual(["Study", "Dinner", "Stats lecture"]);
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

describe("validateExtractionOutput — the user's date words beat the model's arithmetic", () => {
  // 2026-10-02 is a Friday.
  const friday = { ...session, today: "2026-10-02" };
  const node = (extra: Record<string, unknown>) => ({
    local_ref: "n1",
    proposed_title: "Email the professor",
    proposed_node_type: "task",
    extraction_confidence: 0.9,
    ...extra,
  });

  it("resolves the words with the calendar and ignores a wrong target_date", () => {
    const out = validateExtractionOutput({ proposed_nodes: [node({ target_date: "2026-10-06", date_words: "by friday" })] }, friday);
    expect(out.proposed_nodes[0].proposed_target_date).toBe("2026-10-09");
    const oct20 = validateExtractionOutput({ proposed_nodes: [node({ target_date: "2026-10-21", date_words: "oct 20" })] }, friday);
    expect(oct20.proposed_nodes[0].proposed_target_date).toBe("2026-10-20");
  });

  it("keeps target_date when the words don't resolve, or no date is known", () => {
    const q3 = validateExtractionOutput({ proposed_nodes: [node({ target_date: "2026-12-31", date_words: "end of the year" })] }, friday);
    expect(q3.proposed_nodes[0].proposed_target_date).toBe("2026-12-31");
    const noToday = validateExtractionOutput({ proposed_nodes: [node({ target_date: "2026-10-06", date_words: "friday" })] }, session);
    expect(noToday.proposed_nodes[0].proposed_target_date).toBe("2026-10-06");
  });
});

describe("validateExtractionOutput — one bad reference never costs the output", () => {
  const n = (local_ref: string, extra: Record<string, unknown> = {}) => ({
    local_ref,
    proposed_title: `Node ${local_ref}`,
    proposed_node_type: "task",
    extraction_confidence: 0.9,
    ...extra,
  });
  const EXISTING = "11111111-1111-4111-8111-111111111111";

  it("drops a soft link, a dependency or a parent that names no node in the dump", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [
          n("n1"),
          n("n2", {
            primary_parent_local_ref: "n9",
            depends_on_local_refs: ["n1", "n8"],
            soft_links: [
              { target_local_ref: "n6", edge_type: "supports" },
              { target_local_ref: "n1", edge_type: "useful_for" },
            ],
          }),
        ],
      },
      session,
    );
    expect(out.proposed_nodes).toHaveLength(2);
    const second = out.proposed_nodes[1];
    expect(second.primary_parent_local_ref).toBeNull();
    expect(second.depends_on_local_refs).toEqual(["n1"]);
    expect(second.soft_links.map((l) => l.target_local_ref)).toEqual(["n1"]);
    expect(out.changes).toEqual([]);
  });

  it("turns a soft link to an EXISTING node into a link change", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [
          n("n1", { soft_links: [{ target_local_ref: EXISTING, edge_type: "prerequisite_for", rationale: "portfolio piece" }] }),
        ],
        changes: [{ kind: "move", node_id: EXISTING, new_parent: "n1" }],
      },
      session,
    );
    expect(out.proposed_nodes[0].soft_links).toEqual([]);
    expect(out.changes).toEqual([
      { kind: "move", node_id: EXISTING, new_parent: "n1" },
      { kind: "link", source: "n1", target: EXISTING, edge_type: "required_for", rationale: "portfolio piece" },
    ]);
  });

  it("reads an existing node's id in the same-dump parent field as the existing parent", () => {
    const out = validateExtractionOutput({ proposed_nodes: [n("n1", { primary_parent_local_ref: EXISTING })] }, session);
    expect(out.proposed_nodes[0]).toMatchObject({ primary_parent_local_ref: null, existing_parent_node_id: EXISTING });
  });

  it("keeps the same-dump parent when both parents are given, and ignores a self-reference", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [
          n("n1"),
          n("n2", { primary_parent_local_ref: "n1", existing_parent_node_id: EXISTING }),
          n("n3", { primary_parent_local_ref: "n3", depends_on_local_refs: ["n3"] }),
        ],
      },
      session,
    );
    expect(out.proposed_nodes[1]).toMatchObject({ primary_parent_local_ref: "n1", existing_parent_node_id: null });
    expect(out.proposed_nodes[2]).toMatchObject({ primary_parent_local_ref: null, depends_on_local_refs: [] });
  });

  it("drops a malformed node and keeps the rest; rejects only when nothing is usable", () => {
    const out = validateExtractionOutput(
      { proposed_nodes: [n("n1"), { local_ref: "n2", proposed_node_type: "task" }, n("n1"), n("n3", { primary_parent_local_ref: "n2" })] },
      session,
    );
    expect(out.proposed_nodes.map((node) => node.local_ref)).toEqual(["n1", "n3"]);
    expect(out.proposed_nodes[1].primary_parent_local_ref).toBeNull();
    expect(() => validateExtractionOutput({ proposed_nodes: [{ local_ref: "n1" }] }, session)).toThrow();
  });
});

describe("validateExtractionOutput — changes to existing nodes (extract-v25)", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "aaaaaaaa-0000-4000-8000-000000000002";
  const newNode = { local_ref: "n1", proposed_title: "BrainDump", proposed_node_type: "project", extraction_confidence: 0.9 };

  it("keeps well-formed moves, updates and links", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [newNode],
        changes: [
          { kind: "move", node_id: A, new_parent: "n1" },
          { kind: "update", node_id: A, title: " Test BrainDump ", node_type: "big_task" },
          { kind: "link", source: A, target: B, edge_type: "prerequisite_for" },
        ],
      },
      session,
    );
    expect(out.changes).toEqual([
      { kind: "move", node_id: A, new_parent: "n1" },
      { kind: "update", node_id: A, title: "Test BrainDump", node_type: "big_task" },
      { kind: "link", source: A, target: B, edge_type: "required_for", rationale: null },
    ]);
  });

  it("drops malformed entries without failing the nodes around them", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [newNode],
        changes: [
          { kind: "move", node_id: "n1", new_parent: A }, // only existing nodes move
          { kind: "move", node_id: A, new_parent: "not a ref at all" },
          { kind: "move", node_id: A, new_parent: A },
          { kind: "update", node_id: A }, // nothing to change
          { kind: "update", node_id: A, node_type: "galaxy" },
          { kind: "link", source: A, target: B, edge_type: "belongs_to" }, // a move, not a link
          { kind: "archive", node_id: A },
          "nonsense",
        ],
      },
      session,
    );
    expect(out.proposed_nodes).toHaveLength(1);
    expect(out.changes).toEqual([]);
  });

  it("keeps a move onto a local_ref it can't see — the graph step decides (and asks)", () => {
    const out = validateExtractionOutput(
      { proposed_nodes: [newNode], changes: [{ kind: "move", node_id: A, new_parent: "n11" }] },
      session,
    );
    expect(out.changes).toEqual([{ kind: "move", node_id: A, new_parent: "n11" }]);
  });

  it("keeps the quoted edit requests, trimmed and without repeats", () => {
    const out = validateExtractionOutput(
      {
        proposed_nodes: [],
        edit_requests: [
          "  braindump should be its own project with testing and marketing in it ",
          "braindump should be its own project with testing and marketing in it",
          42,
          "",
          "italian isnt really an internship thing, its more personal development",
        ],
      },
      session,
    );
    expect(out.edit_requests).toEqual([
      "braindump should be its own project with testing and marketing in it",
      "italian isnt really an internship thing, its more personal development",
    ]);
    expect(validateExtractionOutput({ proposed_nodes: [] }, session).edit_requests).toEqual([]);
  });

  it("defaults to no changes", () => {
    expect(validateExtractionOutput({ proposed_nodes: [newNode] }, session).changes).toEqual([]);
  });
});

