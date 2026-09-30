// POST /api/assistant/plan — Phase 10.2
// Builds a time-blocked AI plan for the current workspace session.
//
// Flow:
//   1. Auth + workspace ownership check
//   2. buildPlannerCandidates — selects top active nodes, promotes recently unblocked
//   3. buildWorkspaceProfileContext — assembles persona/goal context string
//   4. aiProvider().buildPlan() — calls Claude, returns structured PlanOutput
//   5. Persist ai_run → plan_sessions → plan_blocks
//   6. Return { session, blocks }

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { aiProvider } from "@/lib/ai";
import { checkAIRunRateLimit, rateLimitResponse } from "@/lib/ai/rate-limit";
import { buildPlannerCandidates } from "@/lib/ai/planner";
import { buildWorkspaceProfileContext } from "@/lib/ai/workspace-profile";
import { AI_MODELS, AI_RATE_LIMITS } from "@/lib/ai/config";
import { PLAN_PROMPT_VERSION, planWindowMinutes } from "@/lib/ai/prompts/plan";
import { busyOn, sessionBusyNote, timeToMinutes } from "@/lib/planner/commitments";
import { isISODate } from "@/lib/time/local-date";
import {
  hashText,
  logFailedAIRun,
  logMalformedOutputFailure,
  normalizeAIError,
  isMalformedAIResponseError,
} from "@/lib/ai/errors";
import { persistAIRun } from "@/lib/ai/telemetry";
import type { PlanningWindow } from "@/types/ai";

const VALID_WINDOWS: PlanningWindow[] = ["1h", "2h", "day", "custom"];

function formatManualPlannerItem(item: {
  title: string;
  scheduled_date: string | null;
  start_time: string | null;
}) {
  if (item.scheduled_date && item.start_time) {
    return `"${item.title}" (${item.scheduled_date} ${item.start_time})`;
  }

  if (item.scheduled_date) {
    return `"${item.title}" (${item.scheduled_date})`;
  }

  return `"${item.title}"`;
}

export async function POST(req: NextRequest) {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Parse body
  // -------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    workspace_id,
    planning_window = "2h",
    scope = null,
    custom_minutes = null,
    client_today,
    client_tz_offset,
    session_date,
    session_start,
  } = body as {
    workspace_id: string;
    planning_window?: string;
    scope?: string | null;
    custom_minutes?: number | null;
    client_today?: string;
    client_tz_offset?: number;
    // Where the Planner will put the plan (YYYY-MM-DD + "HH:MM"), so fixed
    // commitments inside it are planned around (docs/commitments.md).
    session_date?: string;
    session_start?: string;
  };

  if (!workspace_id || typeof workspace_id !== "string") {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const resolvedWindow: PlanningWindow = VALID_WINDOWS.includes(planning_window as PlanningWindow)
    ? (planning_window as PlanningWindow)
    : "2h";

  if (resolvedWindow === "custom") {
    if (custom_minutes !== null && typeof custom_minutes !== "number") {
      return NextResponse.json({ error: "custom_minutes must be a number" }, { status: 400 });
    }
    if (!custom_minutes || custom_minutes < 15) {
      return NextResponse.json(
        { error: "custom_minutes must be at least 15 when planning_window is 'custom'" },
        { status: 400 },
      );
    }
    if (custom_minutes > 600) {
      return NextResponse.json(
        { error: "custom_minutes must not exceed 600" },
        { status: 400 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Verify workspace belongs to user
  // -------------------------------------------------------------------------
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  // Rate limit: max N planning sessions per hour
  const rl = await checkAIRunRateLimit({
    supabase,
    userId: user.id,
    runType: "plan",
    maxPerHour: AI_RATE_LIMITS.PLANS_PER_HOUR,
  });
  if (!rl.allowed) return rateLimitResponse(rl);

  // -------------------------------------------------------------------------
  // Build candidates + workspace context in parallel
  // -------------------------------------------------------------------------
  const [candidateBundle, profileCtx] = await Promise.all([
    buildPlannerCandidates({
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
      clientToday: client_today,
      clientTzOffsetMinutes: client_tz_offset,
    }),
    buildWorkspaceProfileContext({ workspaceId: workspace_id, userId: user.id, supabase }),
  ]);

  const { candidates, manual_items, preference_hints, commitments } = candidateBundle;

  // A class inside the session: the planner fills only the free stretches.
  const sessionStartMinute = timeToMinutes(session_start);
  const busy =
    isISODate(session_date) && sessionStartMinute !== null
      ? sessionBusyNote(
          busyOn(commitments, session_date),
          sessionStartMinute,
          planWindowMinutes(resolvedWindow, custom_minutes),
        )
      : null;

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "No active work items found. Add some tasks or goals first." },
      { status: 422 },
    );
  }

  // Append recently-unblocked signal to workspace context so Claude knows
  const recentlyUnblockedTitles = candidates
    .filter((c) => c.recently_unblocked)
    .map((c) => `"${c.title}"`)
    .join(", ");
  const manualPlannerItems = manual_items.map(formatManualPlannerItem).join(", ");

  const workspaceContext = [
    profileCtx.workspaceContext,
    recentlyUnblockedTitles
      ? `Newly ready (dependencies just completed): ${recentlyUnblockedTitles}`
      : null,
    manualPlannerItems
      ? `Standalone manual planner items to account for: ${manualPlannerItems}`
      : null,
    preference_hints.length > 0
      ? `Planner preferences from recent edits: ${preference_hints.join(" ")}`
      : null,
    scope ? `Planning scope: ${scope}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // -------------------------------------------------------------------------
  // Call AI planner
  // -------------------------------------------------------------------------
  const provider = aiProvider();

  let planResult;
  try {
    planResult = await provider.buildPlan({
      planning_window: resolvedWindow,
      custom_minutes: resolvedWindow === "custom" ? custom_minutes : null,
      candidate_nodes: candidates.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        body: c.body ? c.body.slice(0, 240) : null,
        node_type: c.node_type,
        planning_signals: c.planning_signals,
      })),
      workspace_context: workspaceContext || undefined,
      busy,
    });
  } catch (err) {
    const normalized = normalizeAIError(err, "Planning failed");
    console.error("[assistant/plan] buildPlan failed:", normalized.message);
    if (isMalformedAIResponseError(err)) {
      await logMalformedOutputFailure({
        supabase,
        userId: user.id,
        workspaceId: workspace_id,
        error: err,
        linkedEntityIds: candidates.map((candidate) => candidate.id),
      });
    } else {
      await logFailedAIRun({
        supabase,
        userId: user.id,
        workspaceId: workspace_id,
        runType: "plan",
        provider: "claude",
        modelName: AI_MODELS.CLAUDE_HAIKU,
        promptVersion: PLAN_PROMPT_VERSION,
        inputHash: hashText(
          JSON.stringify({
            planning_window: resolvedWindow,
            candidate_ids: candidates.map((candidate) => candidate.id),
            scope,
          }),
        ),
        error: normalized.message,
      });
    }
    return NextResponse.json(
      { error: normalized.userMessage },
      { status: 502 },
    );
  }

  const { output, run: runMeta } = planResult;

  // -------------------------------------------------------------------------
  // Persist ai_run
  // -------------------------------------------------------------------------
  const aiRunId = await persistAIRun({
    supabase,
    userId: user.id,
    workspaceId: workspace_id,
    source: "assistant-plan",
    run: {
      run_type: "plan",
      provider: "claude",
      // Use the provider's own model_name + cache-aware cost (the planner runs
      // on Sonnet, not Haiku — recomputing here mislabeled + underpriced it).
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

  // -------------------------------------------------------------------------
  // Persist plan_session
  // -------------------------------------------------------------------------
  const sessionInsert: Record<string, unknown> = {
    user_id: user.id,
    workspace_id,
    ai_run_id: aiRunId,
    planning_window: resolvedWindow,
    scope: scope ?? null,
    status: "draft",
  };
  if (resolvedWindow === "custom" && custom_minutes) {
    sessionInsert.custom_minutes = custom_minutes;
  }

  const { data: sessionRow, error: sessionError } = await supabase
    .from("plan_sessions")
    .insert(sessionInsert)
    .select()
    .single();

  if (sessionError || !sessionRow) {
    console.error("[assistant/plan] plan_sessions insert failed:", sessionError);
    return NextResponse.json({ error: "Failed to persist plan session" }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Persist plan_blocks
  // -------------------------------------------------------------------------
  const blockRows = output.blocks.map((b) => ({
    plan_session_id: sessionRow.id,
    node_id: b.node_id ?? null,
    title: b.title,
    start_offset: b.start_offset,
    duration_minutes: b.duration_minutes,
    reason: b.reason ?? null,
    block_type: b.block_type,
    completion_status: "pending" as const,
  }));

  const { data: insertedBlocks, error: blocksError } = await supabase
    .from("plan_blocks")
    .insert(blockRows)
    .select();

  if (blocksError) {
    console.error("[assistant/plan] plan_blocks insert failed:", blocksError);
    // Session was created — return what we have so the client isn't left empty
    return NextResponse.json(
      { session: sessionRow, blocks: [], recently_unblocked_node_ids: [], warning: "Blocks failed to persist" },
      { status: 207 },
    );
  }

  const recentlyUnblockedNodeIds = candidates
    .filter((c) => c.recently_unblocked)
    .map((c) => c.id);

  return NextResponse.json({
    session: sessionRow,
    blocks: insertedBlocks ?? [],
    recently_unblocked_node_ids: recentlyUnblockedNodeIds,
  });
}
