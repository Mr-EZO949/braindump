// Which of the model's edge verdicts become proposals. Pure — no I/O — so the
// judgment calls are unit-tested (edge-selection.test.ts). Used by
// connection.ts after the batched inferEdge call.

import { AI_CANDIDATES, AI_CONFIDENCE } from "@/lib/ai/config";
import { ALLOWED_CHILDREN, normalizeNodeType } from "@/lib/graph/node-types";
import type { EdgeInferenceResult } from "@/types/ai";

export interface EdgeProposal {
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  confidence: number;
  explanation: string;
}

const DEPENDENCY_TYPES = new Set(["required_for", "prerequisite_for", "depends_on", "blocks"]);
const LATERAL_TYPES = new Set(["supports", "useful_for", "related_to", "inspired_by"]);

// Turns the model's per-candidate verdicts into the links worth proposing.
// Pure — the judgment calls live here so they can be tested:
//   - direction comes from the verdict's "from", not from the link type;
//   - a parent link is only proposed for a parentless node, and only under a
//     node whose type can hold it (no project under a big task);
//   - a dependency blocks its target in Focus and the planner, so it needs to
//     be clear — an unsure one is kept as "supports" instead of dropped;
//   - at most one parent, one dependency and LATERAL_PER_NODE lateral links.
export function selectEdgeProposals(params: {
  sourceId: string;
  sourceType: string | null;
  sourceHasParent: boolean;
  results: EdgeInferenceResult[];
  candidateTypeById: Map<string, string | null>;
}): EdgeProposal[] {
  const { sourceId, sourceType, sourceHasParent, candidateTypeById } = params;

  const parents: EdgeProposal[] = [];
  const dependencies: EdgeProposal[] = [];
  const laterals: EdgeProposal[] = [];

  for (const entry of params.results) {
    if (!entry.related || !entry.edge_type) continue;
    if (!candidateTypeById.has(entry.candidate_id)) continue; // an id we didn't ask about
    if (entry.confidence < AI_CONFIDENCE.EDGE_INFERENCE_MIN) continue;

    // "depends_on" is the one legacy type written from the dependent's side.
    const fromSource = (entry.from === "source") !== (entry.edge_type === "depends_on");
    const link = {
      source_node_id: fromSource ? sourceId : entry.candidate_id,
      target_node_id: fromSource ? entry.candidate_id : sourceId,
      confidence: entry.confidence,
      explanation: entry.explanation,
    };

    if (entry.edge_type === "belongs_to") {
      if (!fromSource || sourceHasParent) continue;
      const parentType = normalizeNodeType(candidateTypeById.get(entry.candidate_id));
      if (!ALLOWED_CHILDREN[parentType].has(normalizeNodeType(sourceType))) continue;
      parents.push({ ...link, edge_type: "belongs_to" });
    } else if (DEPENDENCY_TYPES.has(entry.edge_type)) {
      if (entry.confidence >= AI_CONFIDENCE.EDGE_DEPENDENCY_MIN) {
        dependencies.push({ ...link, edge_type: "required_for" });
      } else if (entry.confidence >= AI_CONFIDENCE.EDGE_LATERAL_MIN) {
        laterals.push({ ...link, edge_type: "supports" });
      }
    } else if (LATERAL_TYPES.has(entry.edge_type)) {
      const floor =
        entry.edge_type === "related_to"
          ? AI_CONFIDENCE.EDGE_RELATED_MIN
          : AI_CONFIDENCE.EDGE_LATERAL_MIN;
      if (entry.confidence >= floor) laterals.push({ ...link, edge_type: entry.edge_type });
    }
  }

  const byConfidence = (a: EdgeProposal, b: EdgeProposal) => b.confidence - a.confidence;
  return [
    ...parents.sort(byConfidence).slice(0, 1),
    ...dependencies.sort(byConfidence).slice(0, 1),
    ...laterals.sort(byConfidence).slice(0, AI_CANDIDATES.LATERAL_PER_NODE),
  ];
}
