// POST /api/assistant/priorities/undo — the Undo on an applied priority card.
// Body: { workspace_id, undo } where `undo` is the snapshot update_priorities
// returned. It is validated (parsePriorityUndo) and only ever touches this
// user's nodes in this workspace; statuses go back through the status engine.

import { NextRequest, NextResponse } from "next/server";

import { undoPriorityChanges } from "@/lib/ai/tools/priority-mutations";
import { parsePriorityUndo } from "@/lib/graph/priority-changes";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isISODate } from "@/lib/time/local-date";
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspace_id, undo, client_today } = body as {
    workspace_id?: string;
    undo?: unknown;
    client_today?: string;
  };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const parsed = parsePriorityUndo(undo);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const today = isISODate(client_today) ? client_today : await getRequestToday();
  const result = await undoPriorityChanges(
    { supabase, userId: user.id, workspaceId: workspace_id, selectedNodeId: null, today },
    parsed.undo,
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
