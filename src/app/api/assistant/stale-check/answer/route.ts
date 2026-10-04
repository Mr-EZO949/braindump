// POST /api/assistant/stale-check/answer — one answer on the "Does this still
// matter?" card, or its Undo. $0, no model call.
//
//   still_matters → back to normal rank: the skip count restarts now, no push.
//   not_now       → "can wait" through the priority engine (a decaying demote,
//                   like chat's update_priorities), and the count restarts.
//   drop          → archived through the priority engine.
//   undo          → puts back what the answer changed; the question returns.
//
// The answer is a feedback_events row (lib/planner/skips.ts) — no migration.

import { NextRequest, NextResponse } from "next/server";

import { applyPriorityChanges, undoPriorityChanges } from "@/lib/ai/tools/priority-mutations";
import { parsePriorityUndo, type PriorityUndo } from "@/lib/graph/priority-changes";
import {
  STALE_CHECK_ENTITY,
  STALE_CHECK_EVENT,
  isStaleAnswer,
  type StaleAnswer,
} from "@/lib/planner/skips";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isISODate } from "@/lib/time/local-date";
import { getRequestToday } from "@/lib/time/request-date";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PRIORITY_ACTION: Partial<Record<StaleAnswer, "deprioritize" | "drop">> = {
  not_now: "deprioritize",
  drop: "drop",
};

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
  const { workspace_id, node_id, answer, skipped_on, undo, client_today } = body as {
    workspace_id?: string;
    node_id?: string;
    answer?: string;
    skipped_on?: unknown;
    undo?: { marker_id?: unknown; priority?: unknown };
    client_today?: string;
  };
  if (!workspace_id || typeof node_id !== "string" || !UUID_RE.test(node_id)) {
    return NextResponse.json({ error: "workspace_id and node_id are required" }, { status: 400 });
  }
  if (answer !== "undo" && !isStaleAnswer(answer)) {
    return NextResponse.json({ error: "answer must be still_matters, not_now, drop or undo" }, { status: 400 });
  }

  // The node must be this user's, in this workspace (RLS scopes it too).
  const { data: node } = await supabase
    .from("nodes")
    .select("id, title")
    .eq("id", node_id)
    .eq("user_id", user.id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();
  if (!node) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }

  const today = isISODate(client_today) ? client_today : await getRequestToday();
  const ctx = { supabase, userId: user.id, workspaceId: workspace_id, selectedNodeId: null, today };
  const mark = (metadata: Record<string, unknown>) =>
    supabase
      .from("feedback_events")
      .insert({
        user_id: user.id,
        workspace_id,
        event_type: STALE_CHECK_EVENT,
        entity_type: STALE_CHECK_ENTITY,
        entity_id: node_id,
        metadata,
      })
      .select("id")
      .single();

  if (answer === "undo") {
    const markerId = typeof undo?.marker_id === "string" && UUID_RE.test(undo.marker_id) ? undo.marker_id : null;
    if (!markerId) {
      return NextResponse.json({ error: "undo.marker_id is required" }, { status: 400 });
    }
    if (undo?.priority) {
      const parsed = parsePriorityUndo(undo.priority);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      const restored = await undoPriorityChanges(ctx, parsed.undo);
      if (!restored.ok) return NextResponse.json({ error: restored.error }, { status: 422 });
    }
    const { error } = await mark({ answer: "undo", undoes: markerId });
    if (error) return NextResponse.json({ error: "Couldn't undo that" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // The answer first: if it can't be saved, nothing changes.
  const days = Array.isArray(skipped_on)
    ? skipped_on.filter((d): d is string => typeof d === "string" && DATE_RE.test(d)).slice(0, 14)
    : [];
  const { data: marker, error: markError } = await mark({ answer, skipped_on: days });
  if (markError || !marker) {
    return NextResponse.json({ error: "Couldn't save that" }, { status: 500 });
  }

  let priorityUndo: PriorityUndo | null = null;
  const action = PRIORITY_ACTION[answer as StaleAnswer];
  if (action) {
    const result = await applyPriorityChanges(ctx, {
      changes: [{ node_id, title: node.title, action, reason: "Does this still matter? — " + answer.replace("_", " ") }],
    });
    if (!result.accepted || !("undo" in result)) {
      // Take the answer back so the question stays open.
      await mark({ answer: "undo", undoes: marker.id });
      return NextResponse.json({ error: "error" in result ? result.error : "Couldn't apply that" }, { status: 422 });
    }
    priorityUndo = result.undo ?? null;
  }

  return NextResponse.json({
    ok: true,
    answer,
    undo: { marker_id: marker.id, ...(priorityUndo ? { priority: priorityUndo } : {}) },
  });
}
