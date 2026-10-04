"use client";

// Working on one thing: the focus timer (one per workspace, kept across views
// and reloads), starting it on a node, finishing it, and Focus's check-back on
// something the user is waiting on.

import { useFocusTimer } from "@/hooks/use-focus-timer";
import { todayIsoDate } from "@/lib/planner/auto-schedule";
import { clientDayHints } from "@/lib/habits/streak";
import type { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { addDaysISO, localDateISO } from "@/lib/time/local-date";

import type { PlannerSync } from "./use-shell-ui";
import type { WorkspaceGraph } from "./use-workspace-graph";

// How far "Still waiting" on a Focus check-back pushes the next check (ranking v2).
const CHECK_BACK_SNOOZE_DAYS = 7;

export function useFocusSession({
  supabase,
  userId,
  workspaceId,
  graph,
  planner,
  showToast,
}: {
  supabase: ReturnType<typeof getSupabaseBrowserClient>;
  userId: string | null;
  workspaceId: string | null;
  graph: Pick<WorkspaceGraph, "graphData" | "refreshAfterPriorityChange">;
  planner: Pick<PlannerSync, "refreshPlanner">;
  showToast: (message: string) => void;
}) {
  const { graphData } = graph;
  // Focus timer — one persistent Pomodoro per workspace, backed by localStorage
  // so it survives mode/view switches and reloads. Lives at the shell so the
  // pill renders above every view.
  const focusTimer = useFocusTimer(workspaceId);

  // Start a focus session on a node. Duration = the linked plan_task's
  // duration_minutes for today if one exists, else 25m. No AI estimate call —
  // keep "Start working" free and instant (v1).
  const startFocus = async (nodeId: string) => {
    const node = graphData.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    let durationMinutes = 25;
    if (supabase && workspaceId && userId) {
      // Local date — plan_tasks.scheduled_date is the user's day, not UTC's.
      const today = localDateISO();
      const { data } = await supabase
        .from("plan_tasks")
        .select("duration_minutes")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .eq("node_id", nodeId)
        .eq("scheduled_date", today)
        .limit(1)
        .maybeSingle();
      const linked = data?.duration_minutes;
      if (typeof linked === "number" && linked > 0) durationMinutes = linked;
    }
    // Starting a new timer while one is already running for a different node
    // silently replaces it — surface that so it isn't a surprise.
    const prev = focusTimer.timer;
    if (prev && prev.nodeId !== nodeId) {
      showToast(`Switched focus to "${node.title}".`);
    }
    // Set the timer UP but PAUSED — the user presses Start when they're ready.
    // Focus should never auto-run a countdown (testing journal #4).
    focusTimer.start({ nodeId, title: node.title, durationMinutes, paused: true });
  };

  // Complete a focus session: stop the timer, confirm via toast, and — if a
  // linked plan_task exists for today — mark it done and refresh the planner.
  const finishFocus = async () => {
    const active = focusTimer.timer;
    focusTimer.stop();
    showToast("Nice work — focus session done.");
    if (!active || !supabase || !workspaceId || !userId) return;
    // Local date — plan_tasks.scheduled_date is the user's day, not UTC's.
    const today = localDateISO();
    const { data } = await supabase
      .from("plan_tasks")
      .update({ done: true })
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .eq("node_id", active.nodeId)
      .eq("scheduled_date", today)
      .eq("done", false)
      .select("id");
    if (data && data.length > 0) {
      planner.refreshPlanner();
    }
  };

  // Focus's check-back card: "It's done" completes the waiting item; "Still
  // waiting" keeps it on hold and asks again in a week. Same engine as chat's
  // update_priorities, no model call.
  const checkBack = async (nodeId: string, decision: "done" | "still_waiting") => {
    const targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId) return;
    const node = graphData.nodes.find((n) => n.id === nodeId);
    const change =
      decision === "done"
        ? { node_id: nodeId, title: node?.title ?? "", action: "complete" }
        : {
            node_id: nodeId,
            title: node?.title ?? "",
            action: "wait",
            waiting_for: node?.waiting_for ?? "an update",
            check_back_on: addDaysISO(todayIsoDate(), CHECK_BACK_SNOOZE_DAYS),
          };
    const res = await fetch("/api/assistant/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: targetWorkspaceId, changes: [change], ...clientDayHints() }),
    });
    if (!res.ok) throw new Error("check-back failed");
    showToast(decision === "done" ? "Done ✓" : `OK — I'll ask again next week`);
    await graph.refreshAfterPriorityChange(targetWorkspaceId, [nodeId]);
  };

  return { focusTimer, startFocus, finishFocus, checkBack };
}
