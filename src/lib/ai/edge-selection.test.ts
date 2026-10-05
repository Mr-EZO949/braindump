import { describe, expect, it } from "vitest";

import type { EdgeInferenceResult } from "@/types/ai";

import {
  buildLinkStructure,
  capWeakLinks,
  helpingWorkType,
  isRedundantLink,
  selectEdgeProposals,
  treeRelation,
  type EdgeProposal,
} from "./edge-selection";

const SOURCE = "src";
const types = new Map<string, string | null>([
  ["la", "goal"],
  ["sleep", "goal"],
  ["brand", "project"],
  ["market", "big_task"],
  ["money", "area"],
  ["extra", "project"],
]);

function verdict(
  candidate_id: string,
  edge_type: EdgeInferenceResult["edge_type"],
  from: "source" | "candidate",
  confidence: number,
): EdgeInferenceResult {
  return { candidate_id, related: true, edge_type, from, confidence, explanation: "because" };
}

function select(
  results: EdgeInferenceResult[],
  overrides: Partial<Pick<Parameters<typeof selectEdgeProposals>[0], "sourceType" | "sourceHasParent" | "titleById" | "structure" | "candidateTypeById">> = {},
) {
  return selectEdgeProposals({
    sourceId: SOURCE,
    sourceType: overrides.sourceType ?? "goal",
    sourceHasParent: overrides.sourceHasParent ?? true,
    results,
    candidateTypeById: overrides.candidateTypeById ?? types,
    titleById: overrides.titleById,
    structure: overrides.structure,
  });
}

describe("selectEdgeProposals", () => {
  it("takes direction from the verdict, not from the link type", () => {
    // Asked from "Pass ML": Linear Algebra helps it → the link starts at LA.
    const [edge] = select([verdict("la", "useful_for", "candidate", 0.85)]);
    expect(edge).toMatchObject({ source_node_id: "la", target_node_id: SOURCE, edge_type: "useful_for" });
    const [forward] = select([verdict("la", "useful_for", "source", 0.85)]);
    expect(forward).toMatchObject({ source_node_id: SOURCE, target_node_id: "la" });
  });

  it("keeps several lateral links per node, best first, capped", () => {
    const edges = select([
      verdict("brand", "supports", "source", 0.7),
      verdict("market", "supports", "source", 0.9),
      verdict("extra", "useful_for", "source", 0.65),
    ]);
    expect(edges.map((e) => e.target_node_id)).toEqual(["market", "brand"]);
  });

  it("proposes a dependency only when it is clear; an unsure one becomes supports", () => {
    const edges = select([
      verdict("la", "required_for", "candidate", 0.9),
      verdict("sleep", "required_for", "candidate", 0.65),
    ]);
    expect(edges).toEqual([
      expect.objectContaining({ source_node_id: "la", edge_type: "required_for" }),
      expect.objectContaining({ source_node_id: "sleep", edge_type: "supports" }),
    ]);
  });

  it("maps the legacy dependency types onto required_for with the right direction", () => {
    const [dependsOn] = select([verdict("la", "depends_on", "source", 0.9)]);
    // "source depends on LA" → LA required_for source.
    expect(dependsOn).toMatchObject({ source_node_id: "la", target_node_id: SOURCE, edge_type: "required_for" });
    const [prerequisite] = select([verdict("la", "prerequisite_for", "source", 0.9)]);
    expect(prerequisite).toMatchObject({ source_node_id: SOURCE, target_node_id: "la", edge_type: "required_for" });
  });

  it("never proposes a parent for a node that has one", () => {
    expect(select([verdict("money", "belongs_to", "source", 0.95)])).toEqual([]);
  });

  it("refuses a parent that can't hold the node (project under a big task)", () => {
    // The 2026-09-30 screenshot: project "BrainDump" → belongs_to → big task.
    const free = { sourceType: "project", sourceHasParent: false };
    expect(select([verdict("market", "belongs_to", "source", 0.95)], free)).toEqual([]);
    expect(select([verdict("money", "belongs_to", "source", 0.95)], free)).toEqual([
      expect.objectContaining({ source_node_id: SOURCE, target_node_id: "money", edge_type: "belongs_to" }),
    ]);
    // A parent link only ever goes source → candidate.
    expect(select([verdict("money", "belongs_to", "candidate", 0.95)], free)).toEqual([]);
  });

  it("drops weak links, unrelated verdicts and ids it never asked about", () => {
    expect(
      select([
        verdict("brand", "related_to", "source", 0.65),
        verdict("market", "supports", "source", 0.5),
        { ...verdict("la", "supports", "source", 0.9), related: false },
        verdict("unknown", "supports", "source", 0.9),
      ]),
    ).toEqual([]);
  });

  it("keeps two real blockers per node (passport → visa → move), not three", () => {
    const deps = new Map<string, string | null>([["move", "goal"], ["passport", "task"], ["offer", "task"]]);
    const edges = select(
      [
        verdict("move", "required_for", "source", 0.99),
        verdict("passport", "required_for", "candidate", 0.9),
        verdict("offer", "required_for", "candidate", 0.8),
      ],
      { sourceType: "task", candidateTypeById: deps },
    );
    expect(edges.map((e) => [e.source_node_id, e.edge_type, e.target_node_id])).toEqual([
      [SOURCE, "required_for", "move"],
      ["passport", "required_for", SOURCE],
    ]);
  });

  it("never makes helping work a hard blocker: marketing supports a launch, a review is useful_for", () => {
    const titleById = new Map([
      [SOURCE, "Market BrainDump"],
      ["brand", "Launch the BrainDump Beta"],
      ["la", "Linear Algebra Review"],
    ]);
    // The 10-05 eval: Haiku says Market → required_for → Launch at 0.95.
    expect(select([verdict("brand", "required_for", "source", 0.95)], { sourceType: "big_task", titleById })).toEqual([
      expect.objectContaining({ source_node_id: SOURCE, target_node_id: "brand", edge_type: "supports" }),
    ]);
    expect(select([verdict("la", "required_for", "candidate", 0.95)], { sourceType: "goal", titleById })).toEqual([
      expect.objectContaining({ source_node_id: "la", target_node_id: SOURCE, edge_type: "useful_for" }),
    ]);
    // Only the blocker's own title counts: launching can still block marketing.
    expect(select([verdict("brand", "required_for", "candidate", 0.95)], { sourceType: "big_task", titleById })[0]).toMatchObject({
      source_node_id: "brand",
      edge_type: "required_for",
    });
  });

  it("only lets work block work: a habit or an area is never a blocker", () => {
    const edges = select([verdict("money", "required_for", "candidate", 0.9)]);
    expect(edges).toEqual([expect.objectContaining({ source_node_id: "money", edge_type: "supports" })]);
    expect(helpingWorkType("Weekly networking coffee")).toBe("supports");
    expect(helpingWorkType("Prepare the visa documents")).toBeNull();
  });
});

describe("structural cuts (fewer links, #24)", () => {
  // root ─ area "Uni" ─ project "Thesis" ─ src, sib
  //                   └ lone
  //      └ "Side" (project) ─ far
  const structure = () =>
    buildLinkStructure({
      edges: [
        { source_node_id: "uni", target_node_id: "root", edge_type: "belongs_to" },
        { source_node_id: "side", target_node_id: "root", edge_type: "belongs_to" },
        { source_node_id: "thesis", target_node_id: "uni", edge_type: "belongs_to" },
        { source_node_id: "lone", target_node_id: "uni", edge_type: "belongs_to" },
        { source_node_id: SOURCE, target_node_id: "thesis", edge_type: "belongs_to" },
        { source_node_id: "sib", target_node_id: "thesis", edge_type: "belongs_to" },
        { source_node_id: "far", target_node_id: "side", edge_type: "belongs_to" },
        { source_node_id: "tutor", target_node_id: "side", edge_type: "supports" },
        { source_node_id: "a", target_node_id: "b", edge_type: "supports" },
        { source_node_id: "b", target_node_id: "c", edge_type: "useful_for" },
        { source_node_id: "c", target_node_id: "a", edge_type: "depends_on" },
      ],
      pending: [{ source_node_id: "far", target_node_id: "lone", edge_type: "related_to" }],
      nodeTypes: new Map([["uni", "area"], ["thesis", "project"], ["side", "project"], ["root", "area"]]),
      rootId: "root",
    });
  const kinds = new Map<string, string | null>([
    ["thesis", "project"], ["uni", "area"], ["sib", "task"], ["lone", "project"], ["side", "project"], ["far", "task"],
  ]);

  it("reads the tree: ancestors, descendants, siblings, the root doesn't count", () => {
    const s = structure();
    expect(treeRelation(s, SOURCE, "uni")).toBe("ancestor");
    expect(treeRelation(s, "uni", SOURCE)).toBe("descendant");
    expect(treeRelation(s, SOURCE, "sib")).toBe("sibling");
    expect(treeRelation(s, "thesis", "lone")).toBe("sibling_in_area");
    expect(treeRelation(s, "uni", "side")).toBeNull(); // both under the root
    expect(s.weakCount.get("far")).toBe(1); // pending proposals count
    expect(s.links).toContainEqual({ source: "a", target: "c", dependency: true }); // depends_on flipped
  });

  it("drops links to the node's own ancestors and descendants", () => {
    const edges = select(
      [verdict("thesis", "supports", "source", 0.9), verdict("uni", "related_to", "source", 0.95)],
      { structure: structure(), candidateTypeById: kinds, sourceType: "task" },
    );
    expect(edges).toEqual([]);
  });

  it("siblings in a project keep a real blocker but no lateral link; siblings in an area lose only related_to", () => {
    const s = structure();
    const opts = { structure: s, candidateTypeById: kinds, sourceType: "task" };
    expect(select([verdict("sib", "supports", "candidate", 0.9)], opts)).toEqual([]);
    expect(select([verdict("sib", "required_for", "candidate", 0.9)], opts)).toEqual([
      expect.objectContaining({ source_node_id: "sib", edge_type: "required_for" }),
    ]);
    const asThesis = (r: EdgeInferenceResult[]) =>
      selectEdgeProposals({ sourceId: "thesis", sourceType: "project", sourceHasParent: true, results: r, candidateTypeById: kinds, structure: s });
    expect(asThesis([verdict("lone", "related_to", "source", 0.9)])).toEqual([]);
    expect(asThesis([verdict("lone", "supports", "source", 0.9)])).toHaveLength(1);
  });

  it("skips a link the graph already says, one level up or through one node", () => {
    const s = structure();
    // tutor → supports → side covers tutor → far (far lives under side).
    expect(isRedundantLink(s, "tutor", "far", false)).toBe(true);
    // a → b → c covers a → c.
    expect(isRedundantLink(s, "a", "c", false)).toBe(true);
    // Not the other way round, and not when nothing links them.
    expect(isRedundantLink(s, "far", "tutor", false)).toBe(false);
    expect(isRedundantLink(s, "sib", "far", false)).toBe(false);
    // A blocker is only covered by blockers: a supports path says less.
    expect(isRedundantLink(s, "a", "c", true)).toBe(true); // c depends_on a
    expect(isRedundantLink(s, "tutor", "far", true)).toBe(false);
    // The root is not an ancestor that covers anything.
    expect(isRedundantLink(s, "uni", "side", false)).toBe(false);
  });
});

describe("capWeakLinks", () => {
  const link = (source: string, target: string, edge_type: string, confidence: number): EdgeProposal => ({
    source_node_id: source,
    target_node_id: target,
    edge_type,
    confidence,
    explanation: "x",
  });

  it("caps lateral links per node across a batch, best first; blockers and parents always pass", () => {
    const proposals = [
      link("a", "hub", "supports", 0.7),
      link("b", "hub", "supports", 0.9),
      link("c", "hub", "useful_for", 0.8),
      link("d", "hub", "required_for", 0.95),
      link("e", "f", "related_to", 0.85),
    ];
    const kept = capWeakLinks(proposals, new Map([["hub", 1]]), 3);
    expect(kept.map((p) => p.source_node_id)).toEqual(["b", "c", "d", "e"]);
  });

  it("gives a node that is already a hub nothing new", () => {
    expect(capWeakLinks([link("a", "hub", "supports", 0.99)], new Map([["hub", 3]]), 3)).toEqual([]);
  });
});
