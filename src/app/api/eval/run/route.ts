// POST /api/eval/run — dev only. Runs the eval fixtures (src/lib/ai/eval/)
// through the real prompts and returns the report: pass rate per check, the
// failures, the measured cost. Writes nothing.
//
// The usual way to run it is the script, which needs no dev server:
//   npx tsx --env-file=.env.local scripts/eval-run.ts
//
// Query params:
//   suite     builder | edges | merge | planner | all (default), comma-separated
//   only      fixture ids, comma-separated
//   max_cost  USD cap; the run stops before a fixture that would cross it (default 0.25)

import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_MAX_COST_USD, EVAL_SUITES, runEval, type EvalSuite } from "@/lib/ai/eval/run";

export const maxDuration = 300;

function list(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const requested = list(params.get("suite"));
  const suites =
    requested.length === 0 || requested.includes("all")
      ? [...EVAL_SUITES]
      : requested.filter((s): s is EvalSuite => (EVAL_SUITES as readonly string[]).includes(s));
  if (suites.length === 0) {
    return NextResponse.json({ error: `suite must be one of: all, ${EVAL_SUITES.join(", ")}` }, { status: 400 });
  }
  const maxCost = Number(params.get("max_cost"));

  const report = await runEval({
    suites,
    only: list(params.get("only")),
    maxCostUSD: Number.isFinite(maxCost) && maxCost > 0 ? maxCost : DEFAULT_MAX_COST_USD,
  });
  return NextResponse.json(report);
}
