import { describe, expect, it } from "vitest";

import type { EdgeInferenceResult } from "@/types/ai";

import { selectEdgeProposals } from "./edge-selection";

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

function select(results: EdgeInferenceResult[], overrides: { sourceType?: string; sourceHasParent?: boolean } = {}) {
  return selectEdgeProposals({
    sourceId: SOURCE,
    sourceType: overrides.sourceType ?? "goal",
    sourceHasParent: overrides.sourceHasParent ?? true,
    results,
    candidateTypeById: types,
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
});
