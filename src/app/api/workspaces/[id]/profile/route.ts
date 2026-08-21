// GET / PATCH /api/workspaces/[id]/profile
//
// Reads and updates the "about you" profile the AI uses to tailor extraction,
// planning, and chat (role, current focus, big goals). Stored on the workspace
// as denormalized columns (profile_role, profile_summary) plus the full
// profile_payload jsonb. The bootstrap route is the only other writer; this is
// the edit path exposed in Settings.
//
// Ownership is enforced two ways: RLS on `workspaces` and an explicit
// `.eq("user_id", user.id)` on every query.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { WorkspaceProfile } from "@/types/graph";

export const runtime = "nodejs";

// Bounds — generous, just enough to stop abuse / runaway payloads.
const MAX_ROLE_CHARS = 200;
const MAX_FOCUS_CHARS = 400;
const MAX_GOALS = 8;
const MAX_GOAL_CHARS = 200;

type ProfileView = {
  role: string | null;
  current_focus: string | null;
  goals: string[];
};

function trimOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function normalizeGoals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const goals: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().slice(0, MAX_GOAL_CHARS);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    goals.push(trimmed);
    if (goals.length >= MAX_GOALS) break;
  }
  return goals;
}

// Reads the profile as the UI wants it, preferring the jsonb payload and
// falling back to the denormalized columns.
function toView(row: {
  profile_role: string | null;
  profile_summary: string | null;
  profile_payload: WorkspaceProfile | null;
}): ProfileView {
  const payload = row.profile_payload ?? null;
  return {
    role: payload?.role ?? row.profile_role ?? null,
    current_focus: payload?.current_focus ?? row.profile_summary ?? null,
    goals: Array.isArray(payload?.goals) ? payload!.goals : [],
  };
}

async function authWorkspace(id: string) {
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
  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("id, profile_role, profile_summary, profile_payload")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  }
  if (!workspace) {
    return { error: NextResponse.json({ error: "Workspace not found" }, { status: 404 }) };
  }
  return { supabase, user, workspace };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await authWorkspace(id);
  if (ctx.error) return ctx.error;
  return NextResponse.json(toView(ctx.workspace));
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await authWorkspace(id);
  if (ctx.error) return ctx.error;
  const { supabase, user, workspace } = ctx;

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

  const role = trimOrNull(input.role, MAX_ROLE_CHARS);
  const currentFocus = trimOrNull(input.current_focus, MAX_FOCUS_CHARS);
  const goals = normalizeGoals(input.goals);

  // Merge onto the existing payload so we never drop success_title / areas /
  // version that this editor doesn't surface.
  const existing = workspace.profile_payload ?? null;
  const nextPayload: WorkspaceProfile = {
    version: existing?.version ?? 1,
    role,
    current_focus: currentFocus,
    success_title: existing?.success_title ?? null,
    goals,
    areas: Array.isArray(existing?.areas) ? existing!.areas : [],
  };

  const { error } = await supabase
    .from("workspaces")
    .update({
      profile_role: role,
      profile_summary: currentFocus,
      profile_payload: nextPayload,
    })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ role, current_focus: currentFocus, goals } satisfies ProfileView);
}
