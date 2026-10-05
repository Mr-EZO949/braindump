// Scoring service — Phase 7, ranking v2 (docs/ranking.md).
// Computes per-node importance (0–100) — what drives node size on the graph.
// All signals are 0–100. Formula is versioned — change SCORE_VERSION when weights shift.
// Call computeWorkspaceScores() after any event that affects node importance
// (and nightly: deadline pressure moves with the calendar).

import type { SupabaseClient } from "@supabase/supabase-js";
import { RANKING } from "@/lib/ai/config";
import { normalizeEdges } from "@/lib/graph/edge-types";
import { recomputeWorkspaceEdgeDecay } from "@/lib/ai/lifecycle";
import { getImportanceLabel } from "@/lib/graph/importance";
import {
  createRankingContext,
  holdFactor,
  rankingReason,
  type RankNode,
  type StakesLevel,
} from "@/lib/graph/priority-signals";

export const SCORE_VERSION = "v9";

// ---------------------------------------------------------------------------
// Formula weights — sum to 1.0; steering, blockers and holds apply on top.
//
// v9 (ranking v2): the v8 `urgency` signal (type base + recency + a tiny
// +3.6 due-date term) is split into what it was mixing:
//   - semantic: how much the thing matters, independent of timing — the AI
//     judgment blended with a type prior (the judgment is told to ignore
//     deadlines, so time is never counted twice);
//   - pressure: lead-time-aware deadline pressure, inherited from dated
//     parents (priority-signals.ts);
//   - freshness: the old creation-recency burst.
// Boost/demote moved out of user_confirmation into decaying steering.
// ---------------------------------------------------------------------------
const W = {
  semantic: 0.3,
  pressure: 0.28,
  goal_alignment: 0.16,
  centrality: 0.12,
  freshness: 0.06,
  user_confirmation: 0.08,
};

// Raw points per unit of steering (a fresh "focus on X" = +1 unit).
const STEER_POINTS = 14;

// Semantic weight = AI_JUDGMENT_BLEND × judgment + rest × type prior. The prior
// keeps goals above tasks at equal judgment (the v7 invariant).
const AI_JUDGMENT_BLEND = 0.7;
const TYPE_PRIOR: Record<string, number> = {
  goal: 72,
  project: 62,
  big_task: 58,
  habit: 55,
  class: 55,
  task: 52,
  area: 45,
  idea: 30,
  note: 28,
};
const TYPE_PRIOR_FALLBACK = 45;

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
  target_date?: string | null;
  title?: string | null;
  stakes?: number | null;
  waiting_for?: string | null;
  resume_on?: string | null;
  reading_order?: number | null;
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

export function typePrior(nodeType: string): number {
  return TYPE_PRIOR[nodeType] ?? TYPE_PRIOR_FALLBACK;
}

/**
 * semantic_score: how much the node matters, independent of timing. The AI
 * judgment when there is one (blended with the type prior), shifted by stakes.
 */
export function semanticScore(params: {
  nodeType: string;
  aiJudgment: number | null;
  stakes: StakesLevel;
}): number {
  const prior = typePrior(params.nodeType);
  const base =
    typeof params.aiJudgment === "number"
      ? AI_JUDGMENT_BLEND * params.aiJudgment + (1 - AI_JUDGMENT_BLEND) * prior
      : prior;
  const shift =
    params.stakes === "high"
      ? RANKING.STAKES_SEMANTIC_SHIFT
      : params.stakes === "low"
        ? -RANKING.STAKES_SEMANTIC_SHIFT
        : 0;
  return clamp(base + shift, 0, 100);
}

/** freshness_score: 100 when just created, fading to 0 over three weeks. */
export function freshness(createdAt: string, nowMs: number = Date.now()): number {
  const daysSince = (nowMs - new Date(createdAt).getTime()) / 86_400_000;
  return clamp(((21 - daysSince) / 21) * 100, 0, 100);
}

export interface ImportanceSignals {
  semantic: number;
  pressure: number;
  goalAlignment: number;
  centrality: number;
  freshness: number;
  userConfirmation: number;
  dependencyPressure: number;
  blocksPenalty: number;
  blockerBonus: number;
  steer: number;
}

/** The v9 raw score (before workspace calibration and hold factors). Pure. */
export function importanceRaw(sig: ImportanceSignals): number {
  const weighted =
    W.semantic * sig.semantic +
    W.pressure * sig.pressure +
    W.goal_alignment * sig.goalAlignment +
    W.centrality * sig.centrality +
    W.freshness * sig.freshness +
    W.user_confirmation * sig.userConfirmation;
  return clamp(
    weighted * sig.dependencyPressure + sig.blocksPenalty + sig.blockerBonus + STEER_POINTS * sig.steer,
    0,
    100,
  );
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

/**
 * user_confirmation_score: the user validated this node (accepted it, confirmed
 * its edges). Boost/demote are steering since v9 — they decay instead.
 */
function userConfirmation(
  nodeId: string,
  feedbackByNode: Map<string, FeedbackRow[]>,
  edgeConfirmationCountByNode: Map<string, number>,
): number {
  const events = feedbackByNode.get(nodeId) ?? [];
  let score = 0;
  for (const ev of events) {
    if (ev.event_type === "accept_node") score += 12;
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
 * Since 2026-10-05 edges are read as the four link kinds before scoring, so a
 * stored "blocks" row counts as required_for (dependencyPressure) and this
 * never fires; kept for its tests until a cleanup migration retires the type.
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

type StoredScoreRow = {
  current_importance_score?: number | null;
  importance_index?: number | null;
  importance?: string | null;
  importance_reason?: string | null;
  importance_top_signals?: string[] | null;
};

// True when a node's stored score columns differ from the freshly computed
// ones (or the row wasn't loaded) — only those rows need a write.
export function scoreFieldsChanged(
  stored: StoredScoreRow | undefined,
  update: NodeScoreUpdate,
): boolean {
  if (!stored) return true;
  return (
    stored.current_importance_score !== update.current_importance_score ||
    stored.importance_index !== update.importance_index ||
    stored.importance !== update.importance ||
    (stored.importance_reason ?? null) !== update.importance_reason ||
    JSON.stringify(stored.importance_top_signals ?? null) !==
      JSON.stringify(update.importance_top_signals)
  );
}

export async function computeWorkspaceScores(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  /** The user's local date (YYYY-MM-DD) for deadline math; UTC date when absent. */
  today?: string;
}): Promise<{
  edgeDecaySummary: { active: number; decayed: number; recomputed: number; stale: number };
  recomputed: number;
  nodeUpdates: NodeScoreUpdate[];
}> {
  const { workspaceId, userId, supabase } = params;
  const today =
    typeof params.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.today)
      ? params.today
      : new Date().toISOString().slice(0, 10);

  // Edge decay reads only edges, node statuses and edge feedback — nothing
  // this function writes — so it runs alongside the score computation.
  const edgeDecay = recomputeWorkspaceEdgeDecay({ workspaceId, userId, supabase });
  // Awaited below; this only keeps an early failure from surfacing as an
  // unhandled rejection while the score reads are in flight.
  edgeDecay.catch(() => {});

  // Every read below is independent, so they go out as ONE parallel round
  // trip — this runs on every "mark done", where each sequential trip is
  // user-visible latency.
  const [
    { data: nodes },
    { data: workspaceEdges },
    { data: feedbackEvents },
    { data: judgments },
    { data: edgeFeedbackEvents },
  ] = await Promise.all([
    // 1. All non-archived nodes, with their stored scores so unchanged rows
    //    can skip the write below.
    supabase
      .from("nodes")
      .select(
        "id, title, node_type, status, created_at, workspace_id, manual_weight, target_date, stakes, waiting_for, resume_on, reading_order, current_importance_score, importance_index, importance, importance_reason, importance_top_signals",
      )
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .neq("status", "archived"),
    // 2. All edges (orphaned ones only matter for the edge-confirmation count).
    supabase
      .from("edges")
      .select("id, source_node_id, target_node_id, edge_type, status")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId),
    // 3. Node feedback: accept_node → user_confirmation; boost/demote →
    //    decaying steering (priority-signals.ts).
    supabase
      .from("feedback_events")
      .select("event_type, entity_id, entity_type, metadata, created_at")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("entity_type", "node")
      .in("event_type", ["accept_node", "boost_node", "demote_node"]),
    // 4. Latest AI judgment per node (ai_judgment_score signal + reason).
    // The reason gets surfaced to the user as the "why is this ranked here?"
    // text, so we keep it alongside the numeric score.
    supabase
      .from("ai_node_judgments")
      .select("node_id, score, reason, computed_at")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .order("computed_at", { ascending: false }),
    // 5. Confirmed edges (user_confirmation signal on both endpoints).
    supabase
      .from("feedback_events")
      .select("entity_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("event_type", "confirm_edge")
      .eq("entity_type", "edge"),
  ]);

  if (!nodes || nodes.length === 0) {
    // Nothing to score. The edge pass started above still finishes (with
    // every node archived it only re-derives edge weights — harmless).
    await edgeDecay.catch(() => null);
    return {
      edgeDecaySummary: { active: 0, decayed: 0, recomputed: 0, stale: 0 },
      recomputed: 0,
      nodeUpdates: [],
    };
  }

  // Same rows as `.neq("status", "orphaned")` (SQL: NULL status excluded too).
  const edges = (workspaceEdges ?? []).filter(
    (edge) => edge.status !== null && edge.status !== undefined && edge.status !== "orphaned",
  );
  const nodeIds = new Set(nodes.map((n) => n.id as string));

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
  // Read every edge as one of the four link kinds (legacy types renamed).
  const edgeRows = normalizeEdges((edges ?? []) as EdgeRow[]);
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
    if (ev.entity_type === "node" && nodeIds.has(ev.entity_id)) {
      const id = ev.entity_id;
      if (!feedbackByNode.has(id)) feedbackByNode.set(id, []);
      feedbackByNode.get(id)!.push(ev);
    }
  }

  if (edgeFeedbackEvents && edgeFeedbackEvents.length > 0) {
    const edgeIds = new Set(edgeFeedbackEvents.map((row) => row.entity_id as string));
    const confirmedEdges = (workspaceEdges ?? []).filter((edge) => edgeIds.has(edge.id as string));

    for (const edge of confirmedEdges) {
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

  // Ranking v2 context: deadlines (own + inherited), stakes, decaying
  // steering and holds — one pass of lookups shared by every node below.
  const nowMs = Date.now();
  const rankCtx = createRankingContext({
    nodes: nodeRows.map((n) => n as RankNode),
    // A rejected parent link doesn't define hierarchy.
    edges: edgeRows.filter((e) => e.status !== "user_rejected"),
    today,
    steerEvents: ((feedbackEvents ?? []) as FeedbackRow[]).filter((ev) => ev.entity_type === "node"),
    nowMs,
  });

  const signalRows: Array<{
    node: NodeRow;
    raw_score: number;
    top_signals: string[];
    semantic: number;
    pressure: number;
    goal_alignment: number;
    centrality: number;
    freshness: number;
    user_confirmation: number;
    blocker_resolved_bonus: number;
    signals: Record<string, unknown>;
  }> = [];

  for (const node of nodeRows) {
    const aj = aiJudgmentByNode.get(node.id);
    const hasAj = typeof aj === "number";
    const stakes = rankCtx.stakes(node.id);
    const semantic = semanticScore({ nodeType: node.node_type, aiJudgment: hasAj ? aj : null, stakes });
    const deadline = rankCtx.deadline(node.id);
    // The deadline's owner gets full pressure; its steps a little less so the
    // exam stays bigger than any one past paper under it.
    const pressure = deadline
      ? deadline.pressure * (deadline.inherited ? RANKING.INHERITED_PRESSURE_FACTOR : 1)
      : 0;
    const g = goalAlignment(node.id, goalIds, edgesByNode);
    const c = centrality(node.id, degreeMap, maxDegree);
    const f = freshness(node.created_at, nowMs);
    const uc = userConfirmation(node.id, feedbackByNode, edgeConfirmationCountByNode);
    const bb = blockerBonus(node.id, edgesByNode, completedIds);
    const dp = dependencyPressure(node.id, edgesByNode, activeIds);
    const bp = blocksPenalty(node.id, edgesByNode, activeIds);
    const steer = rankCtx.steer(node.id);

    const rawScore = importanceRaw({
      semantic,
      pressure,
      goalAlignment: g,
      centrality: c,
      freshness: f,
      userConfirmation: uc,
      dependencyPressure: dp,
      blocksPenalty: bp,
      blockerBonus: bb,
      steer,
    });

    // Top contributors for the "why is this ranked here?" chips, ranked by
    // *weighted* contribution so the user sees what actually moves the score.
    const contributions: Array<{ signal: string; value: number }> = [
      { signal: hasAj ? "ai_judgment" : "node_type", value: W.semantic * semantic },
      { signal: "deadline", value: W.pressure * pressure },
      { signal: "goal_alignment", value: W.goal_alignment * g },
      { signal: "centrality", value: W.centrality * c },
      { signal: "freshness", value: W.freshness * f },
      { signal: "user_confirmation", value: W.user_confirmation * uc },
      { signal: "blocker_resolved_bonus", value: bb },
      { signal: steer >= 0 ? "steering" : "deprioritized", value: STEER_POINTS * Math.abs(steer) },
    ].sort((a, b) => b.value - a.value);
    const hold = rankCtx.hold(node.id);
    const topSignals = [
      ...(hold !== "none" ? ["on_hold"] : []),
      ...(stakes === "high" ? ["stakes"] : []),
      ...contributions.filter((entry) => entry.value > 1).map((entry) => entry.signal),
    ].slice(0, 3);

    signalRows.push({
      node,
      raw_score: rawScore,
      top_signals: topSignals,
      semantic,
      pressure,
      goal_alignment: g,
      centrality: c,
      freshness: f,
      user_confirmation: uc,
      blocker_resolved_bonus: bb,
      signals: {
        semantic: Math.round(semantic),
        ai_judgment: hasAj ? aj : null,
        pressure: Math.round(pressure),
        deadline: deadline
          ? {
              date: deadline.date,
              owner_id: deadline.ownerId,
              days_left: deadline.daysLeft,
              sessions_left: deadline.sessionsLeft,
            }
          : null,
        stakes,
        steer: Math.round(steer * 100) / 100,
        hold,
      },
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

    // Holds shrink the node (and everything under a held parent) so "waiting
    // for the result" reads on the graph at a glance.
    if (!hasManualOverride) {
      finalScore *= holdFactor(rankCtx.hold(row.node.id));
    }

    finalScore = clamp(finalScore, 0, 100);

    // node_scores keeps a per-signal breakdown for diagnostics. v9 signals map
    // onto the legacy columns where they fit (urgency ← pressure, ai_prior ←
    // semantic, recency ← freshness); the full breakdown is in `signals`.
    scoreRows.push({
      node_id: row.node.id,
      score_version: SCORE_VERSION,
      urgency_score: Math.round(row.pressure),
      goal_alignment_score: Math.round(row.goal_alignment),
      planner_score: 0,
      recency_score: Math.round(row.freshness),
      graph_centrality_score: Math.round(row.centrality),
      user_confirmation_score: Math.round(row.user_confirmation),
      ai_prior_score: Math.round(row.semantic),
      blocker_resolved_bonus: row.blocker_resolved_bonus,
      final_score: Math.round(finalScore),
      signals: row.signals,
      computed_at: new Date().toISOString(),
    });

    const roundedScore = Math.round(finalScore);
    nodeUpdates.push({
      id: row.node.id,
      current_importance_score: roundedScore,
      importance_index: roundedScore,
      importance: getImportanceLabel(roundedScore),
      importance_reason:
        row.node.status === "completed"
          ? null
          : (rankingReason(rankCtx, row.node.id) ?? aiJudgmentReasonByNode.get(row.node.id) ?? null),
      importance_top_signals: row.top_signals,
    });
  }

  // ---------------------------------------------------------------------------
  // Persist. The three writes are independent, so they run in parallel:
  //   - node_scores upsert (one row per node per version)
  //   - final_score materialized onto nodes — only rows whose stored values
  //     differ (one completion moves a handful of scores, not the whole
  //     workspace; writing every node was one HTTP request per node)
  //   - edge decay (started at the top; reads only edges/statuses/feedback)
  // ---------------------------------------------------------------------------
  const storedById = new Map(nodeRows.map((node) => [node.id, node as StoredScoreRow]));
  const changedUpdates = nodeUpdates.filter((update) =>
    scoreFieldsChanged(storedById.get(update.id), update),
  );

  // Rows getting identical values share one UPDATE … WHERE id IN (…) — a
  // finished subtree all drops to 0 at once.
  const updatesByValues = new Map<string, { fields: Record<string, unknown>; ids: string[] }>();
  for (const update of changedUpdates) {
    const fields = {
      current_importance_score: update.current_importance_score,
      importance_index: update.importance_index,
      importance: update.importance,
      importance_reason: update.importance_reason,
      importance_top_signals: update.importance_top_signals,
    };
    const key = JSON.stringify(fields);
    const group = updatesByValues.get(key) ?? { fields, ids: [] as string[] };
    group.ids.push(update.id);
    updatesByValues.set(key, group);
  }

  const [, , edgeDecaySummary] = await Promise.all([
    scoreRows.length > 0
      ? supabase.from("node_scores").upsert(scoreRows, { onConflict: "node_id,score_version" })
      : null,
    Promise.all(
      [...updatesByValues.values()].map(({ fields, ids }) =>
        supabase.from("nodes").update(fields).in("id", ids).eq("user_id", userId),
      ),
    ),
    edgeDecay,
  ]);

  return { edgeDecaySummary, recomputed: scoreRows.length, nodeUpdates };
}
