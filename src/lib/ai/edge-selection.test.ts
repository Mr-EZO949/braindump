import { describe, expect, it } from "vitest";

import type { EdgeInferenceResult } from "@/types/ai";

import {
  buildLinkStructure,
  helpingWorkType,
  selectEdgeProposals,
  treeRelation,
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
    // A retired type from the model ("useful_for") comes out as its kind.
    const [edge] = select([verdict("la", "useful_for", "candidate", 0.85)]);
    expect(edge).toMatchObject({ source_node_id: "la", target_node_id: SOURCE, edge_type: "supports" });
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

  it("never makes helping work a hard blocker: marketing supports a launch, a review supports", () => {
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
      expect.objectContaining({ source_node_id: "la", target_node_id: SOURCE, edge_type: "supports" }),
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

describe("the tree (#24)", () => {
  // root ─ area "Uni" ─ project "Thesis" ─ src, sib
  //      └ "Side" (project) ─ far
  const structure = () =>
    buildLinkStructure({
      edges: [
        { source_node_id: "uni", target_node_id: "root", edge_type: "belongs_to" },
        { source_node_id: "side", target_node_id: "root", edge_type: "belongs_to" },
        { source_node_id: "thesis", target_node_id: "uni", edge_type: "belongs_to" },
        { source_node_id: SOURCE, target_node_id: "thesis", edge_type: "belongs_to" },
        { source_node_id: "sib", target_node_id: "thesis", edge_type: "belongs_to" },
        { source_node_id: "far", target_node_id: "side", edge_type: "belongs_to" },
        { source_node_id: "tutor", target_node_id: "side", edge_type: "supports" },
      ],
    });
  const kinds = new Map<string, string | null>([
    ["thesis", "project"], ["uni", "area"], ["sib", "task"], ["side", "project"], ["far", "task"], ["tutor", "task"],
  ]);

  it("reads ancestors and descendants from belongs_to only", () => {
    const s = structure();
    expect(treeRelation(s, SOURCE, "uni")).toBe("ancestor");
    expect(treeRelation(s, "uni", SOURCE)).toBe("descendant");
    expect(treeRelation(s, SOURCE, "sib")).toBeNull();
    expect(treeRelation(s, "tutor", "side")).toBeNull(); // a supports link isn't the tree
  });

  it("drops links to the node's own ancestors and descendants", () => {
    const edges = select(
      [verdict("thesis", "supports", "source", 0.9), verdict("uni", "related_to", "source", 0.95)],
      { structure: structure(), candidateTypeById: kinds, sourceType: "task" },
    );
    expect(edges).toEqual([]);
  });

  it("keeps links between siblings and links the graph could already imply (owner: fewer types, not fewer links)", () => {
    const opts = { structure: structure(), candidateTypeById: kinds, sourceType: "task" };
    expect(select([verdict("sib", "supports", "candidate", 0.9)], opts)).toHaveLength(1);
    expect(select([verdict("far", "related_to", "source", 0.75)], opts)).toHaveLength(1);
  });
});
