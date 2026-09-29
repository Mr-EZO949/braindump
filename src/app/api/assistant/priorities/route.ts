// POST /api/assistant/priorities — apply priority changes without a model.
// The same engine as chat's update_priorities (lib/ai/tools/priority-mutations),
// for one-tap buttons such as Focus's check-back card ("It's done" / "Still
// waiting"). Body: { workspace_id, changes: PriorityChange[] }. Returns the
// tool result, including the undo snapshot. $0 — no AI call.

import { NextRequest, NextResponse } from "next/server";

import { applyPriorityChanges } from "@/lib/ai/tools/priority-mutations";
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

  const { workspace_id, changes, client_today } = body as {
    workspace_id?: string;
    changes?: unknown;
    client_today?: string;
  };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const today = isISODate(client_today) ? client_today : await getRequestToday();
  const result = await applyPriorityChanges(
    { supabase, userId: user.id, workspaceId: workspace_id, selectedNodeId: null, today },
    { changes },
  );
  return NextResponse.json(result, { status: result.accepted ? 200 : 422 });
}
