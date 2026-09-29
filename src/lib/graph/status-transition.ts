// Node status transitions — THE single implementation.
//
// Every path that changes a node's lifecycle status goes through
// transitionNodeStatus(): the Details/planner PATCH route, the chat tools
// (complete_node, archive_node, propose_changes_batch) and brain-dump
// completions (/api/entries). Before this existed, the same action had five
// hand-rolled copies with different behavior — e.g. completing a project via
// chat skipped the subtree/prerequisite/score/planner cascades the button ran,
// and completing a HABIT via chat or a dump marked the whole habit done.
//
// Semantics:
//   active ↔ completed, active ↔ paused, any → archived, archived → active.
//   Habits RECUR: "completing" one logs the user's local day and leaves the
//     node active (never status=completed).
//   On complete: auto-complete active belongs_to descendants, run prerequisite
//     cascades, check off linked plan_tasks.
//   On reopen: auto-reopen descendants completed in the same cascade, reverse
//     plan_task check-offs.
//   On archive: orphan all connected edges. On unarchive: restore them.
//   Logs lifecycle_events (immutable) + feedback_events on every transition.

import type { SupabaseClient } from "@supabase/supabase-js";
import { runPrerequisiteCascade } from "@/lib/ai/lifecycle";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import type { NodeStatus } from "@/types/graph";

// Valid transition map: current status → allowed next statuses.
export const VALID_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  active: ["completed", "paused", "archived"],
  completed: ["active", "archived"],
  paused: ["active", "archived"],
  archived: ["active"],
};

// Feedback event type per transition (where the enum has a matching value).
const FEEDBACK_EVENT: Partial<Record<string, string>> = {
  "active->completed": "complete_node",
  "completed->active": "reopen_node",
  "paused->active": "reopen_node",
  "archived->active": "reopen_node",
  "active->archived": "archive_node",
  "completed->archived": "archive_node",
  "paused->archived": "archive_node",
};

// Habits recur — "complete" means "done for today", never a terminal status.
export function isRecurringNodeType(nodeType: string | null | undefined): boolean {
  return nodeType === "habit";
}

export type HabitCompletionSource = "manual" | "chat" | "dump" | "plan_task";

// Idempotent: the unique (node_id, completed_on) constraint absorbs repeats.
export async function logHabitCompletion(params: {
  supabase: SupabaseClient;
  userId: string;
  nodeId: string;
  // The USER's local date (YYYY-MM-DD). Never derive this from UTC.
  date: string;
  source: HabitCompletionSource;
}): Promise<void> {
  await params.supabase
    .from("habit_completions")
    .upsert(
      {
        user_id: params.userId,
        node_id: params.nodeId,
        completed_on: params.date,
        source: params.source,
      },
      { onConflict: "node_id,completed_on", ignoreDuplicates: true },
    );
}

type WorkspaceNodeRow = {
  completed_at: string | null;
  id: string;
  status: NodeStatus | null;
  title: string | null;
};

type WorkspaceEdgeRow = {
  edge_type: string | null;
  source_node_id: string;
  status: string | null;
  target_node_id: string;
};

function collectBelongsToDescendantIds(params: {
  edges: WorkspaceEdgeRow[];
  includeNode: (node: WorkspaceNodeRow) => boolean;
  nodes: WorkspaceNodeRow[];
  rootNodeId: string;
}) {
  const { edges, includeNode, nodes, rootNodeId } = params;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, string[]>();

  for (const edge of edges) {
    if (edge.edge_type !== "belongs_to") continue;
    if (edge.status === "orphaned" || edge.status === "user_rejected") continue;
    const children = childrenByParent.get(edge.target_node_id) ?? [];
    children.push(edge.source_node_id);
    childrenByParent.set(edge.target_node_id, children);
  }

  const descendants: string[] = [];
  const visited = new Set<string>();
  const stack = [...(childrenByParent.get(rootNodeId) ?? [])];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (node && includeNode(node)) descendants.push(nodeId);

    for (const childId of childrenByParent.get(nodeId) ?? []) {
      if (!visited.has(childId)) stack.push(childId);
    }
  }

  return descendants;
}

export type TransitionResult =
  | { kind: "error"; httpStatus: number; error: string }
  // Habit "completed": today's completion logged, node stays in its status.
  | { kind: "habit_logged"; nodeId: string; status: NodeStatus; loggedOn: string }
  | { kind: "unchanged"; nodeId: string; status: NodeStatus }
  | {
      kind: "changed";
      nodeId: string;
      previousStatus: NodeStatus;
      status: NodeStatus;
      lifecycleEventId: string | null;
      updatedNode: unknown;
      updatedNodes: unknown[];
      autoCompletedNodeIds: string[];
      autoReopenedNodeIds: string[];
      newlyAvailable: Array<{ id: string; title: string }>;
      recomputedScores: unknown[];
      updatedTaskIds: string[];
    };

export async function transitionNodeStatus(params: {
  supabase: SupabaseClient;
  userId: string;
  nodeId: string;
  newStatus: NodeStatus;
  // The user's local date (YYYY-MM-DD) — used for habit completions.
  today: string;
  // When set, the node must belong to this workspace (chat/dump callers).
  workspaceId?: string;
  habitSource?: HabitCompletionSource;
  // Batch callers pass false and recompute once at the end instead of per item.
  recomputeScores?: boolean;
}): Promise<TransitionResult> {
  const { supabase, userId, nodeId, newStatus, today } = params;
  const recompute = params.recomputeScores ?? true;

  let nodeQuery = supabase
    .from("nodes")
    .select("id, status, node_type, workspace_id, completed_at")
    .eq("id", nodeId)
    .eq("user_id", userId);
  if (params.workspaceId) nodeQuery = nodeQuery.eq("workspace_id", params.workspaceId);
  const { data: node, error: fetchError } = await nodeQuery.maybeSingle();

  if (fetchError || !node) {
    return { kind: "error", httpStatus: 404, error: "Node not found" };
  }

  const previousStatus = ((node.status as NodeStatus) ?? "active") as NodeStatus;

  // Habits recur — completing one logs the user's day and keeps it active.
  if (isRecurringNodeType(node.node_type as string) && newStatus === "completed") {
    await logHabitCompletion({
      supabase,
      userId,
      nodeId,
      date: today,
      source: params.habitSource ?? "manual",
    });
    return { kind: "habit_logged", nodeId, status: previousStatus, loggedOn: today };
  }

  if (previousStatus === newStatus) {
    return { kind: "unchanged", nodeId, status: newStatus };
  }

  const allowed = VALID_TRANSITIONS[previousStatus] ?? [];
  if (!allowed.includes(newStatus)) {
    return {
      kind: "error",
      httpStatus: 422,
      error:
        previousStatus === "archived"
          ? "This item is archived — reactivate it first."
          : `Cannot transition from ${previousStatus} to ${newStatus}`,
    };
  }

  const nowIso = new Date().toISOString();
  const updatePayload: Record<string, unknown> = { status: newStatus, updated_at: nowIso };
  if (newStatus === "completed") updatePayload.completed_at = nowIso;
  else if (previousStatus === "completed") updatePayload.completed_at = null;
  if (newStatus === "archived") updatePayload.archived_at = nowIso;
  else if (previousStatus === "archived") updatePayload.archived_at = null;

  // Latency matters here — this runs on every "mark done" tap — so the work
  // is staged into as few sequential round trips as the dependencies allow:
  //   1. update the node  ‖  read the workspace graph (for the subtree cascade)
  //   2. lifecycle/feedback events, edge (un)orphaning, the subtree update and
  //      its events — all in parallel
  //   3. prerequisite cascades, score recompute, row refresh, planner sync and
  //      habit logs — all in parallel
  const touchesCompletion =
    newStatus === "completed" || (newStatus === "active" && previousStatus === "completed");
  const workspaceId = node.workspace_id as string | null;
  const loadWorkspaceGraph = Boolean(workspaceId && touchesCompletion);

  const [{ error: updateError }, workspaceGraph] = await Promise.all([
    supabase.from("nodes").update(updatePayload).eq("id", nodeId).eq("user_id", userId),
    loadWorkspaceGraph
      ? Promise.all([
          supabase
            .from("nodes")
            .select("id, title, status, completed_at, node_type")
            .eq("workspace_id", workspaceId)
            .eq("user_id", userId),
          supabase
            .from("edges")
            .select("source_node_id, target_node_id, edge_type, status")
            .eq("workspace_id", workspaceId)
            .eq("user_id", userId),
        ])
      : null,
  ]);
  if (updateError) {
    return { kind: "error", httpStatus: 500, error: updateError.message };
  }

  let autoCompletedNodeIds: string[] = [];
  let autoReopenedNodeIds: string[] = [];
  const workspaceNodeRows = (workspaceGraph?.[0].data ?? []) as Array<
    WorkspaceNodeRow & { node_type?: string | null }
  >;
  const workspaceEdgeRows = (workspaceGraph?.[1].data ?? []) as WorkspaceEdgeRow[];

  if (workspaceGraph) {
    // The graph was read alongside the node's own update, so exclude the node
    // itself explicitly (a belongs_to cycle could otherwise pull it back in).
    if (newStatus === "completed") {
      autoCompletedNodeIds = collectBelongsToDescendantIds({
        edges: workspaceEdgeRows,
        includeNode: (n) => n.id !== nodeId && n.status !== "completed" && n.status !== "archived",
        nodes: workspaceNodeRows,
        rootNodeId: nodeId,
      });
    } else {
      const parentCompletedAt =
        typeof node.completed_at === "string" ? node.completed_at : null;
      autoReopenedNodeIds = parentCompletedAt
        ? collectBelongsToDescendantIds({
            edges: workspaceEdgeRows,
            includeNode: (n) =>
              n.id !== nodeId && n.status === "completed" && n.completed_at === parentCompletedAt,
            nodes: workspaceNodeRows,
            rootNodeId: nodeId,
          })
        : [];
    }
  }
  const affectedDescendantNodeIds =
    newStatus === "completed" ? autoCompletedNodeIds : autoReopenedNodeIds;
  const previousStatusByNodeId = new Map(
    workspaceNodeRows.map((n) => [n.id, n.status ?? "active"]),
  );

  // Feedback event (best-effort; skipped when there's no matching enum value).
  const feedbackType = FEEDBACK_EVENT[`${previousStatus}->${newStatus}`];

  const [{ data: le }, , , childEventsResult] = await Promise.all([
    // Lifecycle event (append-only).
    supabase
      .from("lifecycle_events")
      .insert({
        node_id: nodeId,
        user_id: userId,
        previous_status: previousStatus,
        new_status: newStatus,
        cascade_triggered: false,
      })
      .select("id")
      .single(),
    feedbackType && workspaceId
      ? supabase.from("feedback_events").insert({
          user_id: userId,
          workspace_id: workspaceId,
          event_type: feedbackType,
          entity_type: "node",
          entity_id: nodeId,
          metadata: { previous_status: previousStatus, new_status: newStatus },
        })
      : null,
    // Edge lifecycle: archive orphans every connected edge; unarchive restores.
    // (Completing does NOT orphan — a done task stays attached to its parent.)
    newStatus === "archived"
      ? supabase
          .from("edges")
          .update({ status: "orphaned", updated_at: nowIso })
          .eq("user_id", userId)
          .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
      : newStatus === "active" && previousStatus === "archived"
        ? supabase
            .from("edges")
            .update({ status: "active", updated_at: nowIso })
            .eq("user_id", userId)
            .eq("status", "orphaned")
            .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`)
        : null,
    // The belongs_to subtree follows the node (complete ↔ reopen).
    affectedDescendantNodeIds.length > 0
      ? Promise.all([
          supabase
            .from("lifecycle_events")
            .insert(
              affectedDescendantNodeIds.map((childId) => ({
                node_id: childId,
                user_id: userId,
                previous_status: previousStatusByNodeId.get(childId) ?? "active",
                new_status: newStatus,
                cascade_triggered: false,
              })),
            )
            .select("id, node_id"),
          supabase
            .from("nodes")
            .update({
              status: newStatus,
              completed_at: newStatus === "completed" ? nowIso : null,
              updated_at: nowIso,
            })
            .eq("user_id", userId)
            .in("id", affectedDescendantNodeIds),
          supabase.from("feedback_events").insert(
            affectedDescendantNodeIds.map((childId) => ({
              user_id: userId,
              workspace_id: workspaceId,
              event_type: newStatus === "completed" ? "complete_node" : "reopen_node",
              entity_type: "node",
              entity_id: childId,
              metadata: {
                previous_status: previousStatusByNodeId.get(childId) ?? "active",
                new_status: newStatus,
                triggered_by_parent_id: nodeId,
                cascade: "belongs_to_subtree",
              },
            })),
          ),
        ])
      : null,
  ]);
  const childLifecycleEvents = (childEventsResult?.[0].data ?? []) as Array<{
    id: string;
    node_id: string;
  }>;

  // Everything below reads the statuses written above and nothing else here
  // writes them, so it all runs in parallel.
  const cascadeTriggers =
    workspaceId && touchesCompletion
      ? [
          ...childLifecycleEvents.map((event) => ({ nodeId: event.node_id, eventId: event.id })),
          ...(le?.id ? [{ nodeId, eventId: le.id as string }] : []),
        ]
      : [];
  // Deduped: the id list feeds .in() filters.
  const affectedNodeIds = [...new Set([nodeId, ...autoCompletedNodeIds, ...autoReopenedNodeIds])];
  const nodeTypeById = new Map(workspaceNodeRows.map((n) => [n.id, n.node_type ?? null]));
  // A habit swept up in a PARENT's completion (e.g. the goal it serves was
  // finished) is completed with it; still record today's completion so its
  // history is honest. The user's local day — not UTC.
  const sweptHabitIds =
    newStatus === "completed"
      ? autoCompletedNodeIds.filter((id) => isRecurringNodeType(nodeTypeById.get(id)))
      : [];
  // Keep planner ↔ graph in sync: completing checks off linked plan_tasks
  // (including the auto-completed subtree); reopening un-checks them.
  const planTaskToggle =
    newStatus === "completed" ? true : previousStatus === "completed" ? false : null;

  const [cascades, scoreResult, { data: refreshedNodes }, planTasksResult] = await Promise.all([
    Promise.all(
      cascadeTriggers.map((trigger) =>
        runPrerequisiteCascade({
          triggeredByNodeId: trigger.nodeId,
          newStatus: newStatus as "completed" | "active",
          workspaceId: workspaceId as string,
          userId,
          lifecycleEventId: trigger.eventId,
          supabase,
        }),
      ),
    ),
    workspaceId && recompute
      ? computeWorkspaceScores({ workspaceId, userId, supabase })
      : null,
    // Refresh the affected rows (scores are patched in below so the UI
    // updates at once).
    supabase.from("nodes").select("*").in("id", affectedNodeIds).eq("user_id", userId),
    planTaskToggle !== null
      ? supabase
          .from("plan_tasks")
          .update({ done: planTaskToggle })
          .in("node_id", affectedNodeIds)
          .eq("user_id", userId)
          .eq("done", !planTaskToggle)
          .select("id")
      : null,
    Promise.all(
      sweptHabitIds.map((habitId) =>
        logHabitCompletion({ supabase, userId, nodeId: habitId, date: today, source: "plan_task" }),
      ),
    ),
  ]);

  const newlyAvailable = cascades.flatMap((cascade) => cascade.newlyAvailable);
  const recomputedScores: unknown[] = scoreResult?.nodeUpdates ?? [];
  // The refresh ran alongside the score write, so overlay the fresh scores.
  const scoreById = new Map((scoreResult?.nodeUpdates ?? []).map((u) => [u.id, u]));
  const updatedNodes: unknown[] = ((refreshedNodes ?? []) as Array<{ id: string }>).map((row) => {
    const score = scoreById.get(row.id);
    return score
      ? {
          ...row,
          current_importance_score: score.current_importance_score,
          importance_index: score.importance_index,
          importance: score.importance,
          importance_reason: score.importance_reason,
          importance_top_signals: score.importance_top_signals,
        }
      : row;
  });
  const updatedNode =
    (updatedNodes as Array<{ id: string }>).find((n) => n.id === nodeId) ?? null;
  const updatedTaskIds = ((planTasksResult?.data ?? []) as Array<{ id: string }>).map(
    (row) => row.id,
  );

  const dedupedNewlyAvailable = [
    ...new Map(newlyAvailable.map((item) => [item.id, item])).values(),
  ];

  return {
    kind: "changed",
    nodeId,
    previousStatus,
    status: newStatus,
    lifecycleEventId: le?.id ?? null,
    updatedNode,
    updatedNodes,
    autoCompletedNodeIds,
    autoReopenedNodeIds,
    newlyAvailable: dedupedNewlyAvailable,
    recomputedScores,
    updatedTaskIds,
  };
}
