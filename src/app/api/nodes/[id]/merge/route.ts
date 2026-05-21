// POST /api/nodes/[id]/merge — Phase 11.4
// Safe merge: reattach edges from the new/duplicate node to the existing/canonical node,
// preserve merge provenance, archive the duplicate, then trigger a ranking recompute.
//
// Body: { target_node_id: string; suggestion_id?: string }
//   - id (URL param): the node being absorbed (typically the newer duplicate)
//   - target_node_id: the canonical node to keep
//   - suggestion_id: if provided, marks the merge_suggestion as merged
//
// Real merge logic lives in lib/graph/merge.ts so the chat-driven
// propose_merge tool can reuse it.

import { NextRequest, NextResponse } from "next/server";

import { mergeNodes } from "@/lib/graph/merge";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sourceNodeId } = await params;

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

  const { target_node_id, suggestion_id = null } = body as {
    target_node_id?: string;
    suggestion_id?: string | null;
  };

  if (!target_node_id || typeof target_node_id !== "string") {
    return NextResponse.json({ error: "target_node_id is required" }, { status: 400 });
  }

  const result = await mergeNodes(
    supabase,
    user.id,
    sourceNodeId,
    target_node_id,
    suggestion_id,
  );

  if (!result.ok) {
    return NextResponse.json(
      result.detail ? { error: result.error, detail: result.detail } : { error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json({
    kept_node_id: result.kept_node_id,
    archived_node_id: result.archived_node_id,
    edges_moved: result.edges_moved,
    edges_skipped: result.edges_skipped,
    provenance_relinked: result.provenance_relinked,
    recomputed_scores: result.recomputed_scores,
  });
}
