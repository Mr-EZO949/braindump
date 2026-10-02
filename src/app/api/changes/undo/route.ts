// POST /api/changes/undo — the Undo on a turn card's sections (Added, Marked
// done, Linked) and on the rows a card's Accept applied.
// Body: { workspace_id, steps } where `steps` are the undo steps the change
// set recorded (lib/graph/change-undo.ts). They come back from the browser,
// so they are validated and only ever touch this user's rows in this
// workspace; scores are recomputed once at the end.

import { NextRequest, NextResponse } from "next/server";

import { recomputeScores } from "@/lib/graph/change-set";
import { parseUndoSteps, undoChangeSteps } from "@/lib/graph/change-undo";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestToday } from "@/lib/time/request-date";

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

  let body: { workspace_id?: unknown; steps?: unknown };
  try {
    body = (await req.json()) as { workspace_id?: unknown; steps?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const steps = parseUndoSteps(body.steps);
  if (steps.length === 0) {
    return NextResponse.json({ error: "Nothing to undo" }, { status: 400 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const ctx = { supabase, userId: user.id, workspaceId, today: await getRequestToday() };
  const result = await undoChangeSteps(ctx, steps);
  await recomputeScores(ctx);
  return NextResponse.json(result, { status: result.undone > 0 || result.failed.length === 0 ? 200 : 422 });
}
