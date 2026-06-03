// GET /api/nudges
// Returns the user's pending nudges, newest first. Used by the in-app
// ribbon to know what to show.

import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowIso = new Date().toISOString();

  // Pending + snoozed-past-due both surface. snoozed_until > now stays hidden.
  const { data, error } = await supabase
    .from("nudges")
    .select(
      "id, kind, title, body, node_id, workspace_id, status, snoozed_until, created_at",
    )
    .eq("user_id", user.id)
    .or(`status.eq.pending,and(status.eq.snoozed,snoozed_until.lte.${nowIso})`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ nudges: data ?? [] });
}
