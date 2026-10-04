"use client";

// How the graph is being looked at: the selected node, search, type filter,
// "Hide done", the camera — and restoring the selection and camera a reload
// left behind (local persistence is part of the UX, see AGENTS.md).

import { useEffect, useMemo, useState } from "react";

import {
  buildChatNodeContext,
  persistLocalCameraView,
  persistLocalSelectedNode,
  readLocalGraphViewState,
  type LocalGraphCameraView,
} from "@/lib/graph/data";
import { getStructuralSubtreeFromIndexes } from "@/lib/graph/structure";
import {
  RECENT_COMPLETION_WINDOW_MS,
  nodeConnections,
  shelvedCompletedNodes,
  visibleGraph,
} from "@/lib/graph/visible-graph";

import type { WorkspaceGraph } from "./use-workspace-graph";

export function useGraphView({
  userId,
  workspaceId,
  graph,
  setRightPanelOpen,
}: {
  userId: string | null;
  workspaceId: string | null;
  graph: Pick<WorkspaceGraph, "graphData" | "graphLoading" | "graphIndexes">;
  setRightPanelOpen: (open: boolean) => void;
}) {
  const { graphData, graphLoading, graphIndexes } = graph;
  const [graphSearchValue, setGraphSearchValue] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const [nodeTypeFilter, setNodeTypeFilter] = useState("all");
  const [cameraView, setCameraView] = useState<LocalGraphCameraView | null>(null);
  // initialCameraView removed — graph-canvas now always computes a fresh fitted view
  const [pendingRestoredSelectionId, setPendingRestoredSelectionId] = useState<string | null | undefined>(undefined);
  const [suppressInitialFocusAnimation, setSuppressInitialFocusAnimation] = useState(false);
  const [viewStateHydrated, setViewStateHydrated] = useState(false);

  // #17: completed nodes are SHOWN by default — a done task should stay in the
  // graph, attached to its parent, so the user feels the satisfaction of it.
  // But only RECENT ones: a completion stays on the board for a week, then moves
  // to the completed shelf, so a mature graph doesn't fill up with months of
  // done nodes (the force layout would have to place every one of them too).
  // The filter bar's "Hide done" toggle shelves all of them.
  const [hideCompleted, setHideCompleted] = useState(false);
  // Coarse clock for the recency window — read once, refreshed hourly. Held in
  // state rather than calling Date.now() during render, so the memoized
  // filters below stay pure.
  const [recencyNowMs, setRecencyNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setRecencyNowMs(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  const recentCompletionCutoffMs = recencyNowMs - RECENT_COMPLETION_WINDOW_MS;

  // Completed nodes that are NOT on the board — the shelf lists these.
  const completedNodes = useMemo(
    () => shelvedCompletedNodes(graphData.nodes, hideCompleted, recentCompletionCutoffMs),
    [graphData.nodes, hideCompleted, recentCompletionCutoffMs],
  );

  const filteredGraphData = useMemo(
    () => visibleGraph(graphData, { hideCompleted, nodeTypeFilter, recentCompletionCutoffMs }),
    [graphData, hideCompleted, nodeTypeFilter, recentCompletionCutoffMs],
  );

  const selectedNode = useMemo(
    () => buildChatNodeContext(graphData, selectedNodeId, graphIndexes),
    [graphData, graphIndexes, selectedNodeId],
  );

  const selectedNodeRecord = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphData.nodes, selectedNodeId],
  );

  const selectedNodeDeletePlan = useMemo(
    () =>
      selectedNodeId
        ? getStructuralSubtreeFromIndexes(selectedNodeId, graphIndexes.childrenByParent, graphIndexes.incidentEdgesByNode)
        : null,
    [graphIndexes, selectedNodeId],
  );

  const connectableNodes = useMemo(
    () =>
      graphData.nodes
        .filter((node) => node.id !== selectedNodeId)
        .sort((nodeA, nodeB) => nodeA.title.localeCompare(nodeB.title)),
    [graphData.nodes, selectedNodeId],
  );

  const selectedNodeConnections = useMemo(
    () => nodeConnections(selectedNodeId, graphIndexes),
    [graphIndexes, selectedNodeId],
  );

  // Workspace switch: nothing selected, searched, filtered or framed carries over.
  useEffect(() => {
    setSelectedNodeId(null);
    setGraphSearchValue("");
    setNodeTypeFilter("all");
    setCameraView(null);
  }, [workspaceId]);

  useEffect(() => {
    const localViewState = readLocalGraphViewState(userId, workspaceId);

    setViewStateHydrated(false);
    setPendingRestoredSelectionId(localViewState.selectedNodeId);
    setSuppressInitialFocusAnimation(Boolean(localViewState.selectedNodeId));
  }, [userId, workspaceId]);

  useEffect(() => {
    if (graphLoading || pendingRestoredSelectionId === undefined) {
      return;
    }

    const nextSelectedNode =
      pendingRestoredSelectionId === null
        ? null
        : (graphData.nodes.find((node) => node.id === pendingRestoredSelectionId) ?? null);

    setSelectedNodeId(nextSelectedNode?.id ?? null);
    setRightPanelOpen(Boolean(nextSelectedNode));
    setPendingRestoredSelectionId(undefined);
    setSuppressInitialFocusAnimation(false);
    setViewStateHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData.nodes, graphLoading, pendingRestoredSelectionId]);

  useEffect(() => {
    if (!viewStateHydrated) {
      return;
    }

    persistLocalSelectedNode(userId, workspaceId, selectedNodeId);
  }, [userId, selectedNodeId, workspaceId, viewStateHydrated]);

  useEffect(() => {
    if (!viewStateHydrated || !cameraView) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      persistLocalCameraView(userId, workspaceId, cameraView);
    }, 140);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [userId, cameraView, workspaceId, viewStateHydrated]);

  const resetFilters = () => {
    setNodeTypeFilter("all");
    setHideCompleted(false);
  };

  return {
    graphSearchValue,
    setGraphSearchValue,
    selectedNodeId,
    setSelectedNodeId,
    focusRequestKey,
    setFocusRequestKey,
    nodeTypeFilter,
    setNodeTypeFilter,
    hideCompleted,
    setHideCompleted,
    cameraView,
    setCameraView,
    suppressInitialFocusAnimation,
    setSuppressInitialFocusAnimation,
    completedNodes,
    filteredGraphData,
    selectedNode,
    selectedNodeRecord,
    selectedNodeDeletePlan,
    connectableNodes,
    selectedNodeConnections,
    resetFilters,
  };
}

export type GraphView = ReturnType<typeof useGraphView>;
