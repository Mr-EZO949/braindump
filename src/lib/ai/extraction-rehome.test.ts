import { describe, expect, it } from "vitest";
import { rehomeResolvedProposals } from "./extraction";

type P = Parameters<typeof rehomeResolvedProposals>[0]["nodes"][number];

const proposal = (overrides: Partial<P> & { local_ref: string; proposed_title: string }): P =>
  ({
    workspace_id: "ws",
    user_id: "u",
    proposed_summary: null,
    proposed_body: null,
    proposed_node_type: "task",
    primary_parent_local_ref: null,
    existing_parent_node_id: null,
    depends_on_local_refs: [],
    soft_links: [],
    target_date: null,
    extraction_confidence: 0.9,
    source_span: null,
    ...overrides,
  }) as P;

describe("rehomeResolvedProposals", () => {
  it("re-points children of an intra-dump duplicate at the kept copy", () => {
    // Real shape: one dump emitted "Interview Readiness" AND "Maintain Interview
    // Readiness", with a task under the second.
    const kept = proposal({ local_ref: "n1", proposed_title: "Interview Readiness", proposed_node_type: "goal" });
    const dropped = proposal({ local_ref: "n2", proposed_title: "Maintain Interview Readiness", proposed_node_type: "goal" });
    const child = proposal({
      local_ref: "n3",
      proposed_title: "Do 2 LeetCode mediums",
      primary_parent_local_ref: "n2",
      depends_on_local_refs: ["n2"],
      soft_links: [{ target_local_ref: "n2", edge_type: "supports", rationale: null }],
    });
    const [outKept, outChild] = rehomeResolvedProposals({
      nodes: [kept, child],
      droppedProposals: [dropped],
      droppedRefToExistingId: new Map(),
      droppedRefToKeptRef: new Map([["n2", "n1"]]),
      validExistingParentIds: new Set(),
    });
    expect(outKept.primary_parent_local_ref).toBeNull();
    expect(outChild.primary_parent_local_ref).toBe("n1");
    expect(outChild.depends_on_local_refs).toEqual(["n1"]);
    expect(outChild.soft_links.map((l) => l.target_local_ref)).toEqual(["n1"]);
  });

  it("attaches children of a proposal that duplicated an EXISTING node to that node", () => {
    const child = proposal({ local_ref: "n2", proposed_title: "Schedule the OA", primary_parent_local_ref: "n1" });
    const [out] = rehomeResolvedProposals({
      nodes: [child],
      droppedProposals: [proposal({ local_ref: "n1", proposed_title: "Stripe Online Assessment" })],
      droppedRefToExistingId: new Map([["n1", "existing-stripe"]]),
      droppedRefToKeptRef: new Map(),
      validExistingParentIds: new Set(["existing-stripe"]),
    });
    expect(out.primary_parent_local_ref).toBeNull();
    expect(out.existing_parent_node_id).toBe("existing-stripe");
  });

  it("a kept node whose parent was its own dropped twin inherits the twin's place (never itself)", () => {
    const grandparent = proposal({ local_ref: "n0", proposed_title: "Career", proposed_node_type: "goal" });
    const twinParent = proposal({
      local_ref: "n1",
      proposed_title: "Interview Readiness",
      proposed_node_type: "goal",
      primary_parent_local_ref: "n0",
    });
    const kept = proposal({
      local_ref: "n2",
      proposed_title: "Maintain Interview Readiness",
      proposed_node_type: "goal",
      primary_parent_local_ref: "n1",
    });
    const out = rehomeResolvedProposals({
      nodes: [grandparent, kept],
      droppedProposals: [twinParent],
      droppedRefToExistingId: new Map(),
      // n1 was dropped as a copy of n2 (unusual order, but must be safe).
      droppedRefToKeptRef: new Map([["n1", "n2"]]),
      validExistingParentIds: new Set(),
    });
    expect(out[1].primary_parent_local_ref).toBe("n0");
  });

  it("drops existing-parent ids that aren't active workspace nodes", () => {
    const [out] = rehomeResolvedProposals({
      nodes: [proposal({ local_ref: "n1", proposed_title: "X", existing_parent_node_id: "ghost" })],
      droppedProposals: [],
      droppedRefToExistingId: new Map(),
      droppedRefToKeptRef: new Map(),
      validExistingParentIds: new Set(["real"]),
    });
    expect(out.existing_parent_node_id).toBeNull();
  });
});
