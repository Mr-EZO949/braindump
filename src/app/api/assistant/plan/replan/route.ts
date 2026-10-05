// POST /api/assistant/plan/replan — the Planner's "Replan from now" (and the
// same path as chat's replan_today): today's unfinished plan tasks, re-timed
// from now around fixed commitments; ticked ones stay; what can't fit before
// the day ends drops, undated work first. Deterministic — no model call, $0.
// Responds with the Undo handle (docs/replan.md).
//
// Body: { workspace_id, now_minute?, client_today?, missed?: string[] }

import { NextRequest, NextResponse } from "next/server";

import { replanCardRows, replanToday } from "@/lib/planner/plan-replace";
import { planRequest } from "@/lib/planner/plan-route-scope";

export async function POST(req: NextRequest) {
  const request = await planRequest(req);
  if (request instanceof NextResponse) return request;
  const { scope, body, today, nowMinute } = request;

  const missed = Array.isArray(body.missed) ? body.missed.filter((m): m is string => typeof m === "string") : [];
  const outcome = await replanToday(scope, { today, nowMinute, missed });
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.reason === "no_plan" ? "There's no plan for today to rebuild." : outcome.error },
      { status: outcome.reason === "no_plan" ? 422 : 500 },
    );
  }
  return NextResponse.json({
    replacement: outcome.replacementId ? { id: outcome.replacementId, date: today } : null,
    rows: replanCardRows(outcome),
    moved: outcome.result.placed.length,
    missed: outcome.result.missed.length,
    didnt_fit: outcome.result.didntFit.map((t) => t.title),
  });
}
