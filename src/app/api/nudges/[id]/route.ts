// PATCH /api/nudges/[id]
// Update a nudge's status. The ribbon calls this when the user dismisses,
// snoozes, marks it seen on view, or actions it (opens the linked node).

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NudgeStatus = "seen" | "snoozed" | "dismissed" | "actioned";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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

  let body: { status?: NudgeStatus; snoozed_until?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { status, snoozed_until } = body;
  const VALID: NudgeStatus[] = ["seen", "snoozed", "dismissed", "actioned"];
  if (!status || !VALID.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID.join(", ")}` },
      { status: 400 },
    );
  }

  if (status === "snoozed" && !snoozed_until) {
    return NextResponse.json(
      { error: "snoozed_until required when status='snoozed'" },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "snoozed") update.snoozed_until = snoozed_until;
  else update.snoozed_until = null;

  const { error } = await supabase
    .from("nudges")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status });
}
