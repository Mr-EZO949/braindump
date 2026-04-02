// PATCH /api/assistant/plan/[sessionId]/feedback — Phase 10.4
// Records whether the user accepted, edited, or rejected the plan.
// Also deletes blocks the user removed before accepting, and writes a feedback_event.
//
// Body:
//   { accepted?: boolean; rejected?: boolean; final_block_ids?: string[] }
//
// When accepted:
//   - Sets plan_session.status = 'accepted'
//   - Writes plan_feedback(accepted=true, edited=<blocks were changed>)
//   - Deletes blocks not in final_block_ids (tracks "consistently cut" blocks via feedback_events)
//   - Writes feedback_event(event_type='accept_node', entity_type='plan_session', entity_id=sessionId)
//
// When rejected:
//   - Sets plan_session.status = 'rejected'
//   - Writes plan_feedback(rejected=true)

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Parse body
  // -------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    accepted = false,
    rejected = false,
    final_block_ids = null,
  } = body as {
    accepted?: boolean;
    rejected?: boolean;
    final_block_ids?: string[] | null;
  };

  if (!accepted && !rejected) {
    return NextResponse.json({ error: "Must set accepted or rejected to true" }, { status: 400 });
  }

  // -------------------------------------------------------------------------
  // Verify session belongs to user
  // -------------------------------------------------------------------------
  const { data: session, error: sessionError } = await supabase
    .from("plan_sessions")
    .select("id, workspace_id, status")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: "Plan session not found" }, { status: 404 });
  }

  if (session.status !== "draft") {
    return NextResponse.json(
      { error: "Plan session is already finalized" },
      { status: 409 },
    );
  }

  const newStatus = accepted ? "accepted" : "rejected";

  // -------------------------------------------------------------------------
  // Update session status
  // -------------------------------------------------------------------------
  const { error: updateError } = await supabase
    .from("plan_sessions")
    .update({ status: newStatus })
    .eq("id", sessionId)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "Failed to update session" }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Write plan_feedback
  // -------------------------------------------------------------------------
  let edited = false;

  if (accepted && final_block_ids) {
    // Fetch original blocks to determine if any were removed
    const { data: originalBlocks } = await supabase
      .from("plan_blocks")
      .select("id")
      .eq("plan_session_id", sessionId);

    const originalIds = new Set((originalBlocks ?? []).map((b: { id: string }) => b.id));
    const finalSet = new Set(final_block_ids);
    const removedIds = [...originalIds].filter((id) => !finalSet.has(id));
    edited = removedIds.length > 0;

    // Delete removed blocks — these represent consistently-cut work
    if (removedIds.length > 0) {
      await supabase.from("plan_blocks").delete().in("id", removedIds);
    }
  }

  await supabase.from("plan_feedback").upsert(
    {
      plan_session_id: sessionId,
      user_id: user.id,
      accepted: accepted && !rejected,
      edited,
      rejected: rejected && !accepted,
      completion_status: null,
    },
    { onConflict: "plan_session_id" },
  );

  // -------------------------------------------------------------------------
  // Write feedback_event (10.4 — feeds ranking signals over time)
  // -------------------------------------------------------------------------
  await supabase.from("feedback_events").insert({
    event_type: accepted ? "accept_node" : "reject_node", // repurpose as plan accept/reject
    entity_type: "plan_session",
    entity_id: sessionId,
    user_id: user.id,
    workspace_id: session.workspace_id,
    metadata: {
      plan_action: newStatus,
      blocks_kept: final_block_ids?.length ?? null,
      blocks_edited: edited,
    },
  });

  return NextResponse.json({ status: newStatus, edited });
}
