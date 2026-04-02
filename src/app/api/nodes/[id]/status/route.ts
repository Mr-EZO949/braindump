// PATCH /api/nodes/[id]/status
// Lifecycle status transitions: active ↔ completed, active ↔ paused, any → archived, archived → active.
// Logs lifecycle_events (immutable) and feedback_events on every valid transition.
// On complete/reopen: runs prerequisite cascade to find newly-available downstream nodes.
// On archive: orphans all connected edges.
// On unarchive (archived → active): restores orphaned edges to active.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import type { NodeStatus } from "@/types/graph";

// ---------------------------------------------------------------------------
// Prerequisite cascade engine — Phase 6.3 / lifecycle dependency tracking
//
// Traverses prerequisite_for and required_for edges only.
// On complete: finds downstream nodes whose ALL prerequisites are now satisfied
//   → writes cascade_result(action='unblocked') for each
// On reopen:   finds downstream nodes that lose a satisfied prerequisite
//   → writes cascade_result(action='score_recomputed') for each
// ---------------------------------------------------------------------------

type CascadeResult = {
  newlyAvailable: Array<{ id: string; title: string }>;
  cascadeCount: number;
};

async function runPrerequisiteCascade(params: {
  triggeredByNodeId: string;
  newStatus: "completed" | "active";
  workspaceId: string;
  userId: string;
  lifecycleEventId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
}): Promise<CascadeResult> {
  const { triggeredByNodeId, newStatus, workspaceId, userId, lifecycleEventId, supabase } = params;

  // Find all nodes that depend on this node (it is a prerequisite FOR them)
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
      (outEdges as Array<{ target_node_id: string }>).map((e) => e.target_node_id),
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
    // Build the set of completed node IDs (including the one just completed)
    const { data: completedNodes } = await supabase
      .from("nodes")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("status", "completed");

    const completedIds = new Set<string>(
      (completedNodes ?? []).map((n: { id: string }) => n.id),
    );
    completedIds.add(triggeredByNodeId);

    for (const targetId of downstreamIds) {
      // All prerequisite sources pointing at this target
      const { data: prereqEdges } = await supabase
        .from("edges")
        .select("source_node_id")
        .eq("target_node_id", targetId)
        .eq("user_id", userId)
        .in("edge_type", ["prerequisite_for", "required_for"])
        .eq("status", "active");

      if (!prereqEdges?.length) continue;

      const allSatisfied = (prereqEdges as Array<{ source_node_id: string }>).every(
        (e) => completedIds.has(e.source_node_id),
      );

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

      newlyAvailable.push({ id: targetNode.id, title: targetNode.title });
      cascadeRows.push({
        lifecycle_event_id: lifecycleEventId,
        affected_node_id: targetId,
        action_taken: "unblocked",
        details: {
          trigger_node_id: triggeredByNodeId,
          satisfied_prereqs: (prereqEdges as Array<{ source_node_id: string }>).map(
            (e) => e.source_node_id,
          ),
        },
      });
    }
  } else {
    // Node reopened — downstream nodes lose a satisfied prerequisite
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
    void supabase.from("cascade_results").insert(cascadeRows);
    void supabase
      .from("lifecycle_events")
      .update({ cascade_triggered: true })
      .eq("id", lifecycleEventId);
  }

  return { newlyAvailable, cascadeCount: cascadeRows.length };
}

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
    .select("id, status, workspace_id")
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
  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };

  if (newStatus === "completed") {
    updatePayload.completed_at = new Date().toISOString();
  } else if (previousStatus === "completed") {
    updatePayload.completed_at = null;
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
    void supabase.from("feedback_events").insert({
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
    void supabase
      .from("edges")
      .update({ status: "orphaned", updated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .or(`source_node_id.eq.${id},target_node_id.eq.${id}`);
  } else if (newStatus === "active" && previousStatus === "archived") {
    // Restore edges that were orphaned when this node was archived
    void supabase
      .from("edges")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("status", "orphaned")
      .or(`source_node_id.eq.${id},target_node_id.eq.${id}`);
  }

  // Prerequisite cascade — runs on complete or reopen, writes cascade_results
  let newlyAvailable: Array<{ id: string; title: string }> = [];
  if (
    le?.id &&
    node.workspace_id &&
    (newStatus === "completed" ||
      (newStatus === "active" && previousStatus === "completed"))
  ) {
    const cascade = await runPrerequisiteCascade({
      triggeredByNodeId: id,
      newStatus: newStatus as "completed" | "active",
      workspaceId: node.workspace_id as string,
      userId: user.id,
      lifecycleEventId: le.id,
      supabase,
    });
    newlyAvailable = cascade.newlyAvailable;
  }

  // 6.3 — belongs_to cascade: find active children when a parent is completed
  let affectedChildren: Array<{ id: string; title: string }> = [];
  if (newStatus === "completed") {
    const { data: childEdges } = await supabase
      .from("edges")
      .select("source_node_id")
      .eq("user_id", user.id)
      .eq("target_node_id", id)
      .eq("edge_type", "belongs_to")
      .eq("status", "active");

    if (childEdges && childEdges.length > 0) {
      const childIds = childEdges.map((e: { source_node_id: string }) => e.source_node_id);
      const { data: childNodes } = await supabase
        .from("nodes")
        .select("id, title, status")
        .in("id", childIds)
        .eq("user_id", user.id)
        .neq("status", "completed")
        .neq("status", "archived");

      affectedChildren = (childNodes ?? []).map((n: { id: string; title: string }) => ({
        id: n.id,
        title: n.title,
      }));
    }
  }

  let updatedNode = null;
  let recomputedScores: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }> = [];

  // Phase 7 — recompute scores; completion/archival change the whole workspace's topology
  if (node.workspace_id) {
    const scoreResult = await computeWorkspaceScores({
      workspaceId: node.workspace_id as string,
      userId: user.id,
      supabase,
    });
    recomputedScores = scoreResult.nodeUpdates;

    const { data: refreshedNode } = await supabase
      .from("nodes")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    updatedNode = refreshedNode ?? null;
  }

  return NextResponse.json({
    node_id: id,
    status: newStatus,
    previous_status: previousStatus,
    changed: true,
    lifecycle_event_id: le?.id ?? null,
    updated_node: updatedNode,
    affected_children: affectedChildren,
    newly_available: newlyAvailable,
    recomputed_scores: recomputedScores,
  });
}
