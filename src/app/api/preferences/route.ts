// /api/preferences — the user's standing preferences (docs/preferences.md).
//   GET    → { preferences: [{ id, label, detail, kind }] } for the settings list
//   DELETE ?id=… → forgets one (the settings list's ×)
//   POST   { undo } → the Undo on a "Preference saved" card (set_preferences)
// Only ever touches the signed-in user's own list.

import { NextRequest, NextResponse } from "next/server";

import { undoPreferenceChanges } from "@/lib/ai/tools/preference-mutations";
import { loadPreferences, savePreferences } from "@/lib/planner/preference-store";
import { describePreference, parsePreferenceUndo, preferenceLabel } from "@/lib/planner/preferences";
import { getSupabaseServerClient } from "@/lib/supabase/server";

async function signedIn() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

export async function GET() {
  const auth = await signedIn();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const list = await loadPreferences(auth.userId, auth.supabase);
  return NextResponse.json({
    preferences: list.map((p) => ({ id: p.id, kind: p.kind, label: preferenceLabel(p), detail: describePreference(p) })),
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await signedIn();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const list = await loadPreferences(auth.userId, auth.supabase);
  if (!list.some((p) => p.id === id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const saved = await savePreferences(
    auth.userId,
    list.filter((p) => p.id !== id),
    auth.supabase,
  );
  return saved.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: saved.error }, { status: 500 });
}

export async function POST(req: NextRequest) {
  const auth = await signedIn();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parsePreferenceUndo((body as { undo?: unknown } | null)?.undo);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = await undoPreferenceChanges(auth, parsed.undo);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
