// PATCH /api/nodes/[id]/status
// Lifecycle status transitions: active ↔ completed, active ↔ paused, any → archived, archived → active.
// Logs lifecycle_events (immutable) and feedback_events on every valid transition.
// On complete: auto-completes active belongs_to descendants, runs prerequisite cascades,
// and recomputes scores synchronously so the UI can update immediately.
// On reopen: runs prerequisite cascade for the reopened node.
// On archive: orphans all connected edges.
// On unarchive (archived → active): restores orphaned edges to active.

import { NextRequest, NextResponse } from "next/server";
import { runPrerequisiteCascade } from "@/lib/ai/lifecycle";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { NodeStatus } from "@/types/graph";

// Valid transition map: current status → allowed next statuses
const VALID_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  active: ["completed", "paused", "archived"],
  completed: ["active", "archived"],
  paused: ["active", "archived"],
  archived: ["active"],
};

// Feedback event type per transition (where the enum has a matching value)
const FEEDBACK_EVENT: Partial<Record<string, string>> = {
  "active->completed": "complete_node",
  "completed->active": "reopen_node",
  "paused->active": "reopen_node",
  "archived->active": "reopen_node",
  "active->archived": "archive_node",
  "completed->archived": "archive_node",
  "paused->archived": "archive_node",
};

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
    if (edge.edge_type !== "belongs_to") {
      continue;
    }

    if (edge.status === "orphaned" || edge.status === "user_rejected") {
      continue;
    }

    const children = childrenByParent.get(edge.target_node_id) ?? [];
    children.push(edge.source_node_id);
    childrenByParent.set(edge.target_node_id, children);
  }

  const descendants: string[] = [];
  const visited = new Set<string>();
  const stack = [...(childrenByParent.get(rootNodeId) ?? [])];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (node && includeNode(node)) {
      descendants.push(nodeId);
    }

    for (const childId of childrenByParent.get(nodeId) ?? []) {
      if (!visited.has(childId)) {
        stack.push(childId);
      }
    }
  }

  return descendants;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { status: NodeStatus };
  const newStatus = body.status;

  const validStatuses: NodeStatus[] = ["active", "completed", "paused", "archived"];
  if (!validStatuses.includes(newStatus)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Fetch current node
  const { data: node, error: fetchError } = await supabase
    .from("nodes")
    .select("id, status, workspace_id, completed_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }

  const previousStatus = ((node.status as NodeStatus) ?? "active") as NodeStatus;

  if (previousStatus === newStatus) {
    return NextResponse.json({ node_id: id, status: newStatus, changed: false });
  }

  const allowed = VALID_TRANSITIONS[previousStatus] ?? [];
  if (!allowed.includes(newStatus)) {
    return NextResponse.json(
      { error: `Cannot transition from ${previousStatus} to ${newStatus}` },
      { status: 422 },
    );
  }

  // Build node update payload
  const nowIso = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    updated_at: nowIso,
  };

  if (newStatus === "completed") {
    updatePayload.completed_at = nowIso;
  } else if (previousStatus === "completed") {
    updatePayload.completed_at = null;
  }

  if (newStatus === "archived") {
    updatePayload.archived_at = nowIso;
  } else if (previousStatus === "archived") {
    updatePayload.archived_at = null;
  }

  const { error: updateError } = await supabase
    .from("nodes")
    .update(updatePayload)
    .eq("id", id)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Log lifecycle_event (append-only)
  const { data: le } = await supabase
    .from("lifecycle_events")
    .insert({
      node_id: id,
      user_id: user.id,
      previous_status: previousStatus,
      new_status: newStatus,
      cascade_triggered: false,
    })
    .select("id")
    .single();

  // Log feedback_event (best-effort, skipped if no matching enum value)
  const feedbackKey = `${previousStatus}->${newStatus}`;
  const feedbackType = FEEDBACK_EVENT[feedbackKey];
  if (feedbackType && node.workspace_id) {
    await supabase.from("feedback_events").insert({
      user_id: user.id,
      workspace_id: node.workspace_id,
      event_type: feedbackType,
      entity_type: "node",
      entity_id: id,
      metadata: { previous_status: previousStatus, new_status: newStatus },
    });
  }

  // Edge lifecycle effects
  if (newStatus === "archived") {
    // Orphan all connected edges so they vanish from the graph
    await supabase
      .from("edges")
      .update({ status: "orphaned", updated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .or(`source_node_id.eq.${id},target_node_id.eq.${id}`);
  } else if (newStatus === "active" && previousStatus === "archived") {
    // Restore edges that were orphaned when this node was archived
    await supabase
      .from("edges")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("status", "orphaned")
      .or(`source_node_id.eq.${id},target_node_id.eq.${id}`);
  }

  let autoCompletedNodeIds: string[] = [];
  let autoReopenedNodeIds: string[] = [];
  const newlyAvailable: Array<{ id: string; title: string }> = [];

  if (
    node.workspace_id &&
    (newStatus === "completed" || (newStatus === "active" && previousStatus === "completed"))
  ) {
    const [{ data: workspaceNodes }, { data: workspaceEdges }] = await Promise.all([
      supabase
        .from("nodes")
        .select("id, title, status, completed_at")
        .eq("workspace_id", node.workspace_id)
        .eq("user_id", user.id),
      supabase
        .from("edges")
        .select("source_node_id, target_node_id, edge_type, status")
        .eq("workspace_id", node.workspace_id)
        .eq("user_id", user.id),
    ]);

    const workspaceNodeRows = (workspaceNodes ?? []) as WorkspaceNodeRow[];
    const workspaceEdgeRows = (workspaceEdges ?? []) as WorkspaceEdgeRow[];

    if (newStatus === "completed") {
      autoCompletedNodeIds = collectBelongsToDescendantIds({
        edges: workspaceEdgeRows,
        includeNode: (workspaceNode) =>
          workspaceNode.status !== "completed" && workspaceNode.status !== "archived",
        nodes: workspaceNodeRows,
        rootNodeId: id,
      });
    } else {
      const parentCompletedAt = typeof node.completed_at === "string" ? node.completed_at : null;
      autoReopenedNodeIds = parentCompletedAt
        ? collectBelongsToDescendantIds({
            edges: workspaceEdgeRows,
            includeNode: (workspaceNode) =>
              workspaceNode.status === "completed" &&
              workspaceNode.completed_at === parentCompletedAt,
            nodes: workspaceNodeRows,
            rootNodeId: id,
          })
        : [];
    }

    if (autoCompletedNodeIds.length > 0 || autoReopenedNodeIds.length > 0) {
      const affectedDescendantNodeIds =
        newStatus === "completed" ? autoCompletedNodeIds : autoReopenedNodeIds;
      await supabase
        .from("nodes")
        .update({
          status: newStatus,
          completed_at: newStatus === "completed" ? nowIso : null,
          updated_at: nowIso,
        })
        .eq("user_id", user.id)
        .in("id", affectedDescendantNodeIds);

      const previousStatusByNodeId = new Map(
        workspaceNodeRows.map((workspaceNode) => [
          workspaceNode.id,
          workspaceNode.status ?? "active",
        ]),
      );

      const { data: childLifecycleEvents } = await supabase
        .from("lifecycle_events")
        .insert(
          affectedDescendantNodeIds.map((nodeId) => ({
            node_id: nodeId,
            user_id: user.id,
            previous_status: previousStatusByNodeId.get(nodeId) ?? "active",
            new_status: newStatus,
            cascade_triggered: false,
          })),
        )
        .select("id, node_id");

      await supabase.from("feedback_events").insert(
        affectedDescendantNodeIds.map((nodeId) => ({
          user_id: user.id,
          workspace_id: node.workspace_id,
          event_type: newStatus === "completed" ? "complete_node" : "reopen_node",
          entity_type: "node",
          entity_id: nodeId,
          metadata: {
            previous_status: previousStatusByNodeId.get(nodeId) ?? "active",
            new_status: newStatus,
            triggered_by_parent_id: id,
            cascade: "belongs_to_subtree",
          },
        })),
      );

      for (const lifecycleEvent of childLifecycleEvents ?? []) {
        const cascade = await runPrerequisiteCascade({
          triggeredByNodeId: lifecycleEvent.node_id as string,
          newStatus,
          workspaceId: node.workspace_id,
          userId: user.id,
          lifecycleEventId: lifecycleEvent.id as string,
          supabase,
        });

        newlyAvailable.push(...cascade.newlyAvailable);
      }
    }
  }

  if (
    node.workspace_id &&
    le?.id &&
    (newStatus === "completed" || (newStatus === "active" && previousStatus === "completed"))
  ) {
    const cascade = await runPrerequisiteCascade({
      triggeredByNodeId: id,
      newStatus,
      workspaceId: node.workspace_id,
      userId: user.id,
      lifecycleEventId: le.id,
      supabase,
    });

    newlyAvailable.push(...cascade.newlyAvailable);
  }

  let updatedNode = null;
  let updatedNodes: unknown[] = [];
  let recomputedScores: unknown[] = [];
  if (node.workspace_id) {
    const scoreResult = await computeWorkspaceScores({
      workspaceId: node.workspace_id,
      userId: user.id,
      supabase,
    });

    recomputedScores = scoreResult.nodeUpdates;

    const affectedNodeIds = [id, ...autoCompletedNodeIds, ...autoReopenedNodeIds];
    const { data: refreshedNodes } = await supabase
      .from("nodes")
      .select("*")
      .in("id", affectedNodeIds)
      .eq("user_id", user.id);

    updatedNodes = refreshedNodes ?? [];
    updatedNode =
      (refreshedNodes ?? []).find((refreshedNode) => refreshedNode.id === id) ?? null;
  } else {
    const { data: refreshedNode } = await supabase
      .from("nodes")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    updatedNode = refreshedNode ?? null;
    updatedNodes = updatedNode ? [updatedNode] : [];
  }

  // Cascade to plan_tasks: keep planner ↔ graph in sync.
  // - When a node transitions to "completed", mark all linked plan_tasks done.
  // - When it transitions FROM "completed" to anything else, un-mark them.
  // This includes the auto-completed belongs_to descendants from the cascade
  // above (so completing a parent project also checks off all its task rows).
  const cascadedNodeIds = (updatedNodes as Array<{ id?: string | null }>)
    .map((n) => (typeof n?.id === "string" ? n.id : null))
    .filter((id): id is string => id !== null);

  let updatedTaskIds: string[] = [];
  if (cascadedNodeIds.length > 0) {
    if (newStatus === "completed") {
      const { data: doneTasks } = await supabase
        .from("plan_tasks")
        .update({ done: true })
        .in("node_id", cascadedNodeIds)
        .eq("user_id", user.id)
        .eq("done", false)
        .select("id");
      updatedTaskIds = (doneTasks ?? []).map((row) => row.id as string);
    } else if (previousStatus === "completed") {
      // Coming back from completed — un-mark linked plan_tasks.
      const { data: reopenedTasks } = await supabase
        .from("plan_tasks")
        .update({ done: false })
        .in("node_id", cascadedNodeIds)
        .eq("user_id", user.id)
        .eq("done", true)
        .select("id");
      updatedTaskIds = (reopenedTasks ?? []).map((row) => row.id as string);
    }
  }

  // Cascade to habit_completions: when a habit-typed node transitions to
  // "completed", auto-log today's habit_completion (idempotent — the unique
  // (node_id, completed_on) constraint swallows duplicates). We do NOT
  // auto-delete on reopen — the user re-opening a habit node today shouldn't
  // wipe their streak history. They can manually unmark via the habit panel.
  if (newStatus === "completed") {
    const habitNodeIds = (updatedNodes as Array<{ id?: string | null; node_type?: string | null }>)
      .filter((n) => n.node_type === "habit" && typeof n.id === "string")
      .map((n) => n.id as string);

    if (habitNodeIds.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const inserts = habitNodeIds.map((nodeId) => ({
        user_id: user.id,
        node_id: nodeId,
        completed_on: today,
        source: "plan_task",
      }));
      // Use upsert with ignoreDuplicates so an already-logged habit for today
      // doesn't fail the request.
      await supabase
        .from("habit_completions")
        .upsert(inserts, { onConflict: "node_id,completed_on", ignoreDuplicates: true });
    }
  }

  return NextResponse.json({
    node_id: id,
    status: newStatus,
    previous_status: previousStatus,
    changed: true,
    lifecycle_event_id: le?.id ?? null,
    updated_node: updatedNode,
    updated_nodes: updatedNodes,
    auto_completed_node_ids: autoCompletedNodeIds,
    auto_reopened_node_ids: autoReopenedNodeIds,
    newly_available: [...new Map(newlyAvailable.map((item) => [item.id, item])).values()],
    recomputed_scores: recomputedScores,
    updated_task_ids: updatedTaskIds,
  });
}
