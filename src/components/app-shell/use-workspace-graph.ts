"use client";

// The selected workspace's graph: loading it, reloading it after a change the
// server already made, the lookups built from it, and what it says at a glance
// (type counts, progress, items ready for a next step).

import { useEffect, useMemo, useRef, useState } from "react";

import { prefetchFocusBrief } from "@/components/ui/what-now-dialog";
import { loadWorkspaceGraphData } from "@/lib/graph/data";
import { needsNextAction } from "@/lib/graph/next-action";
import { buildPrimaryStructuralTree } from "@/lib/graph/structure";
import { countNodeTypes, hashGraphContent, indexIncidentEdges } from "@/lib/graph/visible-graph";
import { computeWorkProgress } from "@/lib/graph/work-progress";
import type { GraphData } from "@/types/graph";

// How long a node pulses after its priority changed (ranking v2).
const PRIORITY_PULSE_MS = 2600;

export function useWorkspaceGraph({
  userId,
  workspaceId,
  workspaceRecordName,
}: {
  userId: string | null;
  workspaceId: string | null;
  // The loaded workspace record's name (null until it loads) — display-only
  // inside loadWorkspaceGraphData.
  workspaceRecordName: string | null;
}) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [graphLoading, setGraphLoading] = useState(true);
  // Nodes whose priority just changed (chat, Focus check-back, Undo) — the
  // graph pulses them once so the resize reads as a response.
  const [priorityPulseIds, setPriorityPulseIds] = useState<ReadonlySet<string> | null>(null);
  const priorityPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped after accepted nodes land so the cluster-suggestion stack re-polls
  // (the clustering pass runs server-side inside /api/proposals/nodes/review).
  const [clusterRefreshKey, setClusterRefreshKey] = useState(0);

  /** The workspace's graph as the server has it now. */
  const loadGraph = (targetWorkspaceId: string | null) =>
    loadWorkspaceGraphData(userId, targetWorkspaceId, workspaceRecordName);

  // Graph fetch — keyed ONLY on the two things the query actually depends on
  // (user + workspace). Previously this also depended on the workspace NAME,
  // its bootstrap flag, and profileIntakeState, so the whole graph re-fetched
  // (and the force layout re-ran, freezing a half-settled tangle) every time
  // those resolved during bootstrap. The onboarding decision lives in its own
  // effect, which reads the already-loaded graph. (Perf: #1)
  useEffect(() => {
    let active = true;

    setGraphLoading(true);

    void loadWorkspaceGraphData(
      userId,
      workspaceId,
      // workspaceName is display-only inside loadWorkspaceGraphData (not part of
      // the query), so it's read here without being a dependency.
      workspaceRecordName,
    ).then((nextGraphData) => {
      if (!active) {
        return;
      }

      setGraphData(nextGraphData);
      setGraphLoading(false);
    });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, workspaceId]);

  // Build graph lookups once per data change. Selection and details-panel
  // rendering are frequent; repeatedly scanning every node and edge there made
  // opening a node progressively slower as a workspace grew.
  const graphIndexes = useMemo(
    () => ({
      ...buildPrimaryStructuralTree(graphData),
      ...indexIncidentEdges(graphData),
    }),
    [graphData],
  );

  const nodeTypeCounts = useMemo(() => countNodeTypes(graphData.nodes), [graphData.nodes]);

  const nodeTypeTotalCount = useMemo(
    () => nodeTypeCounts.reduce((sum, item) => sum + item.count, 0),
    [nodeTypeCounts],
  );

  // Content signature for caches that must invalidate on ANY meaningful graph
  // change (the Focus brief, #9). The old key was "nodes:edges:completedCount",
  // which missed renames, deadline edits, archiving (archived nodes stay in
  // graphData, so counts didn't move), rescoring, and a complete+reopen pair.
  const graphContentSignature = useMemo(
    () => hashGraphContent(graphData.nodes, graphData.edges),
    [graphData.nodes, graphData.edges],
  );

  // Warm the Focus brief (SQL only, $0) a moment after a workspace's graph
  // loads, so even the first press of Focus paints at once (R1 #9). Once a
  // brief is cached, Focus shows it instantly and refreshes behind it.
  useEffect(() => {
    if (graphLoading || !workspaceId || graphData.nodes.length === 0) return;
    const prefetchWorkspaceId = workspaceId;
    const signature = graphContentSignature;
    const timer = window.setTimeout(() => prefetchFocusBrief(prefetchWorkspaceId, signature), 1200);
    return () => window.clearTimeout(timer);
    // Once per workspace load — later graph edits refresh Focus when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphLoading, workspaceId]);

  // Actionable-but-empty nodes (goal/project/class with no next step) — drives
  // the on-load anti-freeze nudge so the user sees what's ready to map out.
  const needsActionNodes = useMemo(
    () => graphData.nodes.filter((n) => needsNextAction(n.id, graphData.nodes, graphData.edges)),
    [graphData],
  );

  // Big task / project progress counts done steps even while the canvas
  // hides completed nodes, so it's computed from the full graph.
  const workProgressByNode = useMemo(() => computeWorkProgress(graphData), [graphData]);

  const existingNodeTitleMap = useMemo(
    () => Object.fromEntries(graphData.nodes.map((node) => [node.id, node.title])),
    [graphData.nodes],
  );

  // After a priority change (already applied server-side): reload the graph so
  // node sizes follow the new scores, and pulse the nodes that moved.
  const refreshAfterPriorityChange = async (targetWorkspaceId: string, nodeIds: string[]) => {
    if (userId) {
      try {
        setGraphData(await loadGraph(targetWorkspaceId));
      } catch {
        // The card still shows the change; the next load resizes the nodes.
      }
    }
    if (priorityPulseTimerRef.current) clearTimeout(priorityPulseTimerRef.current);
    setPriorityPulseIds(new Set(nodeIds));
    priorityPulseTimerRef.current = setTimeout(() => setPriorityPulseIds(null), PRIORITY_PULSE_MS);
  };

  // The graph again after a change the server already made (an Undo, an
  // answer on Focus's "Does this still matter?" card).
  const reloadGraph = async () => {
    if (!workspaceId || !userId) return;
    try {
      setGraphData(await loadGraph(workspaceId));
    } catch {
      // The next load catches up.
    }
  };

  const refreshClusters = () => setClusterRefreshKey((k) => k + 1);

  return {
    graphData,
    setGraphData,
    graphLoading,
    loadGraph,
    graphIndexes,
    nodeTypeCounts,
    nodeTypeTotalCount,
    graphContentSignature,
    needsActionNodes,
    workProgressByNode,
    existingNodeTitleMap,
    priorityPulseIds,
    refreshAfterPriorityChange,
    reloadGraph,
    clusterRefreshKey,
    refreshClusters,
  };
}

export type WorkspaceGraph = ReturnType<typeof useWorkspaceGraph>;
