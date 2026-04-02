// Scoring service — Phase 7.
// Computes per-node importance scores from graph signals.
// All signals are 0–100. Formula is versioned — change SCORE_VERSION when weights shift.
// Call computeWorkspaceScores() after any event that affects node importance.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getImportanceLabel } from "@/lib/graph/importance";

export const SCORE_VERSION = "v4";

// ---------------------------------------------------------------------------
// Formula weights — must sum to ≤ 1.0 (remainder is blocker bonus headroom)
// ---------------------------------------------------------------------------
const W = {
  urgency: 0.23,
  goal_alignment: 0.17,
  planner: 0.10,
  recency: 0.14,
  centrality: 0.13,
  user_confirmation: 0.08,
  ai_prior: 0.05,
  // blocker_resolved_bonus: flat additive, max +10 points
};

// Reduction factor applied to paused nodes' final score
const PAUSED_FACTOR = 0.32;
const CALIBRATED_SCORE_FLOOR = 12;
const CALIBRATED_SCORE_CEILING = 94;
const WORKSPACE_CALIBRATION_BLEND = 0.58;

// ---------------------------------------------------------------------------
// Internal types (raw DB rows, typed loosely to avoid schema coupling)
// ---------------------------------------------------------------------------

export interface NodeRow {
  id: string;
  node_type: string;
  status: string | null;
  created_at: string;
  workspace_id: string;
}

export interface EdgeRow {
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  status: string | null;
}

interface FeedbackRow {
  event_type: string;
  entity_id: string;
  entity_type: string;
}

// ---------------------------------------------------------------------------
// Signal computations
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * q;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];

  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** urgency_score: task/goal types score higher; creation recency adds a burst. */
export function urgency(node: NodeRow): number {
  const typeBase: Record<string, number> = {
    task: 50,
    goal: 47,
    project: 41,
    concept: 28,
    class: 26,
    idea: 20,
    question: 22,
    journal: 16,
  };
  const base = typeBase[node.node_type] ?? 40;
  const daysSince = (Date.now() - new Date(node.created_at).getTime()) / 86_400_000;
  const recencyBurst = clamp(((21 - daysSince) / 21) * 14, 0, 14);
  return clamp(base + recencyBurst, 0, 100);
}

/** goal_alignment_score: direct edges to/from goal nodes. */
export function goalAlignment(nodeId: string, goalIds: Set<string>, edgesByNode: Map<string, EdgeRow[]>): number {
  if (goalIds.has(nodeId)) return 90; // The node itself is a goal
  const edges = edgesByNode.get(nodeId) ?? [];
  const goalConnections = edges.filter(
    (e) => goalIds.has(e.source_node_id === nodeId ? e.target_node_id : e.source_node_id),
  ).length;
  if (goalConnections === 0) return 5;
  if (goalConnections === 1) return 56;
  if (goalConnections === 2) return 74;
  return 88;
}

/** planner_score: ever appeared in a plan task. */
function plannerScore(nodeId: string, planNodeIds: Set<string>): number {
  return planNodeIds.has(nodeId) ? 78 : 0;
}

/** recency_score: exponential decay from created_at. */
function recency(node: NodeRow): number {
  const daysSince = (Date.now() - new Date(node.created_at).getTime()) / 86_400_000;
  return clamp(100 * Math.exp(-daysSince / 40), 0, 100);
}

/**
 * centrality_score: degree normalized by the highest-degree node in the workspace.
 * Avoids dividing by zero on empty graphs.
 */
function centrality(nodeId: string, degreeMap: Map<string, number>, maxDegree: number): number {
  if (maxDegree === 0) return 0;
  const degree = degreeMap.get(nodeId) ?? 0;
  if (degree === 0) return 0;
  return clamp(Math.sqrt(degree / maxDegree) * 100, 8, 100);
}

/** user_confirmation_score: feedback events where the user validated this node. */
function userConfirmation(
  nodeId: string,
  feedbackByNode: Map<string, FeedbackRow[]>,
  edgeConfirmationCountByNode: Map<string, number>,
): number {
  const events = feedbackByNode.get(nodeId) ?? [];
  let score = 0;
  for (const ev of events) {
    if (ev.event_type === "accept_node") score += 12;
    if (ev.event_type === "boost_node") score += 35;
    if (ev.event_type === "demote_node") score -= 25;
  }
  score += (edgeConfirmationCountByNode.get(nodeId) ?? 0) * 9;
  return clamp(score, 0, 100);
}

/** ai_prior_score: extraction confidence from proposed_nodes. Defaults to 50. */
function aiPrior(nodeId: string, confidenceMap: Map<string, number>): number {
  const conf = confidenceMap.get(nodeId);
  if (conf === undefined) return 50;
  return clamp(conf * 100, 0, 100);
}

/**
 * blocker_resolved_bonus: flat additive for each completed prerequisite_for/required_for source.
 * Capped at +10 points.
 */
export function blockerBonus(
  nodeId: string,
  edgesByNode: Map<string, EdgeRow[]>,
  completedIds: Set<string>,
): number {
  const edges = edgesByNode.get(nodeId) ?? [];
  const resolvedBlockers = edges.filter(
    (e) =>
      (e.edge_type === "prerequisite_for" || e.edge_type === "required_for") &&
      e.target_node_id === nodeId &&
      completedIds.has(e.source_node_id),
  ).length;
  return clamp(resolvedBlockers * 5, 0, 10);
}

/**
 * dependency_pressure: score multiplier for unresolved structural prerequisites.
 *
 * Only counts prerequisite_for and required_for edges — these are hard "must complete
 * before" relationships. blocks edges are excluded here (handled separately as a mild
 * flat deduction) to keep the two signals compositionally distinct.
 *
 * Multipliers are intentionally gentle: a node that can't be started yet should rank
 * lower but not collapse — it still needs to exist in the user's awareness.
 */
export function dependencyPressure(
  nodeId: string,
  edgesByNode: Map<string, EdgeRow[]>,
  activeIds: Set<string>,
): number {
  const edges = edgesByNode.get(nodeId) ?? [];
  let unmetPrereqs = 0;

  for (const e of edges) {
    if (e.status === "orphaned") continue;
    if (
      e.target_node_id === nodeId &&
      (e.edge_type === "prerequisite_for" || e.edge_type === "required_for") &&
      activeIds.has(e.source_node_id)
    ) {
      unmetPrereqs++;
    }
  }

  if (unmetPrereqs === 0) return 1.0;
  if (unmetPrereqs === 1) return 0.82;
  if (unmetPrereqs === 2) return 0.72;
  return 0.64; // 3+ unmet prerequisites
}

/**
 * blocks_penalty: small flat deduction for temporary obstacles (blocks edges).
 *
 * Kept separate from dependencyPressure — blocks is a soft signal, not a hard
 * structural dependency. The penalty is deliberately mild so blocked nodes stay
 * visible and comparable rather than falling off the ranking cliff.
 */
export function blocksPenalty(
  nodeId: string,
  edgesByNode: Map<string, EdgeRow[]>,
  activeIds: Set<string>,
): number {
  const edges = edgesByNode.get(nodeId) ?? [];
  let activeBlockers = 0;

  for (const e of edges) {
    if (e.status === "orphaned") continue;
    if (
      e.target_node_id === nodeId &&
      e.edge_type === "blocks" &&
      activeIds.has(e.source_node_id)
    ) {
      activeBlockers++;
    }
  }

  if (activeBlockers === 0) return 0;
  if (activeBlockers === 1) return -3;
  if (activeBlockers === 2) return -5;
  return -7; // 3+, capped
}

export function calibrateWorkspaceScore(params: {
  nodeId: string;
  rawScoreByNodeId: Map<string, number>;
  nonCompletedNodes: NodeRow[];
}): number {
  const { nodeId, rawScoreByNodeId, nonCompletedNodes } = params;
  const rawScore = rawScoreByNodeId.get(nodeId) ?? 0;

  if (nonCompletedNodes.length < 3) {
    return clamp(rawScore, 0, 100);
  }

  const sortedRawScores = nonCompletedNodes
    .map((node) => rawScoreByNodeId.get(node.id) ?? 0)
    .sort((a, b) => a - b);

  const median = quantile(sortedRawScores, 0.5);
  const q1 = quantile(sortedRawScores, 0.25);
  const q3 = quantile(sortedRawScores, 0.75);
  const iqr = Math.max(q3 - q1, 6);
  const normalized = sigmoid((rawScore - median) / (iqr / 1.15));
  const relativeScore =
    CALIBRATED_SCORE_FLOOR +
    normalized * (CALIBRATED_SCORE_CEILING - CALIBRATED_SCORE_FLOOR);

  return clamp(
    rawScore * (1 - WORKSPACE_CALIBRATION_BLEND) +
      relativeScore * WORKSPACE_CALIBRATION_BLEND,
    0,
    100,
  );
}

// ---------------------------------------------------------------------------
// Main computation function
// ---------------------------------------------------------------------------

export type NodeScoreUpdate = {
  id: string;
  current_importance_score: number;
  importance_index: number;
  importance: string;
};

export async function computeWorkspaceScores(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<{ recomputed: number; nodeUpdates: NodeScoreUpdate[] }> {
  const { workspaceId, userId, supabase } = params;

  // 1. Fetch all non-archived nodes
  const { data: nodes } = await supabase
    .from("nodes")
    .select("id, node_type, status, created_at, workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .neq("status", "archived");

  if (!nodes || nodes.length === 0) return { recomputed: 0, nodeUpdates: [] };

  // 2. Fetch active edges
  const { data: edges } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, edge_type, status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .neq("status", "orphaned");

  // 3. Fetch plan_task node_ids
  const { data: planTasks } = await supabase
    .from("plan_tasks")
    .select("node_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .not("node_id", "is", null);

  // 4. Fetch feedback events for this workspace
  const nodeIds = nodes.map((n) => n.id as string);
  const { data: feedbackEvents } = await supabase
    .from("feedback_events")
    .select("event_type, entity_id, entity_type")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  // 5. Fetch AI extraction confidences (for ai_prior) using accepted_node_id.
  const { data: proposals } = await supabase
    .from("proposed_nodes")
    .select("accepted_node_id, extraction_confidence")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("proposal_status", "accepted")
    .not("accepted_node_id", "is", null);

  // ---------------------------------------------------------------------------
  // Build lookup structures
  // ---------------------------------------------------------------------------

  const nodeRows = nodes as NodeRow[];
  const edgeRows = (edges ?? []) as EdgeRow[];
  const planNodeIds = new Set((planTasks ?? []).map((p) => p.node_id as string).filter(Boolean));
  const completedIds = new Set(nodeRows.filter((n) => n.status === "completed").map((n) => n.id));
  const goalIds = new Set(nodeRows.filter((n) => n.node_type === "goal").map((n) => n.id));
  // Active = not completed and not archived — these are nodes that still need doing.
  // Used to check whether a blocker is "real" (still outstanding) vs already resolved.
  const activeIds = new Set(
    nodeRows
      .filter((n) => n.status !== "completed" && n.status !== "archived")
      .map((n) => n.id),
  );

  // edgesByNode: nodeId → all edges touching that node
  const edgesByNode = new Map<string, EdgeRow[]>();
  for (const edge of edgeRows) {
    if (!edgesByNode.has(edge.source_node_id)) edgesByNode.set(edge.source_node_id, []);
    if (!edgesByNode.has(edge.target_node_id)) edgesByNode.set(edge.target_node_id, []);
    edgesByNode.get(edge.source_node_id)!.push(edge);
    edgesByNode.get(edge.target_node_id)!.push(edge);
  }

  // degreeMap: nodeId → total edge count (for centrality)
  const degreeMap = new Map<string, number>();
  for (const [nodeId, nodeEdges] of edgesByNode) {
    degreeMap.set(nodeId, nodeEdges.length);
  }
  const maxDegree = Math.max(0, ...Array.from(degreeMap.values()));

  // feedbackByNode: nodeId → node-scoped feedback events
  const feedbackByNode = new Map<string, FeedbackRow[]>();
  const edgeConfirmationCountByNode = new Map<string, number>();
  for (const ev of (feedbackEvents ?? []) as FeedbackRow[]) {
    if (ev.entity_type === "node" && nodeIds.includes(ev.entity_id)) {
      const id = ev.entity_id;
      if (!feedbackByNode.has(id)) feedbackByNode.set(id, []);
      feedbackByNode.get(id)!.push(ev);
    }
  }

  const { data: edgeFeedbackEvents } = await supabase
    .from("feedback_events")
    .select("entity_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("event_type", "confirm_edge")
    .eq("entity_type", "edge");

  if (edgeFeedbackEvents && edgeFeedbackEvents.length > 0) {
    const edgeIds = edgeFeedbackEvents.map((row) => row.entity_id as string);
    const { data: confirmedEdges } = await supabase
      .from("edges")
      .select("id, source_node_id, target_node_id")
      .in("id", edgeIds)
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId);

    for (const edge of confirmedEdges ?? []) {
      const sourceId = edge.source_node_id as string;
      const targetId = edge.target_node_id as string;
      edgeConfirmationCountByNode.set(
        sourceId,
        (edgeConfirmationCountByNode.get(sourceId) ?? 0) + 1,
      );
      edgeConfirmationCountByNode.set(
        targetId,
        (edgeConfirmationCountByNode.get(targetId) ?? 0) + 1,
      );
    }
  }

  // confidenceMap: accepted_node_id → extraction_confidence
  const confidenceMap = new Map<string, number>();
  for (const proposal of proposals ?? []) {
    const acceptedNodeId = proposal.accepted_node_id as string | null;
    const confidence = proposal.extraction_confidence as number | null;
    if (!acceptedNodeId || confidence == null) continue;
    const current = confidenceMap.get(acceptedNodeId) ?? 0;
    confidenceMap.set(acceptedNodeId, Math.max(current, confidence));
  }

  // ---------------------------------------------------------------------------
  // Compute per-node scores
  // ---------------------------------------------------------------------------

  const signalRows: Array<{
    ai_prior_score: number;
    blocker_resolved_bonus: number;
    goal_alignment_score: number;
    graph_centrality_score: number;
    node: NodeRow;
    planner_score: number;
    raw_score: number;
    recency_score: number;
    urgency_score: number;
    user_confirmation_score: number;
  }> = [];

  for (const node of nodeRows) {
    const u = urgency(node);
    const g = goalAlignment(node.id, goalIds, edgesByNode);
    const p = plannerScore(node.id, planNodeIds);
    const r = recency(node);
    const c = centrality(node.id, degreeMap, maxDegree);
    const uc = userConfirmation(node.id, feedbackByNode, edgeConfirmationCountByNode);
    const ap = aiPrior(node.id, confidenceMap);
    const bb = blockerBonus(node.id, edgesByNode, completedIds);
    const dp = dependencyPressure(node.id, edgesByNode, activeIds);
    const bp = blocksPenalty(node.id, edgesByNode, activeIds);

    const rawScore =
      (W.urgency * u +
      W.goal_alignment * g +
      W.planner * p +
      W.recency * r +
      W.centrality * c +
      W.user_confirmation * uc +
      W.ai_prior * ap +
      bb) * dp + bp;
    signalRows.push({
      node,
      urgency_score: u,
      goal_alignment_score: g,
      planner_score: p,
      recency_score: r,
      graph_centrality_score: c,
      user_confirmation_score: uc,
      ai_prior_score: ap,
      blocker_resolved_bonus: bb,
      raw_score: clamp(rawScore, 0, 100),
    });
  }

  const rawScoreByNodeId = new Map(
    signalRows.map((row) => [row.node.id, row.raw_score])
  );
  const nonCompletedNodes = nodeRows.filter((node) => node.status !== "completed");
  const scoreRows: unknown[] = [];
  const nodeUpdates: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }> = [];

  for (const row of signalRows) {
    let finalScore =
      row.node.status === "completed"
        ? 0
        : calibrateWorkspaceScore({
            nodeId: row.node.id,
            rawScoreByNodeId,
            nonCompletedNodes,
          });

    if (row.node.status === "paused") {
      finalScore *= PAUSED_FACTOR;
    }

    finalScore = clamp(finalScore, 0, 100);

    scoreRows.push({
      node_id: row.node.id,
      score_version: SCORE_VERSION,
      urgency_score: Math.round(row.urgency_score),
      goal_alignment_score: Math.round(row.goal_alignment_score),
      planner_score: Math.round(row.planner_score),
      recency_score: Math.round(row.recency_score),
      graph_centrality_score: Math.round(row.graph_centrality_score),
      user_confirmation_score: Math.round(row.user_confirmation_score),
      ai_prior_score: Math.round(row.ai_prior_score),
      blocker_resolved_bonus: row.blocker_resolved_bonus,
      final_score: Math.round(finalScore),
      computed_at: new Date().toISOString(),
    });

    const roundedScore = Math.round(finalScore);
    nodeUpdates.push({
      id: row.node.id,
      current_importance_score: roundedScore,
      importance_index: roundedScore,
      importance: getImportanceLabel(roundedScore),
    });
  }

  // ---------------------------------------------------------------------------
  // Upsert node_scores (one row per node per version)
  // ---------------------------------------------------------------------------
  if (scoreRows.length > 0) {
    await supabase
      .from("node_scores")
      .upsert(scoreRows, { onConflict: "node_id,score_version" });
  }

  // ---------------------------------------------------------------------------
  // Materialize final_score onto nodes.current_importance_score (batch)
  // ---------------------------------------------------------------------------
  await Promise.all(
    nodeUpdates.map((update) =>
      supabase
        .from("nodes")
        .update({
          current_importance_score: update.current_importance_score,
          importance_index: update.importance_index,
          importance: update.importance,
        })
        .eq("id", update.id)
        .eq("user_id", userId)
    )
  );

  return { recomputed: scoreRows.length, nodeUpdates };
}
