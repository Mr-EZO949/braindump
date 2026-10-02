// A change set waiting on a card, and what Accept does with it — shared by
// build_graph, change (tools/change.ts) and a brain dump's card (api/entries).

import { applyChangeSet, type ChangeOp } from "@/lib/graph/change-set";

import type { ToolContext } from "./read-only";

// What the card shows and the handler applies. `origin: "dump"` marks a set a
// brain dump asked for (api/entries) — its Accept never goes back to a model.
export interface BuildPlanInput {
  changes: ChangeOp[];
  questions?: string[];
  notes?: string[];
  origin?: "chat" | "dump";
  // The assistant's own idea (change with source "suggestion"): the card
  // says so, and nothing in it was asked for.
  suggested?: boolean;
}

// Applies an accepted plan. The confirmation is written here — counts, what
// didn't land, and the builder's open questions — so the usual Accept needs
// no follow-up model call.
export async function applyBuildPlan(
  plan: BuildPlanInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const { results, undo } = await applyChangeSet(ctx, plan.changes, {
    source: plan.origin === "dump" ? "dump" : "chat",
  });
  const okCount = results.filter((r) => r.ok).length;
  const failedCount = results.length - okCount;
  const questions = (plan.questions ?? []).filter((q) => typeof q === "string" && q.trim());
  const done = okCount === 1 ? "Done ✓" : `Applied ${okCount} changes ✓`;
  return {
    accepted: okCount > 0,
    applied: okCount,
    total: results.length,
    results,
    // For the card's Undo — the resume route takes it out before the model
    // sees the result (change-undo.ts).
    undo: undo.map((u) => u.step),
    // A partial failure goes back to the model (actionSucceeded reads
    // `error`) so it can say what didn't land instead of a bare "Done".
    ...(failedCount > 0
      ? { error: `${failedCount} of ${results.length} changes failed — see results` }
      : { message: questions.length > 0 ? `${done}\n\n${questions.join("\n")}` : done }),
  };
}

