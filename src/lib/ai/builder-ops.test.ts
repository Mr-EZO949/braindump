// The builder's output as a change set: refs re-pointed after dedup, a dump's
// restructure split from its plain new nodes, everything as ops.

import { describe, expect, it } from "vitest";

import type { BuilderChange, ExtractionOutput } from "@/types/ai";

import {
  builderToOps,
  mergeEditPass,
  readStreamedEditRequests,
  resolveBuilderChanges,
  splitRestructureSet,
  type BuilderNode,
} from "./builder-ops";

const MONEY = "aaaaaaaa-0000-4000-8000-000000000001";
const FUSED = "aaaaaaaa-0000-4000-8000-000000000002";
const FIXES = "aaaaaaaa-0000-4000-8000-000000000003";
const INTERN = "aaaaaaaa-0000-4000-8000-000000000004";
const GONE = "aaaaaaaa-0000-4000-8000-00000000dead";
const active = new Set([MONEY, FUSED, FIXES, INTERN]);

function node(local_ref: string, title: string, extra: Partial<BuilderNode> = {}): BuilderNode {
  return {
    workspace_id: "w1",
    user_id: "u1",
    local_ref,
    primary_parent_local_ref: null,
    existing_parent_node_id: null,
    depends_on_local_refs: [],
    soft_links: [],
    accepted_node_id: null,
    proposed_title: title,
    proposed_summary: null,
    proposed_body: null,
    proposed_node_type: "task",
    proposed_target_date: null,
    extraction_confidence: 0.9,
    source_span: null,
    proposal_status: "pending_review",
    ...extra,
  } as BuilderNode;
}

describe("resolveBuilderChanges", () => {
  const base = {
    activeNodeIds: active,
    survivingRefs: new Set(["n1", "n2"]),
    droppedRefToExistingId: new Map([["n9", MONEY]]),
    droppedRefToKeptRef: new Map([["n8", "n2"]]),
  };

  it("keeps edits whose nodes exist and points dropped refs at what survived", () => {
    const changes: BuilderChange[] = [
      { kind: "move", node_id: FUSED, new_parent: "n1" },
      // The new parent was dropped as a copy of an existing node → move there.
      { kind: "move", node_id: FIXES, new_parent: "n9" },
      // …or as a copy of another proposal in the same output → the kept one.
      { kind: "link", source: "n8", target: INTERN, edge_type: "supports" },
      { kind: "update", node_id: FUSED, title: "Test BrainDump" },
    ];
    expect(resolveBuilderChanges({ ...base, changes })).toEqual({
      changes: [
        { kind: "move", node_id: FUSED, new_parent: "n1" },
        { kind: "move", node_id: FIXES, new_parent: MONEY },
        { kind: "link", source: "n2", target: INTERN, edge_type: "supports" },
        { kind: "update", node_id: FUSED, title: "Test BrainDump" },
      ],
      broken: [],
    });
  });

  it("drops edits on nodes that aren't in the workspace and second moves", () => {
    const changes: BuilderChange[] = [
      { kind: "move", node_id: GONE, new_parent: MONEY },
      { kind: "update", node_id: GONE, title: "x" },
      { kind: "link", source: INTERN, target: GONE, edge_type: "supports" },
      { kind: "move", node_id: FIXES, new_parent: MONEY },
      { kind: "move", node_id: FIXES, new_parent: INTERN }, // one parent per node
      { kind: "link", source: FIXES, target: INTERN, edge_type: "supports" },
      { kind: "link", source: FIXES, target: INTERN, edge_type: "supports" },
    ];
    expect(resolveBuilderChanges({ ...base, changes })).toEqual({
      changes: [
        { kind: "move", node_id: FIXES, new_parent: MONEY },
        { kind: "link", source: FIXES, target: INTERN, edge_type: "supports" },
      ],
      broken: [],
    });
  });

  it("a move under a parent that was never proposed drops EVERY edit to that node", () => {
    // The 2026-09-30 long-dump run: rename + retype the fused node, move it and
    // its step under "n11" — and no n11 in proposed_nodes. Applying only the
    // rename would lose the marketing half for good.
    const changes: BuilderChange[] = [
      { kind: "update", node_id: FUSED, title: "Test BrainDump", node_type: "big_task" },
      { kind: "move", node_id: FUSED, new_parent: "n11" },
      { kind: "move", node_id: FIXES, new_parent: "n11" },
      // An unrelated, complete edit in the same output still applies.
      { kind: "move", node_id: INTERN, new_parent: MONEY },
      { kind: "link", source: FUSED, target: INTERN, edge_type: "supports" },
    ];
    expect(resolveBuilderChanges({ ...base, changes })).toEqual({
      changes: [
        { kind: "move", node_id: INTERN, new_parent: MONEY },
        { kind: "link", source: FUSED, target: INTERN, edge_type: "supports" },
      ],
      broken: [FUSED, FIXES],
    });
  });
});

describe("splitRestructureSet", () => {
  it("sends the new subtree a move depends on to the card, the rest to review", () => {
    const nodes = [
      node("n1", "BrainDump", { proposed_node_type: "project", existing_parent_node_id: MONEY }),
      node("n2", "Market BrainDump", { primary_parent_local_ref: "n1" }),
      node("n3", "Renew my passport"),
      node("n4", "Life Admin", { proposed_node_type: "area" }),
      node("n5", "Pay the rent", { primary_parent_local_ref: "n4" }),
    ];
    const changes: BuilderChange[] = [
      { kind: "update", node_id: FUSED, title: "Test BrainDump" },
      { kind: "move", node_id: FUSED, new_parent: "n1" },
    ];
    const { plain, restructure } = splitRestructureSet(nodes, changes);
    expect(restructure.map((n) => n.local_ref)).toEqual(["n1", "n2"]);
    expect(plain.map((n) => n.local_ref)).toEqual(["n3", "n4", "n5"]);
  });

  it("pulls in the new parent ABOVE the node a move targets, too", () => {
    const nodes = [
      node("n1", "Products", { proposed_node_type: "area" }),
      node("n2", "BrainDump", { proposed_node_type: "project", primary_parent_local_ref: "n1" }),
      node("n3", "Call mom"),
    ];
    const { restructure } = splitRestructureSet(nodes, [{ kind: "move", node_id: FUSED, new_parent: "n2" }]);
    expect(restructure.map((n) => n.local_ref)).toEqual(["n1", "n2"]);
  });

  it("leaves a dump with no moves onto new nodes entirely to the review", () => {
    const nodes = [node("n1", "Renew my passport")];
    const changes: BuilderChange[] = [
      { kind: "move", node_id: FUSED, new_parent: MONEY },
      { kind: "link", source: "n1", target: INTERN, edge_type: "supports" },
    ];
    const { plain, restructure } = splitRestructureSet(nodes, changes);
    expect(plain).toHaveLength(1);
    expect(restructure).toHaveLength(0);
  });
});

describe("builderToOps", () => {
  it("writes creates, edits, links and completions as change-set ops", () => {
    const nodes = [
      node("n1", "BrainDump", { proposed_node_type: "project", existing_parent_node_id: MONEY }),
      node("n2", "Market BrainDump", {
        proposed_node_type: "big_task",
        primary_parent_local_ref: "n1",
        proposed_target_date: "2026-11-01",
        soft_links: [{ target_local_ref: "n3", edge_type: "required_for", rationale: null }],
      }),
      node("n3", "Launch post", { primary_parent_local_ref: "n1", depends_on_local_refs: ["n2"] }),
    ];
    const ops = builderToOps({
      nodes,
      changes: [
        { kind: "update", node_id: FUSED, title: "Test BrainDump" },
        { kind: "move", node_id: FUSED, new_parent: "n1" },
        { kind: "link", source: FUSED, target: INTERN, edge_type: "supports", rationale: "shows real work" },
      ],
      completeExistingNodeIds: [FIXES],
      autoCompleteLocalRefs: ["n3", "n99"],
    });

    expect(ops).toEqual([
      { kind: "create_node", local_ref: "n1", title: "BrainDump", node_type: "project", parent_node_id: MONEY },
      {
        kind: "create_node",
        local_ref: "n2",
        title: "Market BrainDump",
        node_type: "big_task",
        target_date: "2026-11-01",
        parent_local_ref: "n1",
      },
      { kind: "create_node", local_ref: "n3", title: "Launch post", node_type: "task", parent_local_ref: "n1" },
      { kind: "update", node_id: FUSED, title: "Test BrainDump" },
      { kind: "move", node_id: FUSED, new_parent_node_id: "n1" },
      {
        kind: "create_edge",
        source_node_id: FUSED,
        target_node_id: INTERN,
        edge_type: "supports",
        explanation: "shows real work",
      },
      // "n2 prerequisite_for n3" and "n3 depends on n2" are both n2 → n3.
      { kind: "create_edge", source_node_id: "n2", target_node_id: "n3", edge_type: "required_for" },
      { kind: "create_edge", source_node_id: "n2", target_node_id: "n3", edge_type: "required_for" },
      { kind: "complete", node_id: FIXES },
      { kind: "complete", node_id: "n3" },
    ]);
  });

  it("drops links to new nodes that aren't part of this set", () => {
    const ops = builderToOps({
      nodes: [node("n1", "BrainDump", { soft_links: [{ target_local_ref: "n7", edge_type: "supports", rationale: null }] })],
      changes: [
        { kind: "move", node_id: FUSED, new_parent: "n7" },
        { kind: "link", source: "n7", target: INTERN, edge_type: "supports" },
      ],
    });
    expect(ops).toEqual([{ kind: "create_node", local_ref: "n1", title: "BrainDump", node_type: "task" }]);
  });
});

describe("mergeEditPass — the short prompt's edits joined to the long prompt's adds", () => {
  const output = (extra: Partial<ExtractionOutput>): ExtractionOutput => ({
    proposed_nodes: [],
    changes: [],
    edit_requests: [],
    clarifying_questions: [],
    complete_existing_node_ids: [],
    auto_complete_local_refs: [],
    prompt_version: "test",
    ...extra,
  });

  it("prefixes the edit pass's refs and puts its nodes first", () => {
    const main = output({
      proposed_nodes: [node("n1", "ML Course Project"), node("n2", "Pick a Dataset", { primary_parent_local_ref: "n1" })],
      changes: [{ kind: "link", source: "n1", target: INTERN, edge_type: "supports" }],
      edit_requests: ["braindump should be its own project with testing and marketing in it"],
      clarifying_questions: ["Which bank?"],
      complete_existing_node_ids: [FIXES],
    });
    const edit = output({
      proposed_nodes: [
        node("n1", "BrainDump", { proposed_node_type: "project", existing_parent_node_id: MONEY }),
        node("n2", "Market BrainDump", {
          primary_parent_local_ref: "n1",
          depends_on_local_refs: ["n1"],
          soft_links: [
            { target_local_ref: "n1", edge_type: "supports", rationale: null },
            { target_local_ref: INTERN, edge_type: "supports", rationale: null },
          ],
        }),
      ],
      changes: [
        { kind: "update", node_id: FUSED, title: "Test BrainDump" },
        { kind: "move", node_id: FUSED, new_parent: "n1" },
        { kind: "move", node_id: FIXES, new_parent: MONEY },
        { kind: "link", source: "n2", target: INTERN, edge_type: "supports" },
      ],
      clarifying_questions: ["Should the fixes move too?"],
      complete_existing_node_ids: [FIXES],
      auto_complete_local_refs: ["n2"],
    });

    const merged = mergeEditPass(main, edit);
    expect(merged.proposed_nodes.map((n) => [n.local_ref, n.primary_parent_local_ref])).toEqual([
      ["e_n1", null],
      ["e_n2", "e_n1"],
      ["n1", null],
      ["n2", "n1"],
    ]);
    expect(merged.proposed_nodes[1].depends_on_local_refs).toEqual(["e_n1"]);
    expect(merged.proposed_nodes[1].soft_links.map((l) => l.target_local_ref)).toEqual(["e_n1", INTERN]);
    expect(merged.changes).toEqual([
      { kind: "update", node_id: FUSED, title: "Test BrainDump" },
      { kind: "move", node_id: FUSED, new_parent: "e_n1" },
      { kind: "move", node_id: FIXES, new_parent: MONEY },
      { kind: "link", source: "e_n2", target: INTERN, edge_type: "supports" },
      { kind: "link", source: "n1", target: INTERN, edge_type: "supports" },
    ]);
    expect(merged.edit_requests).toEqual([]);
    expect(merged.clarifying_questions).toEqual(["Should the fixes move too?", "Which bank?"]);
    expect(merged.complete_existing_node_ids).toEqual([FIXES]);
    expect(merged.auto_complete_local_refs).toEqual(["e_n2"]);
  });
});

describe("readStreamedEditRequests — the edit pass starts while the answer streams", () => {
  const head = '{\n  "edit_requests": ["braindump should be its own project, with [testing] and \\"marketing\\"", "italian is personal development"';

  it("waits until the array is complete", () => {
    expect(readStreamedEditRequests('{"edit_req')).toBeNull();
    expect(readStreamedEditRequests('{"edit_requests": ["braindump should')).toBeNull();
    expect(readStreamedEditRequests(head)).toBeNull();
  });

  it("reads the sentences once the array closes — brackets and quotes inside them don't end it", () => {
    expect(readStreamedEditRequests(`${head}],\n  "proposed_nodes": [{"local_ref": "n1"`)).toEqual([
      'braindump should be its own project, with [testing] and "marketing"',
      "italian is personal development",
    ]);
  });

  it("an empty list is an answer (no edit pass); no list at all is not", () => {
    expect(readStreamedEditRequests('{"edit_requests": [], "proposed_nodes": [')).toEqual([]);
    expect(readStreamedEditRequests('{"proposed_nodes": [{"proposed_title": "Call the bank"}]')).toBeNull();
  });

  it("cleans the list the way the final validation does", () => {
    expect(readStreamedEditRequests('{"edit_requests": ["  move X under Y ", "move X under Y", 3, ""]')).toEqual([
      "move X under Y",
    ]);
  });
});
