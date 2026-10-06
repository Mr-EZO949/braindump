// Planner-side mutation tools. Same Accept-gated pause flow as the
// node/edge mutations in ./mutations.ts, but these operate on plan_tasks
// (the lightweight manual task calendar). The AI planner's session/block
// model stays behind the existing /api/plan endpoints — these tools cover
// the "jot one task on my calendar" path that comes up naturally in chat.

import type { ToolContext, ToolDefinition } from "./read-only";
import { buildPlannerCandidates } from "../planner";
import { aiProvider } from "../index";
import { persistAIRun } from "../telemetry";
import { PLAN_PROMPT_VERSION } from "../prompts/plan";
import { normalizeAIError, PLAN_CUT_OFF_MESSAGE } from "../errors";
import {
  PLAN_MAX_MINUTES,
  clampPlanMinutes,
  describeSessionSpan,
  planWindowMinutes,
} from "@/lib/planner/plan-window";
import {
  busyOn,
  busyWithin,
  minutesToTime,
  nextSessionStartMinute,
  oneOffBusy,
  sessionBusyNote,
  timeToMinutes,
  withoutSaved,
} from "@/lib/planner/commitments";
import { pinFromMessage } from "@/lib/planner/plan-requests";
import { resolveRelativeDay } from "@/lib/time/relative-day";
import { DAY_PLAN_START_MINUTE } from "@/lib/planner/plan-window";
import { localDateISO, localMinuteOfDay } from "@/lib/time/local-date";
import { getRequestTimeZone } from "@/lib/time/request-date";
import {
  BUDGET_MIN_SESSION_MINUTES,
  budgetRequestsFor,
  planningPreferenceLines,
  workdayEndMinute,
} from "@/lib/planner/preferences";
import { loadPreferences } from "@/lib/planner/preference-store";

// YYYY-MM-DD. Postgres `date` parses a broader set, but we want Claude to
// emit ISO dates consistently so the UI formats them predictably.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// HH:MM in 24h. seconds optional so Claude can emit either 09:30 or 09:30:00.
const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/;

function normaliseTime(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}

async function fetchWorkspaceTask(
  ctx: ToolContext,
  taskId: string,
): Promise<{ id: string; title: string; done: boolean } | null> {
  const { data } = await ctx.supabase
    .from("plan_tasks")
    .select("id, title, done")
    .eq("id", taskId)
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  return (data as { id: string; title: string; done: boolean } | null) ?? null;
}

// ---------------------------------------------------------------------------
// add_task_to_calendar
// ---------------------------------------------------------------------------

const ADD_TASK_TO_CALENDAR: ToolDefinition = {
  schema: {
    name: "add_task_to_calendar",
    description:
      "Put a one-off task on the user's calendar for a date, with optional start time and duration; link node_id so completing it completes the node. Waits for Accept.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Max 200 chars" },
        scheduled_date: { type: "string", description: "YYYY-MM-DD; omitted = unscheduled" },
        start_time: { type: "string", description: "HH:MM 24h" },
        duration_minutes: { type: "integer", minimum: 5, maximum: 600 },
        node_id: { type: "string", description: "The node this task maps to" },
      },
      required: ["title"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      title?: string;
      scheduled_date?: string;
      start_time?: string;
      duration_minutes?: number;
      node_id?: string;
    };
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { accepted: false, error: "title is required" };
    if (title.length > 200) {
      return { accepted: false, error: "title must be ≤200 chars" };
    }

    if (typeof args.scheduled_date === "string" && !DATE_RE.test(args.scheduled_date)) {
      return { accepted: false, error: "scheduled_date must be YYYY-MM-DD" };
    }
    if (typeof args.start_time === "string" && !TIME_RE.test(args.start_time)) {
      return { accepted: false, error: "start_time must be HH:MM" };
    }

    let nodeId: string | null = null;
    if (typeof args.node_id === "string" && args.node_id.length > 0) {
      const { data: node } = await ctx.supabase
        .from("nodes")
        .select("id")
        .eq("id", args.node_id)
        .eq("user_id", ctx.userId)
        .eq("workspace_id", ctx.workspaceId)
        .maybeSingle();
      if (!node) {
        return { accepted: false, error: "node_id not found in this workspace" };
      }
      nodeId = node.id as string;
    }

    const insertRow: Record<string, unknown> = {
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      title,
      done: false,
    };
    if (typeof args.scheduled_date === "string") {
      insertRow.scheduled_date = args.scheduled_date;
    }
    if (typeof args.start_time === "string") {
      insertRow.start_time = normaliseTime(args.start_time);
    }
    if (typeof args.duration_minutes === "number") {
      insertRow.duration_minutes = Math.max(5, Math.min(600, Math.round(args.duration_minutes)));
    }
    if (nodeId) insertRow.node_id = nodeId;

    const { data: task, error } = await ctx.supabase
      .from("plan_tasks")
      .insert(insertRow)
      .select("id, title, scheduled_date, start_time, duration_minutes, node_id")
      .single();

    if (error || !task) {
      return { accepted: false, error: `Failed to add task: ${error?.message ?? "unknown error"}` };
    }
    return {
      accepted: true,
      task_id: task.id,
      title: task.title,
      scheduled_date: task.scheduled_date,
      start_time: task.start_time,
      duration_minutes: task.duration_minutes,
      node_id: task.node_id,
    };
  },
};

// ---------------------------------------------------------------------------
// reschedule_task
// ---------------------------------------------------------------------------

const RESCHEDULE_TASK: ToolDefinition = {
  schema: {
    name: "reschedule_task",
    description:
      "Move a calendar task to another date, time or duration — only the fields that change. Waits for Accept.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        scheduled_date: { type: "string", description: "YYYY-MM-DD; empty string clears it" },
        start_time: { type: "string", description: "HH:MM 24h; empty string clears it" },
        duration_minutes: { type: "integer", minimum: 5, maximum: 600 },
      },
      required: ["task_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      task_id?: string;
      scheduled_date?: string;
      start_time?: string;
      duration_minutes?: number;
    };
    const taskId = typeof args.task_id === "string" ? args.task_id : "";
    if (!taskId) return { accepted: false, error: "task_id is required" };

    const task = await fetchWorkspaceTask(ctx, taskId);
    if (!task) return { accepted: false, error: "task_id not found in this workspace" };

    const patch: Record<string, unknown> = {};
    if (typeof args.scheduled_date === "string") {
      if (args.scheduled_date === "") {
        patch.scheduled_date = null;
      } else if (!DATE_RE.test(args.scheduled_date)) {
        return { accepted: false, error: "scheduled_date must be YYYY-MM-DD" };
      } else {
        patch.scheduled_date = args.scheduled_date;
      }
    }
    if (typeof args.start_time === "string") {
      if (args.start_time === "") {
        patch.start_time = null;
      } else if (!TIME_RE.test(args.start_time)) {
        return { accepted: false, error: "start_time must be HH:MM" };
      } else {
        patch.start_time = normaliseTime(args.start_time);
      }
    }
    if (typeof args.duration_minutes === "number") {
      patch.duration_minutes = Math.max(5, Math.min(600, Math.round(args.duration_minutes)));
    }
    if (Object.keys(patch).length === 0) {
      return { accepted: false, error: "no fields provided to update" };
    }

    const { data: updated, error } = await ctx.supabase
      .from("plan_tasks")
      .update(patch)
      .eq("id", taskId)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .select("id, title, scheduled_date, start_time, duration_minutes")
      .single();

    if (error || !updated) {
      return { accepted: false, error: `Failed to reschedule: ${error?.message ?? "unknown error"}` };
    }
    return {
      accepted: true,
      task_id: updated.id,
      title: updated.title,
      scheduled_date: updated.scheduled_date,
      start_time: updated.start_time,
      duration_minutes: updated.duration_minutes,
    };
  },
};

// ---------------------------------------------------------------------------
// mark_task_done
// ---------------------------------------------------------------------------

const MARK_TASK_DONE: ToolDefinition = {
  schema: {
    name: "mark_task_done",
    description:
      "Mark a calendar task done (or not done) when they say they finished it. Waits for Accept.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        done: { type: "boolean", description: "Default true" },
      },
      required: ["task_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as { task_id?: string; done?: boolean };
    const taskId = typeof args.task_id === "string" ? args.task_id : "";
    if (!taskId) return { accepted: false, error: "task_id is required" };

    const task = await fetchWorkspaceTask(ctx, taskId);
    if (!task) return { accepted: false, error: "task_id not found in this workspace" };

    const targetState = typeof args.done === "boolean" ? args.done : true;
    if (task.done === targetState) {
      return { accepted: true, task_id: taskId, already: targetState };
    }

    const { error } = await ctx.supabase
      .from("plan_tasks")
      .update({ done: targetState })
      .eq("id", taskId)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) {
      return { accepted: false, error: `Failed to update task: ${error.message}` };
    }
    return { accepted: true, task_id: taskId, done: targetState, title: task.title };
  },
};

// ---------------------------------------------------------------------------
// plan_day — build a full time-blocked plan from active work items + draft it in
// the Planner for review. Mirrors /api/assistant/plan (candidates → LLM plan →
// persist draft) so chat can finally *plan*, not just hand off to the Planner.
// ---------------------------------------------------------------------------

const PLAN_DAY: ToolDefinition = {
  schema: {
    name: "plan_day",
    description:
      "Draft a time-blocked plan from their active work in the Planner, for review. Saved weekly commitments are planned around; anything else at a clock time that day (\"lectures 2:30–6:30\", \"dentist at 4\", \"mealprep from 12:30 for 1.5h\") goes in busy — it shows on the plan at that time; plan right away, don't ask whether it repeats. Things to fit in without a time go in include, even ones not in the graph. It avoids only what is saved or passed here; never say otherwise. Waits for Accept.",
    input_schema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          enum: ["1h", "2h", "day", "custom"],
          description: "day = from start_time (or now) to end_time or 23:00; 1h / 2h = short sessions; custom = a span they name",
        },
        day: {
          type: "string",
          description: "Their words for another day (\"tomorrow\", \"wednesday\"); omitted = today",
        },
        start_time: {
          type: "string",
          description: "24h HH:MM, only when they say it (\"from 8am\" → \"08:00\"); omitted = now (08:00 on another day)",
        },
        end_time: {
          type: "string",
          description: "24h HH:MM when they name an end (\"until 11pm\" / \"to 11\" in the evening → \"23:00\"); the length is worked out from it",
        },
        custom_minutes: {
          type: "integer",
          minimum: 15,
          maximum: PLAN_MAX_MINUTES,
          description: "Only for a length with no end time (\"plan 3 hours\" = 180)",
        },
        note: {
          type: "string",
          description: "What they said about the day that should shape it — health, energy, mood (\"sick, not much deep work\")",
        },
        include: {
          type: "string",
          description: "What they asked to fit in, their words with lengths (\"3h of Italian, 2h of math\")",
        },
        busy: {
          type: "array",
          maxItems: 8,
          description: "Busy times today they named that aren't saved commitments, 24h HH:MM",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              start: { type: "string" },
              end: { type: "string" },
            },
            required: ["start", "end"],
          },
        },
      },
      required: ["window"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      window?: string;
      custom_minutes?: number;
      start_time?: string;
      end_time?: string;
      day?: string;
      note?: string;
      busy?: unknown;
      include?: string;
    };
    let window = (["1h", "2h", "day", "custom"].includes(args.window ?? "")
      ? args.window
      : "day") as "1h" | "2h" | "day" | "custom";

    // Standing preferences (docs/preferences.md): the user's end of work
    // shortens a day, their daily budgets go in as requests on a long plan,
    // best hours / rules ride along as context — with the "About you" working
    // hours, which the chat planner used to skip.
    const today = ctx.today ?? localDateISO(new Date(), null);
    // "plan wednesday": the day is resolved here, not by the model; until
    // 10-06 a plan for tomorrow saw today's weekly times.
    const planDate = (typeof args.day === "string" && resolveRelativeDay(args.day, today)) || today;
    const startMinute =
      timeToMinutes(args.start_time) ??
      (planDate === today
        ? nextSessionStartMinute(localMinuteOfDay(new Date(), await getRequestTimeZone()))
        : DAY_PLAN_START_MINUTE);
    // "until 11pm": the length comes from the end time — Haiku made 12:30 →
    // 23:00 570 minutes (owner 10-06).
    const endMinute = timeToMinutes(args.end_time);
    let customMinutes = window === "custom" ? clampPlanMinutes(args.custom_minutes ?? 60) : null;
    if (endMinute !== null && endMinute > startMinute) {
      window = "custom";
      customMinutes = clampPlanMinutes(endMinute - startMinute);
    }
    const [preferences, profile] = await Promise.all([
      loadPreferences(ctx.userId, ctx.supabase),
      ctx.supabase.from("profiles").select("working_hours").eq("user_id", ctx.userId).maybeSingle(),
    ]);
    const sessionMinutes = planWindowMinutes(window, customMinutes, startMinute, workdayEndMinute(preferences));
    // Timed items — in include, or given a time in the user's own words — are
    // fixed time; the rest is what to fit in.
    const pinned = pinFromMessage(typeof args.include === "string" ? args.include.slice(0, 400) : null, ctx.userMessage);
    const include = pinned.include;

    const bundle = await buildPlannerCandidates({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      supabase: ctx.supabase,
      clientToday: ctx.today,
      include,
      preferences,
      budgetRequests:
        sessionMinutes >= BUDGET_MIN_SESSION_MINUTES
          ? budgetRequestsFor({ prefs: preferences, dateISO: planDate, sessionMinutes, include })
          : [],
    });
    if (!bundle.candidates.length && !bundle.time_blocks.length) {
      return { accepted: false, error: "No active work items to plan — add a few tasks or goals first." };
    }
    const workingHours = (profile.data as { working_hours?: string | null } | null)?.working_hours?.trim();
    const standing = planningPreferenceLines(preferences, planDate);
    const note = typeof args.note === "string" ? args.note.trim().slice(0, 200) : "";
    const workspaceContext = [
      workingHours ? `Working hours / energy: ${workingHours.slice(0, 200)}` : null,
      standing.length > 0 ? `Standing preferences (the user's own): ${standing.join(" ")}` : null,
      note ? `The user about today: ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Plan only the free time of the session: today's saved commitments plus
    // the busy time the user named in chat. The session starts where Accept
    // will put it in the Planner — the user's start_time, else "now" (rounded
    // as the Planner rounds); a day runs on to 23:00 (lib/planner/plan-window).
    // Until 2026-10-02 only a full day saw commitments and nothing could say
    // "I have lectures 2:30–6:30 today", so "schedule 2:30–11pm" filled the
    // lectures; until 2026-10-03 a day was 09:00–17:00.
    // Their own timed items ("mealprep from 12:30") are fixed time too; a
    // one-off that repeats a saved weekly time counts once.
    const saved = busyOn(bundle.commitments, planDate);
    const busyToday = [
      ...saved,
      ...withoutSaved([...oneOffBusy(args.busy), ...pinned.fixed], saved),
    ].sort((a, b) => a.start - b.start);
    const busy = sessionBusyNote(busyToday, startMinute, sessionMinutes);
    const plannedAround = busyWithin(busyToday, startMinute, startMinute + sessionMinutes).map(
      (b) => `${b.title} ${minutesToTime(b.start)}–${minutesToTime(b.end)}`,
    );

    let planResult;
    try {
      planResult = await aiProvider().buildPlan({
        planning_window: window,
        custom_minutes: customMinutes,
        session_minutes: sessionMinutes,
        session_start_minute: startMinute,
        candidate_nodes: bundle.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          body: c.body ? c.body.slice(0, 240) : null,
          node_type: c.node_type,
          planning_signals: c.planning_signals,
        })),
        workspace_context: workspaceContext || undefined,
        busy,
        time_blocks: bundle.time_blocks,
        requests: bundle.requests,
      });
    } catch (err) {
      const cutOff = normalizeAIError(err).userMessage === PLAN_CUT_OFF_MESSAGE;
      return {
        accepted: false,
        error: cutOff ? PLAN_CUT_OFF_MESSAGE : "Couldn't build the plan right now — try again in a moment.",
      };
    }
    const { output, run: runMeta } = planResult;

    const aiRunId = await persistAIRun({
      supabase: ctx.supabase,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      source: "assistant-chat-plan",
      run: {
        run_type: "plan",
        provider: runMeta.provider,
        model_name: runMeta.model_name,
        prompt_version: PLAN_PROMPT_VERSION,
        input_hash: runMeta.input_hash,
        output_hash: runMeta.output_hash,
        input_tokens: runMeta.input_tokens,
        output_tokens: runMeta.output_tokens,
        latency_ms: runMeta.latency_ms,
        estimated_cost: runMeta.estimated_cost,
        status: "success",
        error_text: null,
      },
    });

    const sessionInsert: Record<string, unknown> = {
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      ai_run_id: aiRunId,
      planning_window: window,
      scope: null,
      status: "draft",
    };
    if (customMinutes) sessionInsert.custom_minutes = customMinutes;

    const { data: session, error: sessionErr } = await ctx.supabase
      .from("plan_sessions")
      .insert(sessionInsert)
      .select()
      .single();
    if (sessionErr || !session) {
      return { accepted: false, error: "Couldn't save the plan." };
    }

    const blockRows = output.blocks.map((b) => ({
      plan_session_id: session.id,
      node_id: b.node_id ?? null,
      title: b.title,
      start_offset: b.start_offset,
      duration_minutes: b.duration_minutes,
      reason: b.reason ?? null,
      block_type: b.block_type,
      completion_status: "pending" as const,
    }));
    await ctx.supabase.from("plan_blocks").insert(blockRows);

    return {
      accepted: true,
      planning_window: window,
      block_count: output.blocks.length,
      plan_date: planDate,
      message: `Drafted a ${window === "day" ? "day " : window === "custom" ? "" : `${window} `}plan for ${
        planDate === today ? "" : `${planDate} `
      }${describeSessionSpan(
        startMinute,
        sessionMinutes,
      )} with ${output.blocks.length} blocks${
        plannedAround.length > 0 ? `, around ${plannedAround.join(", ")}` : ""
      }. Open the Planner to review and adjust.`,
    };
  },
};

// Registry
// ---------------------------------------------------------------------------

export const PLANNER_MUTATION_TOOLS: ToolDefinition[] = [
  ADD_TASK_TO_CALENDAR,
  RESCHEDULE_TASK,
  MARK_TASK_DONE,
  PLAN_DAY,
];
