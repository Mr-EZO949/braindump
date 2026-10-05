// Which of the model's edge verdicts become proposals. Pure — no I/O — so the
// judgment calls are unit-tested (edge-selection.test.ts). Used by
// connection.ts after the batched inferEdge call.
//
// Links that restate the tree are never proposed: a node and its own ancestor
// or descendant (the parent line already joins them, and a dependency on a
// descendant would be a cycle). The NUMBER of links is not cut otherwise —
// the owner, 2026-10-05: fewer link TYPES, not fewer links.
// And a hard blocker (required_for) can't start at work that only makes the
// other go better — marketing, practice, study, review, networking
// (HELPING_WORDS): "Market BrainDump" → "Launch the beta" is supports. Haiku
// calls that pair required_for at 0.92–0.95 whatever the prompt says (three
// wordings tried: infer-edge-v5, the 10-04 try, a hard_need field on 10-05).

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

export const DEPENDENCY_TYPES = new Set(["required_for", "prerequisite_for", "depends_on", "blocks"]);
export const LATERAL_TYPES = new Set(["supports", "useful_for", "related_to", "inspired_by"]);

// A blocker is something you finish; what it blocks is something you start or
// finish. A habit, area, idea or note never "has to be done first", and an
// area, idea or note is never waiting on anything.
const BLOCKER_TYPES = new Set(["goal", "project", "big_task", "task"]);
const BLOCKED_TYPES = new Set(["goal", "project", "big_task", "task", "class"]);

// Work that makes something else go better but never makes it possible.
// A title with one of these words is never a hard blocker; the learning ones
// become useful_for, the rest supports. "prepare" is left out on purpose
// ("Prepare the visa documents" does block the visa).
const LEARNING_WORDS = ["learn", "learning", "study", "studying", "review", "revise", "revision", "practice", "practise", "practicing", "rehearse", "research", "tutoring"];
const PROMOTION_WORDS = ["market", "marketing", "promote", "promotion", "promo", "advertise", "advertising", "ads", "outreach", "network", "networking", "publicize", "publicise"];
const LEARNING = new Set(LEARNING_WORDS);
const PROMOTION = new Set(PROMOTION_WORDS);

// "supports" / "useful_for" when the title is helping work, else null.
export function helpingWorkType(title: string | null | undefined): "supports" | "useful_for" | null {
  const words = (title ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => LEARNING.has(w))) return "useful_for";
  if (words.some((w) => PROMOTION.has(w))) return "supports";
  return null;
}

// The tree around the nodes being linked: child → parent (the one active
// belongs_to edge).
export interface LinkStructure {
  parentOf: Map<string, string>;
}

type EdgeRow = { source_node_id: string; target_node_id: string; edge_type: string };

export function buildLinkStructure(params: { edges: EdgeRow[] }): LinkStructure {
  const parentOf = new Map<string, string>();
  for (const edge of params.edges) {
    if (edge.edge_type === "belongs_to") parentOf.set(edge.source_node_id, edge.target_node_id);
  }
  return { parentOf };
}

// The node's ancestors, nearest first (cycle-safe).
export function ancestorsOf(structure: LinkStructure, id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let current = structure.parentOf.get(id);
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = structure.parentOf.get(current);
  }
  return out;
}

export type TreeRelation = "ancestor" | "descendant" | null;

// How `other` sits relative to `id` in the tree.
export function treeRelation(structure: LinkStructure, id: string, other: string): TreeRelation {
  if (ancestorsOf(structure, id).includes(other)) return "ancestor";
  if (ancestorsOf(structure, other).includes(id)) return "descendant";
  return null;
}

// Turns the model's per-candidate verdicts into the links worth proposing.
//   - direction comes from the verdict's "from", not from the link type;
//   - a parent link is only proposed for a parentless node, and only under a
//     node whose type can hold it (no project under a big task);
//   - a dependency blocks its target in Focus and the planner, so it has to be
//     a real one: clear, between types that can block, and not helping work.
//     Otherwise it is kept as supports / useful_for when clear enough for that;
//   - no link to the node's own ancestor or descendant when `structure` is given;
//   - at most one parent, DEPENDENCY_PER_NODE dependencies and
//     LATERAL_PER_NODE lateral links.
export function selectEdgeProposals(params: {
  sourceId: string;
  sourceType: string | null;
  sourceHasParent: boolean;
  results: EdgeInferenceResult[];
  candidateTypeById: Map<string, string | null>;
  // Titles by id (source and candidates) — for the helping-work rule.
  titleById?: Map<string, string>;
  structure?: LinkStructure;
}): EdgeProposal[] {
  const { sourceId, sourceType, sourceHasParent, candidateTypeById, structure } = params;
  const typeOfEnd = (id: string) => (id === sourceId ? sourceType : (candidateTypeById.get(id) ?? null));
  const canBlock = (from: string, to: string) => {
    const fromType = typeOfEnd(from);
    const toType = typeOfEnd(to);
    return (!fromType || BLOCKER_TYPES.has(fromType)) && (!toType || BLOCKED_TYPES.has(toType));
  };

  const parents: EdgeProposal[] = [];
  const dependencies: EdgeProposal[] = [];
  const laterals: EdgeProposal[] = [];

  for (const entry of params.results) {
    if (!entry.related || !entry.edge_type) continue;
    if (!candidateTypeById.has(entry.candidate_id)) continue; // an id we didn't ask about
    if (entry.confidence < AI_CONFIDENCE.EDGE_INFERENCE_MIN) continue;

    const relation = structure ? treeRelation(structure, sourceId, entry.candidate_id) : null;
    // The tree already says it (or it would make a cycle).
    if (relation === "ancestor" || relation === "descendant") continue;

    // "depends_on" is the one legacy type written from the dependent's side.
    const fromSource = (entry.from === "source") !== (entry.edge_type === "depends_on");
    const linkFrom = () => ({
      source_node_id: fromSource ? sourceId : entry.candidate_id,
      target_node_id: fromSource ? entry.candidate_id : sourceId,
      confidence: entry.confidence,
      explanation: entry.explanation,
    });

    if (entry.edge_type === "belongs_to") {
      if (!fromSource || sourceHasParent) continue;
      const parentType = normalizeNodeType(candidateTypeById.get(entry.candidate_id));
      if (!ALLOWED_CHILDREN[parentType].has(normalizeNodeType(sourceType))) continue;
      parents.push({ ...linkFrom(), edge_type: "belongs_to" });
      continue;
    }

    let edgeType: string = entry.edge_type;
    if (DEPENDENCY_TYPES.has(edgeType)) {
      const link = linkFrom();
      const helping = helpingWorkType(params.titleById?.get(link.source_node_id));
      const real =
        !helping &&
        canBlock(link.source_node_id, link.target_node_id) &&
        entry.confidence >= AI_CONFIDENCE.EDGE_DEPENDENCY_MIN;
      if (real) {
        dependencies.push({ ...link, edge_type: "required_for" });
        continue;
      }
      edgeType = helping ?? "supports";
    }
    if (!LATERAL_TYPES.has(edgeType)) continue;

    const floor =
      edgeType === "related_to" ? AI_CONFIDENCE.EDGE_RELATED_MIN : AI_CONFIDENCE.EDGE_LATERAL_MIN;
    if (entry.confidence < floor) continue;
    laterals.push({ ...linkFrom(), edge_type: edgeType });
  }

  const byConfidence = (a: EdgeProposal, b: EdgeProposal) => b.confidence - a.confidence;
  return [
    ...parents.sort(byConfidence).slice(0, 1),
    ...dependencies.sort(byConfidence).slice(0, AI_CANDIDATES.DEPENDENCY_PER_NODE),
    ...laterals.sort(byConfidence).slice(0, AI_CANDIDATES.LATERAL_PER_NODE),
  ];
}
