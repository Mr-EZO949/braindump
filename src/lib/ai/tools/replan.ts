// replan_today — "I went off schedule", "I missed the gym", "running 2h late",
// "plans changed, redo my afternoon" (#27, docs/replan.md).
//
// A DIRECT tool like update_priorities: it is the user's own request, so it
// applies at once and the card carries an Undo ("back to the earlier plan").
// Today's unfinished plan tasks are kept and re-timed from now around fixed
// commitments; ticked ones stay; what they missed leaves today's plan — a
// habit recorded as missed, never done. No model call ($0): the plan the user
// already accepted is the plan. No plan today → the model plans with plan_day.

import { replanCardRows, replanToday } from "@/lib/planner/plan-replace";
import { clockToMinutes } from "@/lib/planner/replan";
import { localDateISO, localMinuteOfDay } from "@/lib/time/local-date";
import { getRequestTimeZone } from "@/lib/time/request-date";
import type { ToolContext, ToolDefinition } from "./read-only";

export const REPLAN_TOOL = "replan_today";

export const REPLAN_TODAY: ToolDefinition = {
  schema: {
    name: REPLAN_TOOL,
    description:
      "Rebuild the rest of TODAY's plan from now when they went off schedule, missed something, are running late or their plans changed. Keeps the unfinished blocks, re-timed around fixed commitments; ticked ones stay. Applies at once with Undo. Only when Today's plan exists — else plan_day.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["user", "suggestion"],
          description: "user = they asked or said they went off schedule. suggestion = your idea.",
        },
        missed: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description:
            "Ids of what they say they missed or are dropping today — a habit they missed (the gym), a task only if they drop it for today. Not done, never completed. Everything else unfinished is kept.",
        },
        start_time: { type: "string", description: "24h HH:MM, only when they say when they can restart (\"from 3pm\")" },
      },
      required: ["source"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as { missed?: unknown; start_time?: unknown };
    const timeZone = await getRequestTimeZone();
    const today = ctx.today ?? localDateISO(new Date(), timeZone);
    const outcome = await replanToday(
      { supabase: ctx.supabase, userId: ctx.userId, workspaceId: ctx.workspaceId },
      {
        today,
        nowMinute: localMinuteOfDay(new Date(), timeZone),
        startMinute: clockToMinutes(typeof args.start_time === "string" ? args.start_time : null),
        missed: Array.isArray(args.missed) ? args.missed.filter((m): m is string => typeof m === "string") : [],
      },
    );
    if (!outcome.ok) {
      return {
        accepted: false,
        error:
          outcome.reason === "no_plan"
            ? "Today has no plan to rebuild — plan the rest of today with plan_day (window day)."
            : `Couldn't rebuild today's plan: ${outcome.error}`,
      };
    }
    const applied = replanCardRows(outcome);
    const { placed, missed, didntFit } = outcome.result;
    return {
      accepted: true,
      applied,
      failed: [],
      message:
        `Rebuilt the rest of today: ${placed.length} kept${missed.length > 0 ? `, ${missed.length} off today` : ""}` +
        (didntFit.length > 0 ? `, didn't fit: ${didntFit.map((t) => t.title).join(", ")}` : "") +
        ". The card shows every new time — reply in one short line at most, never list times or items.",
      undo: { replacement_id: outcome.replacementId },
    };
  },
};

export const REPLAN_TOOLS: ToolDefinition[] = [REPLAN_TODAY];
