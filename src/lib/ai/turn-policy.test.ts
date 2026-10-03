import { describe, expect, it } from "vitest";

import type { ChangeOp } from "@/lib/graph/change-set";

import { blockedBySkips, previewSelection, resolveRefs, selectOps, splitByPolicy } from "./turn-policy";

const MONEY = "11111111-1111-4111-8111-111111111111";
const FUSED = "22222222-2222-4222-8222-222222222222";
const ITALIAN = "33333333-3333-4333-8333-333333333333";
const PERSONAL = "44444444-4444-4444-8444-444444444444";
const INTERNSHIP = "55555555-5555-4555-8555-555555555555";
const MIDTERM = "66666666-6666-4666-8666-666666666666";
const GYM = "77777777-7777-4777-8777-777777777777";

// The long mixed dump of 2026-09-30, as the builder planned it.
const MIXED: ChangeOp[] = [
  { kind: "create_node", local_ref: "n1", title: "BrainDump", node_type: "project", parent_node_id: MONEY },
  { kind: "create_node", local_ref: "n2", title: "Market BrainDump", node_type: "big_task", parent_local_ref: "n1" },
  { kind: "create_node", local_ref: "n3", title: "Review Chapters 1-4", node_type: "task", parent_node_id: MIDTERM },
  { kind: "create_node", local_ref: "n4", title: "ML Course Project", node_type: "big_task" },
  { kind: "create_node", local_ref: "n5", title: "Pick a Dataset", node_type: "task", parent_local_ref: "n4" },
  { kind: "update", node_id: FUSED, title: "Test BrainDump" },
  { kind: "move", node_id: FUSED, new_parent_node_id: "n1" },
  { kind: "move", node_id: ITALIAN, new_parent_node_id: PERSONAL },
  { kind: "create_edge", source_node_id: ITALIAN, target_node_id: INTERNSHIP, edge_type: "useful_for" },
  { kind: "create_edge", source_node_id: "n4", target_node_id: INTERNSHIP, edge_type: "useful_for" },
  { kind: "complete", node_id: GYM },
];

const titles = (ops: ChangeOp[]) =>
  ops.map((op) => (op.kind === "create_node" ? `+${op.title}` : op.kind === "create_edge" ? `link ${op.source_node_id.slice(0, 2)}` : op.kind));

describe("splitByPolicy", () => {
  it("applies what is safe and keeps a reorganization together on the card", () => {
    const { now, ask } = splitByPolicy(MIXED, new Set(["n1", "n2", "n3", "n4", "n5"]));
    expect(titles(now)).toEqual([
      "+Review Chapters 1-4",
      "+ML Course Project",
      "+Pick a Dataset",
      "link n4", // new node → existing goal
      "complete",
    ]);
    // The new project waits with the moves into it, and so does its other new
    // child; the link that goes with Italian's move waits with that move.
    expect(titles(ask)).toEqual(["+BrainDump", "+Market BrainDump", "update", "move", "move", "link 33"]);
  });

  it("holds a new node the calibration did not clear — and what hangs under it", () => {
    const { now, ask } = splitByPolicy(MIXED, new Set(["n1", "n2", "n3", "n5"]));
    expect(titles(now)).toEqual(["+Review Chapters 1-4", "complete"]);
    expect(titles(ask)).toContain("+ML Course Project");
    expect(titles(ask)).toContain("+Pick a Dataset");
    expect(titles(ask)).toContain("link n4");
  });

  it("asks about everything when nothing is cleared, except completions", () => {
    const { now } = splitByPolicy(MIXED, new Set());
    expect(titles(now)).toEqual(["complete"]);
  });

  it("a completion of a node that waits waits with it", () => {
    const ops: ChangeOp[] = [
      { kind: "create_node", local_ref: "n1", title: "First V7", node_type: "goal" },
      { kind: "complete", node_id: "n1" },
    ];
    expect(splitByPolicy(ops, new Set()).ask).toHaveLength(2);
    expect(splitByPolicy(ops, new Set(["n1"])).now).toHaveLength(2);
  });

  it("with the auto-add switch off, everything waits — completions and links too", () => {
    const { now, ask } = splitByPolicy(MIXED, new Set(["n1", "n2", "n3", "n4", "n5"]), false);
    expect(now).toEqual([]);
    expect(ask).toEqual(MIXED);
  });
});

describe("resolveRefs", () => {
  it("points the waiting ops at nodes the first half already created", () => {
    const ops: ChangeOp[] = [
      { kind: "create_node", local_ref: "n6", title: "Write the Proposal", node_type: "task", parent_local_ref: "n4" },
      { kind: "move", node_id: FUSED, new_parent_node_id: "n4" },
      { kind: "create_edge", source_node_id: "n4", target_node_id: "n9", edge_type: "supports" },
      { kind: "complete", node_id: "n4" },
    ];
    const out = resolveRefs(ops, new Map([["n4", "real-id"]]));
    expect(out[0]).toEqual({ kind: "create_node", local_ref: "n6", title: "Write the Proposal", node_type: "task", parent_node_id: "real-id" });
    expect(out[1]).toMatchObject({ new_parent_node_id: "real-id" });
    expect(out[2]).toMatchObject({ source_node_id: "real-id", target_node_id: "n9" });
    expect(out[3]).toMatchObject({ node_id: "real-id" });
  });
});

describe("selectOps — accepting part of a card", () => {
  const CARD: ChangeOp[] = [
    { kind: "create_node", local_ref: "n1", title: "BrainDump", node_type: "project", parent_node_id: MONEY },
    { kind: "create_node", local_ref: "n2", title: "Market BrainDump", node_type: "big_task", parent_local_ref: "n1" },
    { kind: "update", node_id: FUSED, title: "Test BrainDump" },
    { kind: "move", node_id: FUSED, new_parent_node_id: "n1" },
    { kind: "move", node_id: ITALIAN, new_parent_node_id: PERSONAL },
    { kind: "create_edge", source_node_id: ITALIAN, target_node_id: INTERNSHIP, edge_type: "useful_for" },
    { kind: "create_edge", source_node_id: "n2", target_node_id: INTERNSHIP, edge_type: "supports" },
  ];

  it("keeps exactly the chosen ops when nothing depends on a skipped one", () => {
    expect(selectOps(CARD, [4, 5])).toEqual([CARD[4], CARD[5]]);
    expect(selectOps(CARD, [0, 1, 2, 3, 4, 5, 6])).toEqual(CARD);
  });

  it("re-homes a new node whose new parent was skipped, and drops moves and links into it", () => {
    const kept = selectOps(CARD, [1, 2, 3, 6]);
    expect(kept).toEqual([
      // Market BrainDump lands where the skipped project would have gone.
      { kind: "create_node", local_ref: "n2", title: "Market BrainDump", node_type: "big_task", parent_node_id: MONEY },
      CARD[2],
      // no move under the project that isn't coming
      CARD[6],
    ]);
  });

  it("drops a link to a skipped new node", () => {
    expect(selectOps(CARD, [0, 6])).toEqual([CARD[0]]);
  });

  it("previews where a node lands when its new parent is unticked", () => {
    const shown = previewSelection(CARD, [1, 2, 3, 4, 5, 6]);
    expect(shown[1]).toEqual({ kind: "create_node", local_ref: "n2", title: "Market BrainDump", node_type: "big_task", parent_node_id: MONEY });
    expect(shown[0]).toBe(CARD[0]);
    expect(shown).toHaveLength(CARD.length);
  });

  it("names the ticked rows that a skipped row makes impossible", () => {
    // Skipping the new project blocks the move into it; nothing else.
    expect(blockedBySkips(CARD, [1, 2, 3, 4, 5, 6])).toEqual([3]);
    expect(blockedBySkips(CARD, [0, 1, 2, 3, 4, 5, 6])).toEqual([]);
    expect(blockedBySkips(CARD, [0, 6])).toEqual([6]);
  });

  it("walks up through several skipped parents, and ends at the root when there is none", () => {
    const ops: ChangeOp[] = [
      { kind: "create_node", local_ref: "a", title: "A", node_type: "area" },
      { kind: "create_node", local_ref: "b", title: "B", node_type: "project", parent_local_ref: "a" },
      { kind: "create_node", local_ref: "c", title: "C", node_type: "task", parent_local_ref: "b" },
    ];
    expect(selectOps(ops, [2])).toEqual([{ kind: "create_node", local_ref: "c", title: "C", node_type: "task" }]);
    expect(selectOps(ops, [0, 2])).toEqual([ops[0], { kind: "create_node", local_ref: "c", title: "C", node_type: "task", parent_local_ref: "a" }]);
  });

  it("ignores indexes that are not on the card", () => {
    expect(selectOps(CARD, [4, 99, -1, 1.5])).toEqual([CARD[4]]);
  });
});
