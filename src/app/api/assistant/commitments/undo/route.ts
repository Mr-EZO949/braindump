// POST /api/assistant/commitments/undo — the Undo on an applied commitments
// card. Body: { workspace_id, undo } where `undo` is the snapshot
// set_commitments returned. Validated (parseCommitmentUndo); only ever touches
// this user's commitments. A dump's "Your week" card can also carry the
// standing preferences it saved (`undo.preferences`, docs/preferences.md) —
// one Undo puts both back.

import { NextRequest, NextResponse } from "next/server";

import { undoCommitmentChanges } from "@/lib/ai/tools/commitment-mutations";
import { undoPreferenceChanges } from "@/lib/ai/tools/preference-mutations";
import { parseCommitmentUndo } from "@/lib/planner/commitment-changes";
import { parsePreferenceUndo } from "@/lib/planner/preferences";
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

  const { workspace_id, undo } = body as { workspace_id?: string; undo?: unknown };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  const raw = (undo ?? {}) as { created?: unknown[]; before?: unknown[]; preferences?: unknown };
  const hasCommitments = (raw.created?.length ?? 0) > 0 || (raw.before?.length ?? 0) > 0;
  const prefs = raw.preferences === undefined ? null : parsePreferenceUndo(raw.preferences);
  if (prefs && !prefs.ok) {
    return NextResponse.json({ error: prefs.error }, { status: 400 });
  }
  const parsed = hasCommitments || !prefs ? parseCommitmentUndo(undo) : null;
  if (parsed && !parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const errors: string[] = [];
  if (parsed?.ok) {
    const result = await undoCommitmentChanges(
      { supabase, userId: user.id, workspaceId: workspace_id, selectedNodeId: null },
      parsed.undo,
    );
    if (!result.ok) errors.push(result.error);
  }
  if (prefs?.ok) {
    const result = await undoPreferenceChanges({ supabase, userId: user.id }, prefs.undo);
    if (!result.ok) errors.push(result.error);
  }
  return errors.length > 0
    ? NextResponse.json({ ok: false, error: errors.join("; ") }, { status: 422 })
    : NextResponse.json({ ok: true });
}
