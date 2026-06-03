// Scoring service — Phase 7.
// Computes per-node importance scores from graph signals.
// All signals are 0–100. Formula is versioned — change SCORE_VERSION when weights shift.
// Call computeWorkspaceScores() after any event that affects node importance.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeWorkspaceEdgeDecay } from "@/lib/ai/lifecycle";
import { getImportanceLabel } from "@/lib/graph/importance";

export const SCORE_VERSION = "v7";

// ---------------------------------------------------------------------------
// Formula weights — must sum to 1.0 (remainder is blocker bonus headroom)
//
// v7: simplification pass.
//   - Dropped `recency` (5%) — redundant with the urgency recency burst.
//   - Dropped `planner` (3%) — needed weeks of feedback to be meaningful.
//   - Dropped `ai_prior` (0%) — was already weighted to zero.
//   The freed 8 points went to urgency + goal_alignment, the two signals
//   that move predictably with user intent in small graphs.
// ---------------------------------------------------------------------------
const W = {
  urgency: 0.26,
  goal_alignment: 0.26,
  ai_judgment: 0.25,
  centrality: 0.15,
  user_confirmation: 0.08,
  // blocker_resolved_bonus: flat additive, max +10 points
};

// Reduction factor applied to paused nodes' final score
const PAUSED_FACTOR = 0.32;
const CALIBRATED_SCORE_FLOOR = 12;
const CALIBRATED_SCORE_CEILING = 94;
// v7: dropped from 0.58 → 0.32. The high blend was compressing genuinely
// different nodes toward the median ("everything feels same-y"). Keep some
// calibration so raw scores aren't dominant in lopsided workspaces, but let
// the absolute signal breathe.
const WORKSPACE_CALIBRATION_BLEND = 0.32;
// PLANNER_FEEDBACK_WINDOW_DAYS is kept exported via buildPlannerLearningSignals
// for the unit tests; production no longer references it in the hot path.
const PLANNER_FEEDBACK_WINDOW_DAYS = 30;
// Mark the v6-only constant as exported to keep the diff smaller; the test
// file uses it through the helpers.
void PLANNER_FEEDBACK_WINDOW_DAYS;

// ---------------------------------------------------------------------------
// Internal types (raw DB rows, typed loosely to avoid schema coupling)
// ---------------------------------------------------------------------------

export interface NodeRow {
  id: string;
  node_type: string;
  status: string | null;
  created_at: string;
  workspace_id: string;
  manual_weight: number | null;
}

export interface EdgeRow {
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  status: string | null;
}

export interface FeedbackRow {
  event_type: string;
  entity_id: string;
  entity_type: string;
  created_at?: string;
  metadata?: Record<string, unknown> | null;
}

export interface PlannerLearningSignals {
  acceptedPlanCountByNode: Map<string, number>;
  planTaskNodeIds: Set<string>;
  rejectedPlanCountByNode: Map<string, number>;
  removedPlanCountByNode: Map<string, number>;
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
    habit: 48,
  };
  const base = typeBase[node.node_type] ?? 40;
  const daysSince = (Date.now() - new Date(node.created_at).getTime()) / 86_400_000;
  const recencyBurst = clamp(((21 - daysSince) / 21) * 14, 0, 14);
  return clamp(base + recencyBurst, 0, 100);
}

/**
 * goal_alignment_score: log-scaled by count of goal-connected edges.
 *
 * v7: replaced the four hard-bucketed steps (5 / 56 / 74 / 88) with a smooth
 * curve. The old version made adding a single goal edge flip a node from
 * "irrelevant" to "high priority", which felt unstable. The new curve:
 *   0 edges  → 12 (low floor — not abandoned but not strongly aligned)
 *   1 edge   → 58
 *   2 edges  → 68
 *   3 edges  → 76
 *   4+ edges → 82 (cap — diminishing returns)
 */
export function goalAlignment(nodeId: string, goalIds: Set<string>, edgesByNode: Map<string, EdgeRow[]>): number {
  if (goalIds.has(nodeId)) return 90; // The node itself is a goal
  const edges = edgesByNode.get(nodeId) ?? [];
  const goalConnections = edges.filter(
    (e) => goalIds.has(e.source_node_id === nodeId ? e.target_node_id : e.source_node_id),
  ).length;
  if (goalConnections === 0) return 12;
  return Math.min(82, 40 + 18 * Math.log2(1 + goalConnections));
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function incrementNodeCounts(map: Map<string, number>, nodeIds: string[]) {
  for (const nodeId of nodeIds) {
    map.set(nodeId, (map.get(nodeId) ?? 0) + 1);
  }
}

export function buildPlannerLearningSignals(params: {
  feedbackEvents: FeedbackRow[];
  planTaskNodeIds: Set<string>;
  recentAfter?: string;
}): PlannerLearningSignals {
  const acceptedPlanCountByNode = new Map<string, number>();
  const removedPlanCountByNode = new Map<string, number>();
  const rejectedPlanCountByNode = new Map<string, number>();

  for (const event of params.feedbackEvents) {
    if (event.entity_type !== "plan_session") {
      continue;
    }

    if (params.recentAfter && event.created_at && event.created_at < params.recentAfter) {
      continue;
    }

    const metadata = event.metadata ?? {};

    if (event.event_type === "accept_node") {
      incrementNodeCounts(acceptedPlanCountByNode, parseStringArray(metadata.kept_node_ids));
      incrementNodeCounts(removedPlanCountByNode, parseStringArray(metadata.removed_node_ids));
    } else if (event.event_type === "reject_node") {
      incrementNodeCounts(rejectedPlanCountByNode, parseStringArray(metadata.rejected_node_ids));
    }
  }

  return {
    acceptedPlanCountByNode,
    planTaskNodeIds: params.planTaskNodeIds,
    rejectedPlanCountByNode,
    removedPlanCountByNode,
  };
}

/** planner_score: current plan presence plus recent accepted/cut planner feedback. */
export function plannerScore(nodeId: string, signals: PlannerLearningSignals): number {
  let score = 0;

  if (signals.planTaskNodeIds.has(nodeId)) {
    score += 56;
  }

  score += Math.min(28, (signals.acceptedPlanCountByNode.get(nodeId) ?? 0) * 14);
  score -= Math.min(18, (signals.removedPlanCountByNode.get(nodeId) ?? 0) * 9);
  score -= Math.min(12, (signals.rejectedPlanCountByNode.get(nodeId) ?? 0) * 6);

  return clamp(score, 0, 100);
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
  importance_reason: string | null;
  importance_top_signals: string[];
};

export async function computeWorkspaceScores(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<{
  edgeDecaySummary: { active: number; decayed: number; recomputed: number; stale: number };
  recomputed: number;
  nodeUpdates: NodeScoreUpdate[];
}> {
  const { workspaceId, userId, supabase } = params;

  // 1. Fetch all non-archived nodes
  const { data: nodes } = await supabase
    .from("nodes")
    .select("id, node_type, status, created_at, workspace_id, manual_weight")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .neq("status", "archived");

  if (!nodes || nodes.length === 0) {
    return {
      edgeDecaySummary: { active: 0, decayed: 0, recomputed: 0, stale: 0 },
      recomputed: 0,
      nodeUpdates: [],
    };
  }

  // 2. Fetch active edges
  const { data: edges } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, edge_type, status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .neq("status", "orphaned");

  // 3. Fetch feedback events for this workspace (drives user_confirmation signal)
  const nodeIds = nodes.map((n) => n.id as string);
  const { data: feedbackEvents } = await supabase
    .from("feedback_events")
    .select("event_type, entity_id, entity_type, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  // 4. Fetch latest AI judgment per node (ai_judgment_score signal + reason).
  // The reason gets surfaced to the user as the "why is this ranked here?"
  // text, so we keep it alongside the numeric score.
  const { data: judgments } = await supabase
    .from("ai_node_judgments")
    .select("node_id, score, reason, computed_at")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .order("computed_at", { ascending: false });

  const aiJudgmentByNode = new Map<string, number>();
  const aiJudgmentReasonByNode = new Map<string, string>();
  for (const row of judgments ?? []) {
    const nodeId = row.node_id as string;
    if (!aiJudgmentByNode.has(nodeId)) {
      aiJudgmentByNode.set(nodeId, Number(row.score));
      const reason = row.reason as string | null;
      if (reason) aiJudgmentReasonByNode.set(nodeId, reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Build lookup structures
  // ---------------------------------------------------------------------------

  const nodeRows = nodes as NodeRow[];
  const edgeRows = (edges ?? []) as EdgeRow[];
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

  // ---------------------------------------------------------------------------
  // Compute per-node scores
  // ---------------------------------------------------------------------------

  const signalRows: Array<{
    ai_judgment_score: number;
    blocker_resolved_bonus: number;
    goal_alignment_score: number;
    graph_centrality_score: number;
    node: NodeRow;
    raw_score: number;
    top_signals: string[];
    urgency_score: number;
    user_confirmation_score: number;
  }> = [];

  for (const node of nodeRows) {
    const u = urgency(node);
    const g = goalAlignment(node.id, goalIds, edgesByNode);
    const c = centrality(node.id, degreeMap, maxDegree);
    const uc = userConfirmation(node.id, feedbackByNode, edgeConfirmationCountByNode);
    const aj = aiJudgmentByNode.get(node.id);
    // When no AI judgment has been computed yet, redistribute its weight to
    // urgency + goal_alignment so nodes without judgments aren't suppressed.
    const hasAj = typeof aj === "number";
    const ajScore = hasAj ? aj : 0;
    const ajBoostFactor = hasAj ? 1 : 0;
    const bb = blockerBonus(node.id, edgesByNode, completedIds);
    const dp = dependencyPressure(node.id, edgesByNode, activeIds);
    const bp = blocksPenalty(node.id, edgesByNode, activeIds);

    const urgencyW = hasAj ? W.urgency : W.urgency + W.ai_judgment * 0.4;
    const goalAlignW = hasAj ? W.goal_alignment : W.goal_alignment + W.ai_judgment * 0.6;

    const rawScore =
      (urgencyW * u +
        goalAlignW * g +
        W.ai_judgment * ajScore * ajBoostFactor +
        W.centrality * c +
        W.user_confirmation * uc +
        bb) *
        dp +
      bp;

    // Compute the top contributors for the "why is this ranked here?" UI.
    // We rank by *weighted* contribution so the user sees what's actually
    // moving the score, not just which raw signal is highest.
    const contributions: Array<{ signal: string; value: number }> = [
      { signal: "urgency", value: urgencyW * u },
      { signal: "goal_alignment", value: goalAlignW * g },
      { signal: "ai_judgment", value: W.ai_judgment * ajScore * ajBoostFactor },
      { signal: "centrality", value: W.centrality * c },
      { signal: "user_confirmation", value: W.user_confirmation * uc },
      { signal: "blocker_resolved_bonus", value: bb },
    ].sort((a, b) => b.value - a.value);
    const topSignals = contributions
      .filter((c) => c.value > 1)
      .slice(0, 3)
      .map((c) => c.signal);

    signalRows.push({
      node,
      urgency_score: u,
      goal_alignment_score: g,
      graph_centrality_score: c,
      user_confirmation_score: uc,
      ai_judgment_score: ajScore,
      blocker_resolved_bonus: bb,
      raw_score: clamp(rawScore, 0, 100),
      top_signals: topSignals,
    });
  }

  const rawScoreByNodeId = new Map(
    signalRows.map((row) => [row.node.id, row.raw_score])
  );
  const nonCompletedNodes = nodeRows.filter((node) => node.status !== "completed");
  const scoreRows: unknown[] = [];
  const nodeUpdates: NodeScoreUpdate[] = [];

  for (const row of signalRows) {
    // Manual override: user set a specific weight. Skip formula entirely.
    // (Still runs for completed nodes → 0, because completed never counts.)
    const hasManualOverride =
      typeof row.node.manual_weight === "number" &&
      Number.isFinite(row.node.manual_weight);

    let finalScore: number;
    if (row.node.status === "completed") {
      finalScore = 0;
    } else if (hasManualOverride) {
      finalScore = Math.max(0, Math.min(100, row.node.manual_weight as number));
    } else {
      finalScore = calibrateWorkspaceScore({
        nodeId: row.node.id,
        rawScoreByNodeId,
        nonCompletedNodes,
      });
    }

    if (row.node.status === "paused" && !hasManualOverride) {
      finalScore *= PAUSED_FACTOR;
    }

    finalScore = clamp(finalScore, 0, 100);

    // node_scores keeps a per-signal breakdown for diagnostics. Dropped
    // signals (planner, recency, ai_prior) are sent as 0 so the column types
    // stay compatible with prior v6 rows without a migration.
    scoreRows.push({
      node_id: row.node.id,
      score_version: SCORE_VERSION,
      urgency_score: Math.round(row.urgency_score),
      goal_alignment_score: Math.round(row.goal_alignment_score),
      planner_score: 0,
      recency_score: 0,
      graph_centrality_score: Math.round(row.graph_centrality_score),
      user_confirmation_score: Math.round(row.user_confirmation_score),
      ai_prior_score: 0,
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
      importance_reason: aiJudgmentReasonByNode.get(row.node.id) ?? null,
      importance_top_signals: row.top_signals,
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
          importance_reason: update.importance_reason,
          importance_top_signals: update.importance_top_signals,
        })
        .eq("id", update.id)
        .eq("user_id", userId)
      )
  );

  const edgeDecaySummary = await recomputeWorkspaceEdgeDecay({
    workspaceId,
    userId,
    supabase,
  });

  return { edgeDecaySummary, recomputed: scoreRows.length, nodeUpdates };
}
