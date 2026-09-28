// PATCH /api/nodes/[id]/status
// Thin HTTP wrapper over transitionNodeStatus() (src/lib/graph/status-transition.ts),
// the single implementation every status change goes through — this route, the
// chat tools, and brain-dump completions. See that module for the semantics.

import { NextRequest, NextResponse } from "next/server";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestToday } from "@/lib/time/request-date";
import type { NodeStatus } from "@/types/graph";

const VALID_STATUSES: NodeStatus[] = ["active", "completed", "paused", "archived"];

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

  let body: { status?: NodeStatus };
  try {
    body = (await req.json()) as { status?: NodeStatus };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const newStatus = body.status;
  if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const result = await transitionNodeStatus({
    supabase,
    userId: user.id,
    nodeId: id,
    newStatus,
    // The user's local day (bd_tz cookie) — a habit ticked after local
    // midnight must land on THEIR today, not UTC's.
    today: await getRequestToday(),
    habitSource: "manual",
  });

  switch (result.kind) {
    case "error":
      return NextResponse.json({ error: result.error }, { status: result.httpStatus });
    case "habit_logged":
      return NextResponse.json({
        node_id: result.nodeId,
        status: result.status, // unchanged — the habit stays active
        changed: false,
        habit_logged: true,
      });
    case "unchanged":
      return NextResponse.json({ node_id: result.nodeId, status: result.status, changed: false });
    case "changed":
      return NextResponse.json({
        node_id: result.nodeId,
        status: result.status,
        previous_status: result.previousStatus,
        changed: true,
        lifecycle_event_id: result.lifecycleEventId,
        updated_node: result.updatedNode,
        updated_nodes: result.updatedNodes,
        auto_completed_node_ids: result.autoCompletedNodeIds,
        auto_reopened_node_ids: result.autoReopenedNodeIds,
        newly_available: result.newlyAvailable,
        recomputed_scores: result.recomputedScores,
        updated_task_ids: result.updatedTaskIds,
      });
  }
}
