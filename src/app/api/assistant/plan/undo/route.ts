// POST /api/assistant/plan/undo — "back to the earlier plan": the Undo on a
// replaced or rebuilt day plan (the Planner's banner and chat's replan card).
// Body: { workspace_id, undo: { replacement_id } } (chat's applied card) or
// { workspace_id, replacement_id } (the Planner). Only this user's rows.

import { NextRequest, NextResponse } from "next/server";

import { undoPlanReplacement } from "@/lib/planner/plan-replace";
import { planRequest } from "@/lib/planner/plan-route-scope";

export async function POST(req: NextRequest) {
  const request = await planRequest(req);
  if (request instanceof NextResponse) return request;
  const { scope, body } = request;
  const undo = (body.undo ?? {}) as { replacement_id?: unknown };
  const id = typeof undo.replacement_id === "string" ? undo.replacement_id : body.replacement_id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "replacement_id is required" }, { status: 400 });
  }
  const result = await undoPlanReplacement(scope, id);
  return result.ok
    ? NextResponse.json(result)
    : NextResponse.json({ error: result.error }, { status: result.status });
}
