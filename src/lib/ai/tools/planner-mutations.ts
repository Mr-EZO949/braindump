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
import { DAY_START_MINUTE } from "@/lib/planner/auto-schedule";
import { busyOn, sessionBusyNote } from "@/lib/planner/commitments";
import { localDateISO } from "@/lib/time/local-date";

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
      "Schedule a task on the user's calendar for a specific date, with optional start time and duration. Optionally link the task to an existing graph node so completions flow back to the node. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short description of the task (max 200 chars).",
        },
        scheduled_date: {
          type: "string",
          description: "YYYY-MM-DD date. If omitted, the task is unscheduled.",
        },
        start_time: {
          type: "string",
          description: "HH:MM 24-hour start time. Optional.",
        },
        duration_minutes: {
          type: "integer",
          minimum: 5,
          maximum: 600,
          description: "Duration in minutes (5–600). Optional.",
        },
        node_id: {
          type: "string",
          description:
            "Optional UUID of an existing graph node this task maps to. The node must live in the current workspace.",
        },
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
      "Move a calendar task to a different date, time, or duration. Supply only the fields you want to change. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        scheduled_date: {
          type: "string",
          description: "YYYY-MM-DD. Pass an empty string to clear the date.",
        },
        start_time: {
          type: "string",
          description: "HH:MM 24h. Pass an empty string to clear.",
        },
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
      "Mark a calendar task as done or not-done. Use when the user says they finished a scheduled task. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        done: {
          type: "boolean",
          description: "Target state. Defaults to true.",
        },
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
      "Build a time-blocked plan for the user's session from their active work items, and draft it in the Planner for review. Use when the user asks to plan their day/afternoon/next N hours, make a schedule, or time-block their work. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          enum: ["1h", "2h", "day", "custom"],
          description: "Planning window. 'day' = full day; '1h'/'2h' = short sessions; 'custom' requires custom_minutes.",
        },
        custom_minutes: {
          type: "integer",
          minimum: 15,
          maximum: 600,
          description: "Total minutes — only when window is 'custom'.",
        },
      },
      required: ["window"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as { window?: string; custom_minutes?: number };
    const window = (["1h", "2h", "day", "custom"].includes(args.window ?? "")
      ? args.window
      : "day") as "1h" | "2h" | "day" | "custom";
    const customMinutes =
      window === "custom"
        ? Math.max(15, Math.min(600, Math.round(args.custom_minutes ?? 60)))
        : null;

    const bundle = await buildPlannerCandidates({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      supabase: ctx.supabase,
      clientToday: ctx.today,
    });
    if (!bundle.candidates.length) {
      return { accepted: false, error: "No active work items to plan — add a few tasks or goals first." };
    }

    // A full day lands at 09:00 in the Planner (its day-plan default); plan
    // around today's fixed commitments inside it. Short windows start "now",
    // which this tool can't see — Accept still lays those around busy time.
    const busy =
      window === "day"
        ? sessionBusyNote(busyOn(bundle.commitments, ctx.today ?? localDateISO(new Date(), null)), DAY_START_MINUTE, 480)
        : null;

    let planResult;
    try {
      planResult = await aiProvider().buildPlan({
        planning_window: window,
        custom_minutes: customMinutes,
        candidate_nodes: bundle.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          body: c.body ? c.body.slice(0, 240) : null,
          node_type: c.node_type,
          planning_signals: c.planning_signals,
        })),
        busy,
      });
    } catch {
      return { accepted: false, error: "Couldn't build the plan right now — try again in a moment." };
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
      message: `Drafted a ${window === "day" ? "full-day" : window} plan with ${output.blocks.length} blocks. Open the Planner to review and adjust.`,
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
