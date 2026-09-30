// POST /api/assistant/commitments/undo — the Undo on an applied commitments
// card. Body: { workspace_id, undo } where `undo` is the snapshot
// set_commitments returned. Validated (parseCommitmentUndo); only ever touches
// this user's commitments.

import { NextRequest, NextResponse } from "next/server";

import { undoCommitmentChanges } from "@/lib/ai/tools/commitment-mutations";
import { parseCommitmentUndo } from "@/lib/planner/commitment-changes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspace_id, undo } = body as { workspace_id?: string; undo?: unknown };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const parsed = parseCommitmentUndo(undo);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await undoCommitmentChanges(
    { supabase, userId: user.id, workspaceId: workspace_id, selectedNodeId: null },
    parsed.undo,
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
