// POST /api/nodes/[id]/archive
// Marks a node as archived — used when user resolves a duplicate merge suggestion.
// Archived nodes are excluded from the graph, embeddings search, and AI context.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { getRequestToday } from "@/lib/time/request-date";

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

  // Same transition as every other status change (orphans edges, logs
  // lifecycle + feedback events) — src/lib/graph/status-transition.ts.
  const result = await transitionNodeStatus({
    supabase,
    userId: user.id,
    nodeId: id,
    newStatus: "archived",
    today: await getRequestToday(),
  });
  if (result.kind === "error") {
    return NextResponse.json({ error: result.error }, { status: result.httpStatus });
  }

  return NextResponse.json({ archived: true, node_id: id });
}
