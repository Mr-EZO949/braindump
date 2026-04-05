// PATCH /api/nodes/[id]/status
// Lifecycle status transitions: active ↔ completed, active ↔ paused, any → archived, archived → active.
// Logs lifecycle_events (immutable) and feedback_events on every valid transition.
// On complete/reopen: queues prerequisite cascade to find newly-available downstream nodes.
// On archive: orphans all connected edges.
// On unarchive (archived → active): restores orphaned edges to active.

import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { drainAIJobsWithAdminClient, enqueueAIJob } from "@/lib/ai/jobs";
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

  if (newStatus === "archived") {
    updatePayload.archived_at = new Date().toISOString();
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
  if (node.workspace_id) {
    const queuedJobs = [
      enqueueAIJob({
        supabase,
        userId: user.id,
        workspaceId: node.workspace_id as string,
        jobType: "score_recompute",
        payload: {
          workspace_id: node.workspace_id,
        },
      }),
    ];

    if (
      le?.id &&
      (newStatus === "completed" ||
        (newStatus === "active" && previousStatus === "completed"))
    ) {
      queuedJobs.push(
        enqueueAIJob({
          supabase,
          userId: user.id,
          workspaceId: node.workspace_id as string,
          jobType: "lifecycle_cascade",
          payload: {
            lifecycle_event_id: le.id,
            new_status: newStatus,
            triggered_by_node_id: id,
            workspace_id: node.workspace_id,
          },
        }),
      );
    }

    await Promise.all(queuedJobs);

    after(async () => {
      try {
        await drainAIJobsWithAdminClient();
      } catch (error) {
        console.error("[api/nodes/status] failed to drain AI jobs:", error);
      }
    });
  }

  const { data: refreshedNode } = await supabase
    .from("nodes")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  updatedNode = refreshedNode ?? null;

  return NextResponse.json({
    node_id: id,
    status: newStatus,
    previous_status: previousStatus,
    changed: true,
    lifecycle_event_id: le?.id ?? null,
    updated_node: updatedNode,
    affected_children: affectedChildren,
    newly_available: [],
    recomputed_scores: [],
  });
}
