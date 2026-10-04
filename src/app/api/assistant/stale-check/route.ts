// POST /api/assistant/stale-check — "Does this still matter?" for the Planner
// screen: work the user planned and skipped on 2+ days with no deadline
// (lib/planner/skips.ts). Same list Focus gets from the daily brief. SQL only,
// $0 — the question is deterministic, no model call.

import { NextRequest, NextResponse } from "next/server";

import { buildPlannerCandidates } from "@/lib/ai/planner";
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
  const { workspace_id, client_today, client_tz_offset } = body as {
    workspace_id?: string;
    client_today?: string;
    client_tz_offset?: number;
  };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const bundle = await buildPlannerCandidates({
    workspaceId: workspace_id,
    userId: user.id,
    supabase,
    clientToday: client_today,
    clientTzOffsetMinutes: client_tz_offset,
  });
  return NextResponse.json({ items: bundle.stale_check });
}
