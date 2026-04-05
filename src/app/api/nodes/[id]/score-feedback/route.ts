// POST /api/nodes/[id]/score-feedback
// Records manual importance feedback for a node and recomputes workspace scores.
//
// Body: { action: "boost" | "demote" }

import { NextRequest, NextResponse } from "next/server";

import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const FEEDBACK_EVENT_BY_ACTION = {
  boost: "boost_node",
  demote: "demote_node",
} as const;

export async function POST(
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action } = body as { action?: "boost" | "demote" };
  if (action !== "boost" && action !== "demote") {
    return NextResponse.json(
      { error: "action must be 'boost' or 'demote'" },
      { status: 400 },
    );
  }

  const { data: node, error: nodeError } = await supabase
    .from("nodes")
    .select("id, workspace_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (nodeError || !node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }

  if (!node.workspace_id) {
    return NextResponse.json({ error: "Node workspace is missing" }, { status: 422 });
  }

  const { error: feedbackError } = await supabase.from("feedback_events").insert({
    user_id: user.id,
    workspace_id: node.workspace_id,
    event_type: FEEDBACK_EVENT_BY_ACTION[action],
    entity_type: "node",
    entity_id: id,
    metadata: {
      source: "manual_score_feedback",
      action,
    },
  });

  if (feedbackError) {
    return NextResponse.json({ error: feedbackError.message }, { status: 500 });
  }

  const scoreResult = await computeWorkspaceScores({
    workspaceId: node.workspace_id as string,
    userId: user.id,
    supabase,
  });

  const updatedNode = scoreResult.nodeUpdates.find((candidate) => candidate.id === id) ?? null;

  return NextResponse.json({
    action,
    node_id: id,
    recomputed: scoreResult.recomputed,
    updated_score: updatedNode?.current_importance_score ?? null,
  });
}
