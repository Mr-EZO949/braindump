// POST /api/proposals/nodes/undo
// One-tap Undo for auto-applied proposals (src/lib/ai/auto-apply.ts): deletes
// the nodes they created (edges, embeddings and lifecycle rows cascade) and
// marks the proposals REJECTED — so an Undo is a real signal that feeds the
// user's auto-apply calibration (undo a class often → it goes back to review).

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Undo is offered right after a dump; refuse to delete older work through it.
const UNDO_WINDOW_MS = 30 * 60 * 1000;
const MAX_IDS = 200;

export async function POST(req: NextRequest) {
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

  let body: { proposal_ids?: unknown };
  try {
    body = (await req.json()) as { proposal_ids?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.proposal_ids)
    ? body.proposal_ids.filter((id): id is string => typeof id === "string").slice(0, MAX_IDS)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "proposal_ids must be a non-empty array" }, { status: 400 });
  }

  const since = new Date(Date.now() - UNDO_WINDOW_MS).toISOString();
  const { data: proposals, error } = await supabase
    .from("proposed_nodes")
    .select("id, accepted_node_id")
    .in("id", ids)
    .eq("user_id", user.id)
    .eq("proposal_status", "accepted")
    .gte("created_at", since)
    .not("accepted_node_id", "is", null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const nodeIds = (proposals ?? []).map((p) => p.accepted_node_id as string);
  if (nodeIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("nodes")
      .delete()
      .in("id", nodeIds)
      .eq("user_id", user.id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    await supabase
      .from("proposed_nodes")
      .update({ proposal_status: "rejected", accepted_node_id: null })
      .in(
        "id",
        (proposals ?? []).map((p) => p.id as string),
      )
      .eq("user_id", user.id);
  }

  return NextResponse.json({ undone: nodeIds.length, node_ids: nodeIds });
}
