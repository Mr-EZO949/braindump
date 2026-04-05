// PATCH /api/assistant/plan/[sessionId]/feedback — Phase 10.4
// Records whether the user accepted, edited, or rejected the plan.
// Also applies accepted-plan edits before finalizing, and writes a feedback_event.
//
// Body:
//   { accepted?: boolean; rejected?: boolean; final_block_ids?: string[] }
//
// When accepted:
//   - Sets plan_session.status = 'accepted'
//   - Writes plan_feedback(accepted=true, edited=<blocks were changed>)
//   - Deletes blocks not in final_block_ids and rewrites kept block start_offsets
//   - Writes feedback_event(event_type='accept_node', entity_type='plan_session', entity_id=sessionId)
//
// When rejected:
//   - Sets plan_session.status = 'rejected'
//   - Writes plan_feedback(rejected=true)

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { computeWorkspaceScores } from "@/lib/ai/scoring";

type StoredPlanBlock = {
  duration_minutes: number;
  id: string;
  start_offset: number;
};

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
  // Write plan_feedback
  // -------------------------------------------------------------------------
  let edited = false;
  let reordered = false;

  if (accepted && final_block_ids) {
    // Fetch original blocks to determine removals/reordering and recompute offsets.
    const { data: originalBlocks, error: blocksFetchError } = await supabase
      .from("plan_blocks")
      .select("id, duration_minutes, start_offset")
      .eq("plan_session_id", sessionId);

    if (blocksFetchError) {
      return NextResponse.json({ error: "Failed to load existing plan blocks" }, { status: 500 });
    }

    const orderedBlocks = [...((originalBlocks ?? []) as StoredPlanBlock[])].sort(
      (blockA, blockB) => blockA.start_offset - blockB.start_offset,
    );
    const originalIds = orderedBlocks.map((block) => block.id);
    const originalIdSet = new Set(originalIds);
    const finalSet = new Set(final_block_ids);

    if (finalSet.size !== final_block_ids.length) {
      return NextResponse.json({ error: "final_block_ids contains duplicates" }, { status: 400 });
    }

    const unknownIds = final_block_ids.filter((id) => !originalIdSet.has(id));
    if (unknownIds.length > 0) {
      return NextResponse.json({ error: "final_block_ids contains unknown block ids" }, { status: 400 });
    }

    const removedIds = originalIds.filter((id) => !finalSet.has(id));
    const keptOriginalIds = originalIds.filter((id) => finalSet.has(id));
    const reorderedKeptBlocks = keptOriginalIds.some((id, index) => final_block_ids[index] !== id);
    reordered = reorderedKeptBlocks;
    edited = removedIds.length > 0 || reorderedKeptBlocks;

    // Delete removed blocks — these represent consistently-cut work
    if (removedIds.length > 0) {
      await supabase.from("plan_blocks").delete().in("id", removedIds);
    }

    if (final_block_ids.length > 0) {
      const blockById = new Map(orderedBlocks.map((block) => [block.id, block]));
      let nextOffset = 0;

      for (const blockId of final_block_ids) {
        const block = blockById.get(blockId);
        if (!block) {
          continue;
        }

        const { error: updateBlockError } = await supabase
          .from("plan_blocks")
          .update({ start_offset: nextOffset })
          .eq("id", blockId)
          .eq("plan_session_id", sessionId);

        if (updateBlockError) {
          return NextResponse.json({ error: "Failed to update accepted plan order" }, { status: 500 });
        }

        nextOffset += block.duration_minutes;
      }
    }
  }

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
      blocks_reordered: accepted ? reordered : false,
    },
  });

  // Phase 7.2 — recompute scores when a plan is accepted (new signal available)
  if (accepted) {
    void computeWorkspaceScores({
      workspaceId: session.workspace_id as string,
      userId: user.id,
      supabase,
    });
  }

  return NextResponse.json({ status: newStatus, edited });
}
