// POST /api/clustering/[id]/dismiss
// Marks a cluster suggestion as dismissed and records its signature_hash
// in dismissed_clusters so we never propose the same set of children
// again. Without this memory, every subsequent dump would re-surface the
// same group the user already rejected.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: suggestionId } = await params;
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

  const { data: suggestion } = await supabase
    .from("cluster_suggestions")
    .select("id, workspace_id, signature_hash, proposal_status")
    .eq("id", suggestionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!suggestion || suggestion.proposal_status !== "pending_review") {
    return NextResponse.json({ error: "Suggestion not found or already decided" }, { status: 404 });
  }

  await supabase
    .from("cluster_suggestions")
    .update({ proposal_status: "dismissed", decided_at: new Date().toISOString() })
    .eq("id", suggestionId);

  // Remember the signature so the same group never surfaces again.
  await supabase.from("dismissed_clusters").upsert(
    {
      user_id: user.id,
      workspace_id: suggestion.workspace_id,
      signature_hash: suggestion.signature_hash,
    },
    { onConflict: "user_id,workspace_id,signature_hash" },
  );

  return NextResponse.json({ ok: true });
}
