// Shared by the day-plan routes (/api/assistant/plan/commit, /replan, /undo):
// the signed-in user, their workspace, and the user's "today" and clock.
// Server-only.

import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isISODate, localMinuteOfDay } from "@/lib/time/local-date";
import { getRequestTimeZone, getRequestToday } from "@/lib/time/request-date";
import type { PlanScope } from "./plan-replace";

export interface PlanRequest {
  scope: PlanScope;
  body: Record<string, unknown>;
  today: string;
  nowMinute: number;
}

export async function planRequest(req: Request): Promise<PlanRequest | NextResponse> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
  if (!workspaceId) return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  // The browser's own clock wins (it is what the Planner shows); else the
  // time-zone cookie.
  const now = body.now_minute;
  const nowMinute =
    typeof now === "number" && Number.isFinite(now) && now >= 0 && now < 24 * 60
      ? Math.floor(now)
      : localMinuteOfDay(new Date(), await getRequestTimeZone());
  const today = isISODate(body.client_today) ? body.client_today : await getRequestToday();
  return { scope: { supabase, userId: user.id, workspaceId }, body, today, nowMinute };
}
