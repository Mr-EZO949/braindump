// GET / PATCH /api/profile
//
// The user-level "about you" identity captured at sign-up and reused across
// every workspace's AI context (name, occupation, what paralyzes you, working
// hours, deadline cadence). One row per user in `profiles`, created lazily on
// first PATCH. RLS scopes every read/write to the signed-in user; we also pass
// an explicit .eq("user_id") as defense in depth.
//
// Distinct from /api/workspaces/[id]/profile, which edits the WORKSPACE-level
// role/focus/goals.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { UserProfile } from "@/types/graph";

export const runtime = "nodejs";

// Generous bounds — just enough to stop runaway payloads.
const MAX = {
  full_name: 120,
  occupation: 160,
  paralysis_triggers: 600,
  working_hours: 300,
  deadline_cadence: 300,
} as const;

const PROFILE_COLUMNS =
  "full_name, occupation, paralysis_triggers, working_hours, deadline_cadence, intake_completed_at";

const EMPTY_PROFILE: UserProfile = {
  full_name: null,
  occupation: null,
  paralysis_triggers: null,
  working_hours: null,
  deadline_cadence: null,
  intake_completed_at: null,
};

function trimOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

async function authUser() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return { error: NextResponse.json({ error: "Server configuration error" }, { status: 500 }) };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { supabase, user };
}

export async function GET() {
  const ctx = await authUser();
  if (ctx.error) return ctx.error;
  const { supabase, user } = ctx;

  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json((data as UserProfile | null) ?? EMPTY_PROFILE);
}

export async function PATCH(req: NextRequest) {
  const ctx = await authUser();
  if (ctx.error) return ctx.error;
  const { supabase, user } = ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  const row: Record<string, unknown> = {
    user_id: user.id,
    full_name: trimOrNull(input.full_name, MAX.full_name),
    occupation: trimOrNull(input.occupation, MAX.occupation),
    paralysis_triggers: trimOrNull(input.paralysis_triggers, MAX.paralysis_triggers),
    working_hours: trimOrNull(input.working_hours, MAX.working_hours),
    deadline_cadence: trimOrNull(input.deadline_cadence, MAX.deadline_cadence),
    updated_at: new Date().toISOString(),
  };

  // The intake sets this on finish OR skip so the first-run gate won't re-fire.
  // Omitted on a plain Settings edit, so upsert leaves any existing value
  // untouched (unspecified columns aren't part of the ON CONFLICT update set).
  if (input.intake_done === true) {
    row.intake_completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("profiles")
    .upsert(row, { onConflict: "user_id" })
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json((data as UserProfile | null) ?? EMPTY_PROFILE);
}
