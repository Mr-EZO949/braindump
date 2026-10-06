"use client";

// Working on one thing: the Focus Zone (fullscreen, opened from Focus's "Work
// on this" and Details' "Start working"), its timer (one per workspace, kept
// across views and reloads), finishing it, and Focus's check-back on
// something the user is waiting on.

import { useState } from "react";

import { useFocusTimer } from "@/hooks/use-focus-timer";
import { clearFocusCache } from "@/components/ui/what-now-dialog";
import { suggestedFocusMinutes, todayIsoDate } from "@/lib/planner/auto-schedule";
import { clientDayHints } from "@/lib/habits/streak";
import type { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Node } from "@/types/graph";
import { addDaysISO, localDateISO } from "@/lib/time/local-date";

import type { PlannerSync } from "./use-shell-ui";
import type { WorkspaceGraph } from "./use-workspace-graph";

export type FocusZoneState = {
  nodeId: string;
  /** Suggested length — what Focus showed, else today's plan, else the type estimate. */
  minutes: number;
  /** Why this, now (Focus's hero line). */
  reason: string | null;
};

// How far "Still waiting" on a Focus check-back pushes the next check (ranking v2).
const CHECK_BACK_SNOOZE_DAYS = 7;

export function useFocusSession({
  supabase,
  userId,
  workspaceId,
  graph,
  planner,
  changeStatus,
  showToast,
}: {
  supabase: ReturnType<typeof getSupabaseBrowserClient>;
  userId: string | null;
  workspaceId: string | null;
  graph: Pick<WorkspaceGraph, "graphData" | "refreshAfterPriorityChange">;
  planner: Pick<PlannerSync, "refreshPlanner">;
  changeStatus: (nodeId: string, status: Node["status"]) => Promise<void>;
  showToast: (message: string) => void;
}) {
  const { graphData } = graph;
  // Focus timer — one per workspace, backed by localStorage so it survives
  // mode/view switches and reloads. The Zone shows it; stepping out of a
  // running session leaves a small chip to come back.
  const focusTimer = useFocusTimer(workspaceId);

  // The Focus Zone (fullscreen): which node it's open on and the minutes it
  // suggests. "Work on this" in Focus and "Start working" in Details open it;
  // nothing runs until the user presses Start there.
  const [zone, setZone] = useState<FocusZoneState | null>(null);

  // Minutes for a node: today's plan if it has it, else the per-type estimate
  // — the same rule Focus's "about N min" uses (suggestedFocusMinutes).
  const plannedMinutesToday = async (nodeId: string): Promise<number | null> => {
    if (!supabase || !workspaceId || !userId) return null;
    // Local date — plan_tasks.scheduled_date is the user's day, not UTC's.
    const { data } = await supabase
      .from("plan_tasks")
      .select("duration_minutes")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .eq("node_id", nodeId)
      .eq("scheduled_date", localDateISO())
      .limit(1)
      .maybeSingle();
    const linked = data?.duration_minutes;
    return typeof linked === "number" && linked > 0 ? linked : null;
  };

  /**
   * Open the Focus Zone on a node. `minutes` is what Focus showed (so the Zone
   * suggests the same); without it, today's plan or the type estimate.
   */
  const openZone = async (nodeId: string, opts: { minutes?: number; reason?: string | null } = {}) => {
    const node = graphData.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const running = focusTimer.timer?.nodeId === nodeId ? focusTimer.timer : null;
    const fallback = suggestedFocusMinutes(node.node_type);
    setZone({
      nodeId,
      minutes: running?.durationMinutes ?? opts.minutes ?? fallback,
      reason: opts.reason ?? node.importance_reason ?? null,
    });
    if (running || opts.minutes) return;
    const planned = await plannedMinutesToday(nodeId);
    if (planned) {
      setZone((current) =>
        current?.nodeId === nodeId ? { ...current, minutes: suggestedFocusMinutes(node.node_type, planned) } : current,
      );
    }
  };

  // Start the countdown from the Zone. A session already running on another
  // node is replaced — say so.
  const startZoneTimer = (minutes: number) => {
    if (!zone) return;
    const node = graphData.nodes.find((n) => n.id === zone.nodeId);
    if (!node) return;
    const prev = focusTimer.timer;
    if (prev && prev.nodeId !== zone.nodeId) showToast(`Switched focus from "${prev.title}".`);
    focusTimer.start({ nodeId: node.id, title: node.title, durationMinutes: minutes });
  };

  // End the session: stop the timer and, when a plan_task for today is linked,
  // mark it done. `completed` also completes the node itself (a habit logs today).
  const finishFocus = async (opts: { completed?: boolean } = {}) => {
    const active = focusTimer.timer;
    const nodeId = active?.nodeId ?? zone?.nodeId ?? null;
    focusTimer.stop();
    setZone(null);
    if (opts.completed && nodeId) {
      // Focus's cached picks still hold this node — next open fetches fresh.
      if (workspaceId) clearFocusCache(workspaceId);
      await changeStatus(nodeId, "completed");
    }
    showToast(opts.completed ? "Done ✓ Nice work." : "Session ended — it stays on your list.");
    if (!opts.completed || !nodeId || !supabase || !workspaceId || !userId) return;
    const { data } = await supabase
      .from("plan_tasks")
      .update({ done: true })
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .eq("node_id", nodeId)
      .eq("scheduled_date", localDateISO())
      .eq("done", false)
      .select("id");
    if (data && data.length > 0) {
      planner.refreshPlanner();
    }
  };

  // Leave the Zone. A running session keeps going (a small chip brings you
  // back); one never started is simply dropped.
  const stepOutOfZone = () => setZone(null);

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

  return { focusTimer, zone, openZone, startZoneTimer, finishFocus, stepOutOfZone, checkBack };
}
