"use client";

// Connection analysis around new or chosen nodes (/api/nodes/analyze): the
// links it proposes — a card in the thread that added the nodes, else the
// review modal — duplicate alerts, the notice when it partly fails, and the
// whole-graph reanalysis behind a confirm.

import { useState } from "react";

import type { ProposedEdgeWithNodes } from "@/lib/ai/connection";
import type { MergeCandidate } from "@/lib/ai/merge";
import {
  buildAnalysisNotice,
  connectionsCardFromEdges,
  normalizeNodeIds,
  type AINotice,
  type AnalysisResponse,
} from "@/lib/graph/connection-analysis";
import { withMergedNode, withReviewedEdges, type ScoreUpdate } from "@/lib/graph/graph-patches";
import type { ChatMessage } from "@/types/chat";
import type { Edge, Node } from "@/types/graph";

import type { ChatThread } from "./use-chat-thread";
import type { WorkspaceGraph } from "./use-workspace-graph";

export function useConnectionAnalysis({
  userId,
  workspaceId,
  graph,
  thread,
}: {
  userId: string | null;
  workspaceId: string | null;
  graph: Pick<WorkspaceGraph, "graphData" | "setGraphData">;
  thread: Pick<ChatThread, "chatMessages" | "setChatMessages" | "chatMessagesRef">;
}) {
  const { graphData, setGraphData } = graph;
  const { chatMessages, setChatMessages, chatMessagesRef } = thread;
  const [proposedEdges, setProposedEdges] = useState<ProposedEdgeWithNodes[]>([]);
  const [edgeReviewOpen, setEdgeReviewOpen] = useState(false);
  const [analyzingConnections, setAnalyzingConnections] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [aiNotice, setAiNotice] = useState<AINotice | null>(null);
  const [lastAnalysisNodeIds, setLastAnalysisNodeIds] = useState<string[]>([]);
  const [lastAnalysisFailedNodeIds, setLastAnalysisFailedNodeIds] = useState<string[]>([]);
  const [lastAnalysisWorkspaceId, setLastAnalysisWorkspaceId] = useState<string | null>(null);
  const [findAllConfirmOpen, setFindAllConfirmOpen] = useState(false);

  // threadMessageId: the chat message whose turn added these nodes — the links
  // go into that thread as a card instead of a modal (docs/unified-turn.md).
  const applyAnalysisResult = (result: AnalysisResponse, threadMessageId?: string) => {
    if (result.merge_candidates && result.merge_candidates.length > 0) {
      setMergeCandidates(result.merge_candidates);
    }
    const edges = result.proposed_edges ?? [];
    const inThread = !!threadMessageId && chatMessagesRef.current.some((m) => m.id === threadMessageId);
    if (edges.length > 0 && inThread) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-links-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: "",
          createdAt: new Date().toISOString(),
          status: "ready" as const,
          connections: connectionsCardFromEdges(edges),
        },
      ]);
    } else if (edges.length > 0) {
      setProposedEdges(edges);
      setEdgeReviewOpen(true);
    }

    // Track which nodes specifically failed so retry can target only those
    // instead of replaying the whole batch.
    setLastAnalysisFailedNodeIds(Array.isArray(result.failed_node_ids) ? result.failed_node_ids : []);

    setAiNotice(buildAnalysisNotice(result));
  };

  const analyzeNodes = async (nodeIds: string[], workspaceIdOverride?: string, threadMessageId?: string) => {
    const targetWorkspaceId = workspaceIdOverride ?? workspaceId;
    const normalizedNodeIds = normalizeNodeIds(nodeIds);

    if (!targetWorkspaceId || normalizedNodeIds.length === 0) {
      return;
    }

    setLastAnalysisNodeIds(normalizedNodeIds);
    setLastAnalysisFailedNodeIds([]);
    setLastAnalysisWorkspaceId(targetWorkspaceId);
    setAnalyzingConnections(true);
    setAiNotice(null);

    try {
      const res = await fetch("/api/nodes/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_ids: normalizedNodeIds, workspace_id: targetWorkspaceId }),
      });
      const data = (await res.json()) as AnalysisResponse;

      if (!res.ok) {
        throw new Error(data.error ?? "Connection analysis failed.");
      }

      applyAnalysisResult(data, threadMessageId);
    } catch (error) {
      setAiNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Connection analysis failed.",
      });
    } finally {
      setAnalyzingConnections(false);
    }
  };

  const retryLastConnectionAnalysis = () => {
    if (!lastAnalysisWorkspaceId) {
      return;
    }

    // Prefer retrying only the nodes that actually failed. Fall back to the full
    // batch if the API didn't report specific failures (e.g. transport-level error
    // before the response was parsed).
    const nodesToRetry = lastAnalysisFailedNodeIds.length > 0 ? lastAnalysisFailedNodeIds : lastAnalysisNodeIds;

    if (nodesToRetry.length === 0) {
      return;
    }

    void analyzeNodes(nodesToRetry, lastAnalysisWorkspaceId);
  };

  const reviewEdges = async (actions: Array<{ id: string; action: "accept" | "reject" }>) => {
    const res = await fetch("/api/proposals/edges/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    const data = (await res.json()) as {
      accepted_edges?: Edge[];
      updated_nodes?: Node[];
    };

    // Add accepted edges to graph state immediately
    const newEdges = data.accepted_edges ?? [];
    const updatedNodeMap = new Map((data.updated_nodes ?? []).map((node) => [node.id, node]));

    if (newEdges.length > 0) {
      // Clear manual positions so the tree layout can reorganize around new edges.
      // The existing buildGraphLayout uses belongs_to edges for hierarchy —
      // letting it re-run produces a clean tree.
      if (userId && workspaceId) {
        const key = `brain-dump:graph-layout:${userId}:${workspaceId}`;
        try {
          localStorage.removeItem(key);
        } catch {}
      }

      setGraphData((prev) => withReviewedEdges(prev, newEdges, updatedNodeMap));
    } else if (updatedNodeMap.size > 0) {
      setGraphData((prev) => withReviewedEdges(prev, newEdges, updatedNodeMap));
    }

    setEdgeReviewOpen(false);
    setProposedEdges([]);
  };

  const closeEdgeReview = () => {
    setEdgeReviewOpen(false);
    setProposedEdges([]);
  };

  const requestCloseEdgeReview = () => {
    const confirmed = window.confirm(
      "Close connection review? The suggested edges will stay pending review and your current selections will be lost.",
    );
    if (!confirmed) {
      return;
    }

    closeEdgeReview();
  };

  // A links card in the thread: the kept links are added, the rest rejected —
  // through the same review endpoint the modal uses.
  const resolveConnections = async (messageId: string, acceptedIds: string[] | null) => {
    const card = chatMessages.find((m) => m.id === messageId)?.connections;
    if (!card || (card.status !== "awaiting" && card.status !== "error")) return;
    const kept = new Set(acceptedIds ?? []);
    const setCard = (patch: Partial<NonNullable<ChatMessage["connections"]>>) =>
      setChatMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.connections ? { ...m, connections: { ...m.connections, ...patch } } : m)),
      );
    setCard({ status: "saving" });
    try {
      await reviewEdges(
        card.edges.map((edge) => ({ id: edge.id, action: kept.has(edge.id) ? ("accept" as const) : ("reject" as const) })),
      );
      setCard(acceptedIds ? { status: "added", acceptedIds: [...kept] } : { status: "dismissed" });
    } catch {
      setCard({ status: "error" });
    }
  };

  // The details panel's "Find links" on the whole graph: asks first.
  const requestFindAll = () => {
    if (!workspaceId || analyzingConnections) return;
    if (graphData.nodes.length === 0) return;
    setFindAllConfirmOpen(true);
  };

  const confirmFindAll = () => {
    setFindAllConfirmOpen(false);
    if (!workspaceId) return;
    const allNodeIds = graphData.nodes.map((n) => n.id);
    if (allNodeIds.length === 0) return;
    void analyzeNodes(allNodeIds);
  };

  // Duplicate alerts: keep both, never ask again, or merge the new into the old.
  const dropMergeCandidate = (c: MergeCandidate) =>
    setMergeCandidates((prev) => prev.filter((x) => x.new_node_id !== c.new_node_id));

  const keepBoth = (c: MergeCandidate) => {
    // Dismiss — keep both, record in DB (best-effort)
    void fetch(`/api/nodes/merge-suggestions/${c.suggestion_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    dropMergeCandidate(c);
  };

  const neverMerge = (c: MergeCandidate) => {
    // Suppress pair forever
    void fetch(`/api/nodes/merge-suggestions/${c.suggestion_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "never" }),
    });
    dropMergeCandidate(c);
  };

  const mergeNodes = (c: MergeCandidate) => {
    // Safe merge: reattach edges from new → existing, archive new
    void fetch(`/api/nodes/${c.new_node_id}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_node_id: c.existing_node_id,
        suggestion_id: c.suggestion_id,
      }),
    })
      .then(
        (r) =>
          r.json() as Promise<{
            archived_node_id?: string;
            recomputed_scores?: ScoreUpdate[];
          }>,
      )
      .then((data) => {
        setGraphData((prev) => withMergedNode(prev, data.archived_node_id, data.recomputed_scores));
        dropMergeCandidate(c);
      })
      .catch(() => {
        // If merge fails, still dismiss from UI
        dropMergeCandidate(c);
      });
  };

  return {
    proposedEdges,
    edgeReviewOpen,
    analyzingConnections,
    mergeCandidates,
    aiNotice,
    dismissAiNotice: () => setAiNotice(null),
    lastAnalysisNodeIds,
    lastAnalysisWorkspaceId,
    findAllConfirmOpen,
    closeFindAllConfirm: () => setFindAllConfirmOpen(false),
    analyzeNodes,
    retryLastConnectionAnalysis,
    reviewEdges,
    requestCloseEdgeReview,
    resolveConnections,
    requestFindAll,
    confirmFindAll,
    keepBoth,
    neverMerge,
    mergeNodes,
  };
}

export type ConnectionAnalysis = ReturnType<typeof useConnectionAnalysis>;
