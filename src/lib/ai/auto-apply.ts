// Calibrated auto-apply — which extracted proposals skip the review modal.
//
// Evidence (live DB, 2026-09-28): across 1,224 review decisions users accepted
// 1,207 and rejected 17 (98.6%), and every risk class below was ≥97%. Another
// 138 proposals (10%) were never reviewed at all — abandoned in the modal. So
// "review everything" cost one decision per node, caught ~1.4% of errors, lost
// ~10% of captures, and still let duplicates through. Quality control belongs
// upstream (retrieval + resolution) plus a cheap, one-tap Undo — not a gate on
// every node.
//
// Policy: a proposal is applied automatically when THIS user's history says
// they accept that kind of proposal ≥90% of the time (Beta posterior over
// their recent decisions, with a conservative population prior for new users),
// it isn't a possible duplicate, and its same-dump parent is applied too (so
// structure never splits). Undo marks the proposals rejected, which feeds
// straight back into the calibration: a user who undoes a lot gets review back.

import type { SupabaseClient } from "@supabase/supabase-js";

export type RiskClass = `${"leaf" | "objective"}/${"parented" | "top"}/${"hi" | "lo"}`;

export interface ClassStats {
  accepted: number;
  rejected: number;
}

export const AUTO_APPLY_THRESHOLD = 0.9;
// Cold-start prior: population acceptance was 98.6%; use a more conservative
// 0.95 mean with the weight of 10 decisions, so two early rejections in a
// class are enough to bring review back for that class.
const PRIOR_ACCEPTED = 9.5;
const PRIOR_REJECTED = 0.5;
// Only recent behaviour matters; also bounds the calibration query.
export const CALIBRATION_WINDOW = 500;
const HIGH_CONFIDENCE = 0.85;

const OBJECTIVE_TYPES = new Set(["goal", "project", "class", "concept"]);

export interface AutoApplyCandidate {
  id: string;
  local_ref: string | null;
  primary_parent_local_ref: string | null;
  existing_parent_node_id: string | null;
  proposed_node_type: string;
  extraction_confidence: number;
}

export function riskClassOf(p: {
  proposed_node_type: string;
  extraction_confidence: number;
  existing_parent_node_id: string | null;
  primary_parent_local_ref: string | null;
}): RiskClass {
  const level = OBJECTIVE_TYPES.has(p.proposed_node_type) ? "objective" : "leaf";
  const placement = p.existing_parent_node_id || p.primary_parent_local_ref ? "parented" : "top";
  const confidence = p.extraction_confidence >= HIGH_CONFIDENCE ? "hi" : "lo";
  return `${level}/${placement}/${confidence}`;
}

export function posteriorAcceptRate(stats: ClassStats | undefined): number {
  const accepted = stats?.accepted ?? 0;
  const rejected = stats?.rejected ?? 0;
  return (accepted + PRIOR_ACCEPTED) / (accepted + rejected + PRIOR_ACCEPTED + PRIOR_REJECTED);
}

export function selectAutoApply(params: {
  proposals: AutoApplyCandidate[];
  // Proposals that must go to review (e.g. possible duplicates).
  heldIds: Set<string>;
  stats: Map<RiskClass, ClassStats>;
}): string[] {
  const eligible = new Set(
    params.proposals
      .filter(
        (p) =>
          !params.heldIds.has(p.id) &&
          posteriorAcceptRate(params.stats.get(riskClassOf(p))) >= AUTO_APPLY_THRESHOLD,
      )
      .map((p) => p.id),
  );

  // Structural closure: a child whose parent is another proposal in this dump
  // is only applied if that parent is — never create half a subtree.
  const idByRef = new Map(
    params.proposals.flatMap((p) => (p.local_ref ? [[p.local_ref, p.id] as const] : [])),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of params.proposals) {
      if (!eligible.has(p.id) || !p.primary_parent_local_ref) continue;
      const parentId = idByRef.get(p.primary_parent_local_ref);
      if (parentId && !eligible.has(parentId)) {
        eligible.delete(p.id);
        changed = true;
      }
    }
  }

  return params.proposals.filter((p) => eligible.has(p.id)).map((p) => p.id);
}

// This user's recent review decisions, bucketed by risk class.
export async function loadCalibrationStats(
  supabase: SupabaseClient,
  userId: string,
): Promise<Map<RiskClass, ClassStats>> {
  const { data } = await supabase
    .from("proposed_nodes")
    .select(
      "proposal_status, proposed_node_type, extraction_confidence, existing_parent_node_id, primary_parent_local_ref",
    )
    .eq("user_id", userId)
    .in("proposal_status", ["accepted", "rejected"])
    .order("created_at", { ascending: false })
    .limit(CALIBRATION_WINDOW);

  const stats = new Map<RiskClass, ClassStats>();
  for (const row of (data ?? []) as Array<{
    proposal_status: string;
    proposed_node_type: string;
    extraction_confidence: number | null;
    existing_parent_node_id: string | null;
    primary_parent_local_ref: string | null;
  }>) {
    const cls = riskClassOf({
      proposed_node_type: row.proposed_node_type,
      extraction_confidence: row.extraction_confidence ?? 0,
      existing_parent_node_id: row.existing_parent_node_id,
      primary_parent_local_ref: row.primary_parent_local_ref,
    });
    const entry = stats.get(cls) ?? { accepted: 0, rejected: 0 };
    if (row.proposal_status === "accepted") entry.accepted++;
    else entry.rejected++;
    stats.set(cls, entry);
  }
  return stats;
}
