"use client";

// Completing, reopening, archiving and restoring a node from any surface
// (rail, Todos, the archive): shown on the same click, confirmed — or put
// back — when the server answers.

import {
  applyOptimisticStatus,
  mergeServerStatus,
  planStatusChange,
  revertOptimisticStatus,
  type StatusResponse,
} from "@/lib/graph/status-optimistic";
import type { Node } from "@/types/graph";

import type { PlannerSync } from "./use-shell-ui";
import type { WorkspaceGraph } from "./use-workspace-graph";

export function useNodeStatus({
  graph,
  planner,
  showToast,
}: {
  graph: Pick<WorkspaceGraph, "graphData" | "setGraphData">;
  planner: Pick<PlannerSync, "refreshPlanner">;
  showToast: (message: string) => void;
}) {
  const { graphData, setGraphData } = graph;

  const changeStatus = async (nodeId: string, status: Node["status"]) => {
    const previousNode = graphData.nodes.find((n) => n.id === nodeId);
    if (!previousNode) return;

    // Habits recur — "completing" one logs today's completion server-side and
    // keeps the node ACTIVE. Never run the optimistic complete-and-hide path
    // below for a habit, or it disappears from the graph even though the DB
    // keeps it active (#13). Fire the same PATCH (the server's habit guard
    // records the day) and refresh so the streak/day reflects it.
    if (previousNode.node_type === "habit" && status === "completed") {
      // Confirm on tap; only a failed request changes the message.
      showToast("Logged today ✓");
      try {
        const res = await fetch(`/api/nodes/${nodeId}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "completed" }),
        });
        if (!res.ok) showToast("Couldn't log that — try again.");
      } catch {
        showToast("Couldn't log that — try again.");
      }
      return;
    }

    // The node, its belongs_to subtree and (archive / restore) its edges
    // change on the SAME click; a failed request puts them back.
    const plan = planStatusChange(graphData, previousNode, status);
    setGraphData((prev) => applyOptimisticStatus(prev, plan, status));

    const res = await fetch(`/api/nodes/${nodeId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      // Revert clicked node + edges, and restore every cascaded descendant.
      setGraphData((prev) => revertOptimisticStatus(prev, plan, previousNode.status));
      return;
    }

    const data = (await res.json()) as StatusResponse;
    const nowIso = new Date().toISOString();

    // If the server cascaded any plan_tasks (linked-task auto-toggle), bump
    // the planner refresh key so AssistantMode re-loads its task list.
    if (data.updated_task_ids && data.updated_task_ids.length > 0) {
      planner.refreshPlanner();
    }

    // Merge authoritative server state (scores etc.) onto the already-optimistic UI
    setGraphData((prev) => mergeServerStatus(prev, plan, data, nowIso));
  };

  // The Planner ticked a linked task: mirror its status in the graph without
  // a refetch.
  const mirrorPlannerStatus = (nodeId: string, nextStatus: Node["status"]) => {
    setGraphData((prev) => {
      const target = prev.nodes.find((n) => n.id === nodeId);
      // Habits recur — checking off a habit's planner task logs TODAY's
      // completion server-side (the /status route's habit guard) but must NOT
      // complete the node, or it vanishes from the graph (#13). Leave its
      // status untouched.
      if (target?.node_type === "habit") return prev;
      return {
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, status: nextStatus } : n)),
      };
    });
  };

  return { changeStatus, mirrorPlannerStatus };
}
