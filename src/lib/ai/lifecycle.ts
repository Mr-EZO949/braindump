import type { SupabaseClient } from "@supabase/supabase-js";

import { AI_DECAY } from "@/lib/ai/config";
import type { EdgeStatus, NodeStatus } from "@/types/graph";

export interface LifecycleCascadeResult {
  newlyAvailable: Array<{ id: string; title: string }>;
  cascadeCount: number;
}

export interface EdgeDecayState {
  decayFactor: number;
  derivedStatus: EdgeStatus;
  stale: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals = 4) {
  return Number(value.toFixed(decimals));
}

function computeDecayFactor(daysSince: number, params: { floor: number; fullDays: number }) {
  if (daysSince < AI_DECAY.DECAY_START_DAYS) {
    return 1;
  }

  if (daysSince >= params.fullDays) {
    return params.floor;
  }

  const progress =
    (daysSince - AI_DECAY.DECAY_START_DAYS) / (params.fullDays - AI_DECAY.DECAY_START_DAYS);

  return 1 - progress * (1 - params.floor);
}

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

  if (edgeStatus === "orphaned" || edgeStatus === "user_rejected") {
    return {
      decayFactor: 0,
      derivedStatus: edgeStatus,
      stale: true,
    };
  }

  const completedAts = [sourceCompletedAt, targetCompletedAt].filter(Boolean) as string[];
  if (completedAts.length === 0) {
    return {
      decayFactor: 1,
      derivedStatus: "active",
      stale: false,
    };
  }

  const mostRecentCompletedAtMs = Math.max(
    ...completedAts.map((completedAt) => new Date(completedAt).getTime()),
  );
  const daysSince =
    (now.getTime() - mostRecentCompletedAtMs) / (1000 * 60 * 60 * 24);

  const bothCompleted = completedAts.length === 2;
  const fullDays = bothCompleted
    ? Math.max(AI_DECAY.DECAY_START_DAYS + 1, Math.round(AI_DECAY.DECAY_FULL_DAYS * 0.6))
    : Math.round(AI_DECAY.DECAY_FULL_DAYS * 1.35);
  const floor = bothCompleted
    ? AI_DECAY.DECAY_FLOOR
    : Math.max(0.18, AI_DECAY.DECAY_FLOOR);
  const decayFactor = roundTo(clamp(computeDecayFactor(daysSince, { floor, fullDays }), floor, 1));

  return {
    decayFactor,
    derivedStatus: decayFactor < 0.999 ? "decayed" : "active",
    stale: decayFactor <= floor + 0.001,
  };
}

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
      (outEdges as Array<{ target_node_id: string }>).map((edge) => edge.target_node_id),
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

      if (!prereqEdges?.length) {
        continue;
      }

      const allSatisfied = (prereqEdges as Array<{ source_node_id: string }>).every((edge) =>
        completedIds.has(edge.source_node_id),
      );

      if (!allSatisfied) {
        continue;
      }

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

      newlyAvailable.push({ id: targetNode.id as string, title: targetNode.title as string });
      cascadeRows.push({
        lifecycle_event_id: lifecycleEventId,
        affected_node_id: targetId,
        action_taken: "unblocked",
        details: {
          trigger_node_id: triggeredByNodeId,
          satisfied_prereqs: (prereqEdges as Array<{ source_node_id: string }>).map(
            (edge) => edge.source_node_id,
          ),
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

  const [{ data: edges }, { data: nodes }, { data: edgeFeedbackEvents }] = await Promise.all([
    supabase
      .from("edges")
      .select("id, source_node_id, target_node_id, status, confidence, user_confirmed, user_rejected")
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
    if (!edgeId) {
      continue;
    }

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
    const currentStatus = ((edge.status as EdgeStatus | null) ?? "active") as EdgeStatus;

    const confirmationCount =
      confirmationCounts.get(edgeId) ?? (((edge.user_confirmed as boolean | null) ?? false) ? 1 : 0);
    const rejectionCount =
      rejectionCounts.get(edgeId) ?? (((edge.user_rejected as boolean | null) ?? false) ? 1 : 0);
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

    const confirmationBoost = 1 + confirmationCount * 0.12;
    const rejectionPenalty = Math.max(0, 1 - rejectionCount * 0.2);
    const finalWeight = roundTo(
      clamp(normalizedConfidence * 100 * confirmationBoost * rejectionPenalty * decayState.decayFactor, 0, 100),
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

    if (decayState.derivedStatus === "active") {
      active += 1;
    } else if (decayState.derivedStatus === "decayed") {
      decayed += 1;
    }

    if (decayState.stale) {
      stale += 1;
    }

    if (
      currentStatus !== "orphaned" &&
      currentStatus !== "user_rejected" &&
      currentStatus !== decayState.derivedStatus
    ) {
      edgeStatusUpdates.push({
        id: edgeId,
        status: decayState.derivedStatus,
      });
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
