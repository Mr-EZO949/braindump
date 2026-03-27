// POST /api/proposals/edges/review
// Bulk accept or reject proposed edges.
// Accept: writes to canonical edges table + records feedback events.
// Reject: marks proposals rejected + records feedback events.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

interface ReviewAction {
  id: string; // proposed_edge id
  action: "accept" | "reject";
}

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { actions } = body as { actions: ReviewAction[] };
  if (!Array.isArray(actions) || actions.length === 0) {
    return NextResponse.json({ error: "actions must be a non-empty array" }, { status: 400 });
  }

  const ids = actions.map((a) => a.id);
  const { data: proposals, error: fetchError } = await supabase
    .from("proposed_edges")
    .select("id, workspace_id, source_node_id, target_node_id, edge_type")
    .in("id", ids)
    .eq("user_id", user.id)
    .eq("proposal_status", "pending_review");

  if (fetchError || !proposals) {
    return NextResponse.json({ error: "Failed to fetch proposals" }, { status: 500 });
  }

  const proposalMap = new Map(proposals.map((p) => [p.id as string, p]));
  const feedbackRows: unknown[] = [];

  // ---------------------------------------------------------------------------
  // Process accepts
  // ---------------------------------------------------------------------------
  const toAccept = actions.filter((a) => a.action === "accept");

  if (toAccept.length > 0) {
    const edgeRows = toAccept.flatMap((action) => {
      const proposal = proposalMap.get(action.id);
      if (!proposal) return [];
      return [{
        user_id: user.id,
        source_node_id: proposal.source_node_id as string,
        target_node_id: proposal.target_node_id as string,
        edge_type: proposal.edge_type as string,
      }];
    });

    if (edgeRows.length > 0) {
      const { error: insertError } = await supabase
        .from("edges")
        .insert(edgeRows);

      if (insertError) {
        return NextResponse.json(
          { error: "Failed to create edges", detail: insertError.message },
          { status: 500 }
        );
      }
    }

    await supabase
      .from("proposed_edges")
      .update({ proposal_status: "accepted" })
      .in("id", toAccept.map((a) => a.id))
      .eq("user_id", user.id);

    feedbackRows.push(
      ...toAccept.map((a) => ({
        user_id: user.id,
        workspace_id: proposalMap.get(a.id)?.workspace_id as string,
        event_type: "accept_edge",
        entity_type: "proposed_edge",
        entity_id: a.id,
        metadata: null,
      }))
    );
  }

  // ---------------------------------------------------------------------------
  // Process rejects
  // ---------------------------------------------------------------------------
  const toReject = actions.filter((a) => a.action === "reject");

  if (toReject.length > 0) {
    await supabase
      .from("proposed_edges")
      .update({ proposal_status: "rejected" })
      .in("id", toReject.map((a) => a.id))
      .eq("user_id", user.id);

    feedbackRows.push(
      ...toReject.map((a) => ({
        user_id: user.id,
        workspace_id: proposalMap.get(a.id)?.workspace_id as string,
        event_type: "reject_edge",
        entity_type: "proposed_edge",
        entity_id: a.id,
        metadata: null,
      }))
    );
  }

  if (feedbackRows.length > 0) {
    await supabase.from("feedback_events").insert(feedbackRows);
  }

  return NextResponse.json({
    accepted_count: toAccept.length,
    rejected_count: toReject.length,
  });
}
