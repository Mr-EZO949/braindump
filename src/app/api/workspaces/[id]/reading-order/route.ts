// PATCH /api/workspaces/[id]/reading-order
// Sets the narrative reading sequence for a workspace. Body: { orderedIds }.
// Nodes in the list get reading_order = 1..N in that order; every other node in
// the workspace is cleared to null (unordered). Reading order is deliberately
// independent of edges — this never touches edges, and Prev/Next only falls
// back to the strongest edge when a node has no order (see reading-view.ts).

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

const MAX_ORDERED = 2000;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orderedIdsRaw = (payload as { orderedIds?: unknown })?.orderedIds;
  if (
    !Array.isArray(orderedIdsRaw) ||
    orderedIdsRaw.some((entry) => typeof entry !== "string")
  ) {
    return NextResponse.json({ error: "orderedIds must be an array of strings" }, { status: 400 });
  }
  if (orderedIdsRaw.length > MAX_ORDERED) {
    return NextResponse.json({ error: `Too many nodes (max ${MAX_ORDERED})` }, { status: 413 });
  }

  // Only accept ids that actually belong to this user's workspace.
  const { data: workspaceNodes, error: fetchError } = await supabase
    .from("nodes")
    .select("id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId);

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const validIds = new Set((workspaceNodes ?? []).map((row) => (row as { id: string }).id));
  const seen = new Set<string>();
  const ordered = (orderedIdsRaw as string[]).filter(
    (nodeId) => validIds.has(nodeId) && !seen.has(nodeId) && (seen.add(nodeId), true),
  );

  // Clear the whole workspace first, then stamp the sequence. Two phases keeps
  // it simple without a bespoke SQL function; the set is idempotent on retry.
  const { error: clearError } = await supabase
    .from("nodes")
    .update({ reading_order: null })
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId);

  if (clearError) {
    return NextResponse.json({ error: clearError.message }, { status: 500 });
  }

  const results = await Promise.all(
    ordered.map((nodeId, index) =>
      supabase
        .from("nodes")
        .update({ reading_order: index + 1 })
        .eq("user_id", user.id)
        .eq("workspace_id", workspaceId)
        .eq("id", nodeId),
    ),
  );

  const failed = results.find((result) => result.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ordered_count: ordered.length });
}
