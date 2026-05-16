// POST /api/nodes/[id]/archive
// Marks a node as archived — used when user resolves a duplicate merge suggestion.
// Archived nodes are excluded from the graph, embeddings search, and AI context.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("nodes")
    .update({ status: "archived", archived_at: nowIso })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Orphan every edge connected to this node so it doesn't dangle as an
  // active edge pointing at a now-hidden node (mirrors the lifecycle status
  // route — keep the two in sync).
  const { error: edgeError } = await supabase
    .from("edges")
    .update({ status: "orphaned", updated_at: nowIso })
    .eq("user_id", user.id)
    .or(`source_node_id.eq.${id},target_node_id.eq.${id}`);

  if (edgeError) {
    return NextResponse.json({ error: edgeError.message }, { status: 500 });
  }

  return NextResponse.json({ archived: true, node_id: id });
}
