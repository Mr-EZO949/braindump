// Edge lifecycle: decay weights + prerequisite cascade.
//
// An edge connects two nodes. As nodes complete, their edges should fade —
// the user doesn't need to see finished business at full strength forever.
// But "fade" depends on *who* finished: if both endpoints are done the edge
// is closed history; if only one is done the relationship is still half-live.
//
// This file owns the rules for that fade plus the cascade that fires when a
// prerequisite completes (downstream nodes may become "newly ready").

import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_DECAY } from "@/lib/ai/config";
import type { EdgeStatus, NodeStatus } from "@/types/graph";

// ─── Public types ────────────────────────────────────────────────────────

export interface LifecycleCascadeResult {
  newlyAvailable: Array<{ id: string; title: string }>;
  cascadeCount: number;
}

export interface EdgeDecayState {
  decayFactor: number;
  derivedStatus: EdgeStatus;
  stale: boolean;
}

// ─── Decay configuration ─────────────────────────────────────────────────
//
// All tunables live here. Don't sprinkle multipliers across the file again.

/**
 * A decay profile describes how an edge fades over time. Three axes:
 *   - `startDays`: how long the edge stays at full strength after completion
 *   - `fullDays`: how long until the edge reaches its floor
 *   - `floor`: the minimum weight the edge will hold (never zero unless
 *      the edge is orphaned/rejected — that's handled separately)
 *
 * Between `startDays` and `fullDays` the decay is linear. Linear (not
 * exponential) so the user has a clear mental model: "halfway through the
 * window, the edge is at the midpoint between 1 and floor."
 */
type DecayProfile = {
  startDays: number;
  fullDays: number;
  floor: number;
};

/**
 * Two profiles, selected by *how many* endpoints are completed:
 *
 *   FULLY_RESOLVED — both endpoints done. The relationship is closed
 *   history. Fade aggressively so the user isn't stuck staring at past
 *   work indefinitely.
 *
 *   ONE_SIDED — exactly one endpoint done. The other is still active and
 *   may want to reference the completed node for context (e.g. "I shipped
 *   the auth refactor that this task depended on"). Decay slowly and stop
 *   at a meaningful floor so the connection remains discoverable.
 *
 * The numbers come from product intent, not historical tuning:
 *   - ONE_SIDED.fullDays (40) ≈ "still useful a month later"
 *   - FULLY_RESOLVED.fullDays (18) ≈ "fades within ~2 sprints"
 *   - ONE_SIDED.floor (0.20) = 4× the resolved floor, so one-sided edges
 *     remain visibly more prominent at their respective floors
 */
const DECAY_PROFILES = {
  FULLY_RESOLVED: {
    startDays: AI_DECAY.DECAY_START_DAYS,
    fullDays: 18,
    floor: 0.05,
  },
  ONE_SIDED: {
    startDays: AI_DECAY.DECAY_START_DAYS,
    fullDays: 40,
    floor: 0.2,
  },
} as const satisfies Record<string, DecayProfile>;

/**
 * Per-edge user feedback adjustments. Confirmations boost the edge weight
 * (positive signal: "yes this connection matters"). Rejections drag it
 * down (negative signal: "this edge is wrong").
 *
 * Bounds matter:
 *   - Confirmation boost is capped so a few extra clicks don't drown out
 *     all other signal. After ~5 confirmations the boost saturates.
 *   - Rejection drives to zero linearly — 5 rejections kill the edge weight
 *     entirely, which is the right behavior: if the user has rejected this
 *     edge multiple times, it should not contribute.
 */
const FEEDBACK_ADJUSTMENT = {
  CONFIRMATION_PER_CLICK: 0.12,
  CONFIRMATION_MAX_BOOST: 0.6,
  REJECTION_PER_CLICK: 0.2,
} as const;

// Static sanity check — caught at module load if someone fat-fingers a profile.
for (const [name, profile] of Object.entries(DECAY_PROFILES)) {
  if (profile.fullDays <= profile.startDays) {
    throw new Error(
      `[lifecycle] Decay profile "${name}" has fullDays (${profile.fullDays}) <= startDays (${profile.startDays})`,
    );
  }
  if (profile.floor < 0 || profile.floor >= 1) {
    throw new Error(
      `[lifecycle] Decay profile "${name}" floor (${profile.floor}) must be in [0, 1)`,
    );
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals = 4) {
  return Number(value.toFixed(decimals));
}

/**
 * Pick the decay profile for an edge based on which endpoints completed.
 * Returns null when neither endpoint is completed → the edge is at full
 * strength forever (no decay applies).
 */
function pickDecayProfile(
  sourceCompletedAt: string | null,
  targetCompletedAt: string | null,
): DecayProfile | null {
  const sourceDone = sourceCompletedAt !== null;
  const targetDone = targetCompletedAt !== null;
  if (!sourceDone && !targetDone) return null;
  if (sourceDone && targetDone) return DECAY_PROFILES.FULLY_RESOLVED;
  return DECAY_PROFILES.ONE_SIDED;
}

/** Days elapsed since the most recent completion timestamp. */
function daysSinceMostRecent(
  now: Date,
  sourceCompletedAt: string | null,
  targetCompletedAt: string | null,
): number {
  const stamps = [sourceCompletedAt, targetCompletedAt]
    .filter((s): s is string => s !== null)
    .map((s) => new Date(s).getTime());
  if (stamps.length === 0) return 0;
  const mostRecent = Math.max(...stamps);
  return (now.getTime() - mostRecent) / (1000 * 60 * 60 * 24);
}

/** Linear ramp from 1.0 (at `startDays`) to `floor` (at `fullDays`). */
function decayCurve(daysSince: number, profile: DecayProfile): number {
  if (daysSince < profile.startDays) return 1;
  if (daysSince >= profile.fullDays) return profile.floor;
  const progress =
    (daysSince - profile.startDays) / (profile.fullDays - profile.startDays);
  return 1 - progress * (1 - profile.floor);
}

/** Edge weight multiplier from accumulated user confirmations. Capped. */
function confirmationBoost(count: number): number {
  if (count <= 0) return 1;
  const raw = count * FEEDBACK_ADJUSTMENT.CONFIRMATION_PER_CLICK;
  return 1 + Math.min(raw, FEEDBACK_ADJUSTMENT.CONFIRMATION_MAX_BOOST);
}

/** Edge weight multiplier from accumulated user rejections. Floors at 0. */
function rejectionPenalty(count: number): number {
  if (count <= 0) return 1;
  return Math.max(0, 1 - count * FEEDBACK_ADJUSTMENT.REJECTION_PER_CLICK);
}

// ─── Decay state derivation ──────────────────────────────────────────────

/**
 * Pure function: given completion timestamps for both endpoints + current
 * edge status, return the edge's current decay state. No I/O; safe to test
 * in isolation and to call from the UI for explanations.
 */
export function deriveEdgeDecayState(params: {
  now?: Date;
  sourceCompletedAt?: string | null;
  targetCompletedAt?: string | null;
  edgeStatus?: EdgeStatus | null;
}): EdgeDecayState {
  const {
    now = new Date(),
    sourceCompletedAt = null,
    targetCompletedAt = null,
    edgeStatus = null,
  } = params;

  // Terminal states short-circuit. Orphaned/user-rejected edges contribute
  // nothing and are flagged stale so the caller can skip them entirely.
  if (edgeStatus === "orphaned" || edgeStatus === "user_rejected") {
    return { decayFactor: 0, derivedStatus: edgeStatus, stale: true };
  }

  const profile = pickDecayProfile(sourceCompletedAt, targetCompletedAt);
  if (!profile) {
    return { decayFactor: 1, derivedStatus: "active", stale: false };
  }

  const daysSince = daysSinceMostRecent(now, sourceCompletedAt, targetCompletedAt);
  const decayFactor = roundTo(
    clamp(decayCurve(daysSince, profile), profile.floor, 1),
  );

  return {
    decayFactor,
    derivedStatus: decayFactor < 0.999 ? "decayed" : "active",
    // "stale" means the edge has fully decayed to its floor — used by
    // consumers to drop these from default views without deleting them.
    // 0.001 tolerance absorbs floating-point comparison noise.
    stale: decayFactor <= profile.floor + 0.001,
  };
}

// ─── Prerequisite cascade ────────────────────────────────────────────────

export async function runPrerequisiteCascade(params: {
  triggeredByNodeId: string;
  newStatus: "completed" | "active";
  workspaceId: string;
  userId: string;
  lifecycleEventId: string;
  supabase: SupabaseClient;
}): Promise<LifecycleCascadeResult> {
  const {
    triggeredByNodeId,
    newStatus,
    workspaceId,
    userId,
    lifecycleEventId,
    supabase,
  } = params;

  const { data: outEdges } = await supabase
    .from("edges")
    .select("target_node_id")
    .eq("source_node_id", triggeredByNodeId)
    .eq("user_id", userId)
    .in("edge_type", ["prerequisite_for", "required_for"])
    .eq("status", "active");

  if (!outEdges || outEdges.length === 0) {
    return { newlyAvailable: [], cascadeCount: 0 };
  }

  const downstreamIds: string[] = [
    ...new Set(
      (outEdges as Array<{ target_node_id: string }>).map(
        (edge) => edge.target_node_id,
      ),
    ),
  ];

  const cascadeRows: Array<{
    lifecycle_event_id: string;
    affected_node_id: string;
    action_taken: string;
    details: Record<string, unknown>;
  }> = [];
  const newlyAvailable: Array<{ id: string; title: string }> = [];

  if (newStatus === "completed") {
    const { data: completedNodes } = await supabase
      .from("nodes")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("status", "completed");

    const completedIds = new Set<string>(
      (completedNodes ?? []).map((node) => node.id as string),
    );
    completedIds.add(triggeredByNodeId);

    for (const targetId of downstreamIds) {
      const { data: prereqEdges } = await supabase
        .from("edges")
        .select("source_node_id")
        .eq("target_node_id", targetId)
        .eq("user_id", userId)
        .in("edge_type", ["prerequisite_for", "required_for"])
        .eq("status", "active");

      if (!prereqEdges?.length) continue;

      const allSatisfied = (
        prereqEdges as Array<{ source_node_id: string }>
      ).every((edge) => completedIds.has(edge.source_node_id));
      if (!allSatisfied) continue;

      const { data: targetNode } = await supabase
        .from("nodes")
        .select("id, title, status")
        .eq("id", targetId)
        .eq("user_id", userId)
        .single();

      if (
        !targetNode ||
        targetNode.status === "completed" ||
        targetNode.status === "archived"
      ) {
        continue;
      }

      newlyAvailable.push({
        id: targetNode.id as string,
        title: targetNode.title as string,
      });
      cascadeRows.push({
        lifecycle_event_id: lifecycleEventId,
        affected_node_id: targetId,
        action_taken: "unblocked",
        details: {
          trigger_node_id: triggeredByNodeId,
          satisfied_prereqs: (
            prereqEdges as Array<{ source_node_id: string }>
          ).map((edge) => edge.source_node_id),
        },
      });
    }
  } else {
    for (const targetId of downstreamIds) {
      cascadeRows.push({
        lifecycle_event_id: lifecycleEventId,
        affected_node_id: targetId,
        action_taken: "score_recomputed",
        details: {
          trigger_node_id: triggeredByNodeId,
          reason: "prereq_reopened",
        },
      });
    }
  }

  if (cascadeRows.length > 0) {
    await supabase.from("cascade_results").insert(cascadeRows);
    await supabase
      .from("lifecycle_events")
      .update({ cascade_triggered: true })
      .eq("id", lifecycleEventId);
  }

  return { newlyAvailable, cascadeCount: cascadeRows.length };
}

// ─── Workspace-wide recompute ────────────────────────────────────────────

export async function recomputeWorkspaceEdgeDecay(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<{
  active: number;
  decayed: number;
  recomputed: number;
  stale: number;
}> {
  const { workspaceId, userId, supabase } = params;

  const [{ data: edges }, { data: nodes }, { data: edgeFeedbackEvents }] =
    await Promise.all([
      supabase
        .from("edges")
        .select(
          "id, source_node_id, target_node_id, status, confidence, user_confirmed, user_rejected",
        )
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId),
      supabase
        .from("nodes")
        .select("id, status, completed_at")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId),
      supabase
        .from("feedback_events")
        .select("entity_id, event_type")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("entity_type", "edge")
        .in("event_type", ["confirm_edge", "reject_edge"]),
    ]);

  if (!edges?.length || !nodes?.length) {
    return { active: 0, decayed: 0, recomputed: 0, stale: 0 };
  }

  const nodeMap = new Map(
    nodes.map((node) => [
      node.id as string,
      {
        status: (node.status as NodeStatus | null) ?? "active",
        completedAt: node.completed_at as string | null,
      },
    ]),
  );

  const confirmationCounts = new Map<string, number>();
  const rejectionCounts = new Map<string, number>();
  for (const event of edgeFeedbackEvents ?? []) {
    const edgeId = event.entity_id as string | null;
    if (!edgeId) continue;
    if (event.event_type === "confirm_edge") {
      confirmationCounts.set(edgeId, (confirmationCounts.get(edgeId) ?? 0) + 1);
    } else if (event.event_type === "reject_edge") {
      rejectionCounts.set(edgeId, (rejectionCounts.get(edgeId) ?? 0) + 1);
    }
  }

  const now = new Date();
  const edgeScoreRows: Array<{
    edge_id: string;
    confidence: number;
    confirmation_count: number;
    rejection_count: number;
    stale: boolean;
    decay_factor: number;
    final_weight: number;
  }> = [];
  const edgeStatusUpdates: Array<{ id: string; status: EdgeStatus }> = [];

  let active = 0;
  let decayed = 0;
  let stale = 0;

  for (const edge of edges) {
    const edgeId = edge.id as string;
    const source = nodeMap.get(edge.source_node_id as string);
    const target = nodeMap.get(edge.target_node_id as string);
    const currentStatus = ((edge.status as EdgeStatus | null) ??
      "active") as EdgeStatus;

    // Counts come from feedback_events when present; we fall back to the
    // legacy boolean columns for edges that pre-date the events table.
    const confirmationCount =
      confirmationCounts.get(edgeId) ??
      (((edge.user_confirmed as boolean | null) ?? false) ? 1 : 0);
    const rejectionCount =
      rejectionCounts.get(edgeId) ??
      (((edge.user_rejected as boolean | null) ?? false) ? 1 : 0);

    const normalizedConfidence = clamp(
      typeof edge.confidence === "number" ? edge.confidence : 0,
      0,
      1,
    );

    const decayState = deriveEdgeDecayState({
      now,
      sourceCompletedAt: source?.completedAt ?? null,
      targetCompletedAt: target?.completedAt ?? null,
      edgeStatus: currentStatus,
    });

    const finalWeight = roundTo(
      clamp(
        normalizedConfidence *
          100 *
          confirmationBoost(confirmationCount) *
          rejectionPenalty(rejectionCount) *
          decayState.decayFactor,
        0,
        100,
      ),
    );

    edgeScoreRows.push({
      edge_id: edgeId,
      confidence: roundTo(normalizedConfidence),
      confirmation_count: confirmationCount,
      rejection_count: rejectionCount,
      stale: decayState.stale,
      decay_factor: decayState.decayFactor,
      final_weight: finalWeight,
    });

    if (decayState.derivedStatus === "active") active += 1;
    else if (decayState.derivedStatus === "decayed") decayed += 1;
    if (decayState.stale) stale += 1;

    if (
      currentStatus !== "orphaned" &&
      currentStatus !== "user_rejected" &&
      currentStatus !== decayState.derivedStatus
    ) {
      edgeStatusUpdates.push({ id: edgeId, status: decayState.derivedStatus });
    }
  }

  if (edgeScoreRows.length > 0) {
    await supabase
      .from("edge_scores")
      .upsert(edgeScoreRows, { onConflict: "edge_id" });
  }

  if (edgeStatusUpdates.length > 0) {
    await Promise.all(
      edgeStatusUpdates.map((update) =>
        supabase
          .from("edges")
          .update({
            status: update.status,
            updated_at: now.toISOString(),
          })
          .eq("id", update.id)
          .eq("user_id", userId),
      ),
    );
  }

  return {
    active,
    decayed,
    recomputed: edgeScoreRows.length,
    stale,
  };
}
