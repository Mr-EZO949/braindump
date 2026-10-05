"use client";

// Selecting and editing nodes by hand: selection (click, search), edit mode,
// the create and edit sheets, deleting a node with its subtree, the edit
// sheet's connections, and dragged positions. Mode-based editing and floating
// sheets are settled UX (AGENTS.md "Important UX Decisions").

import { useEffect, useState } from "react";

import { createWorkspaceScope } from "@/lib/graph/chat";
import { findFirstMatchingNode, persistLocalNodePosition, removeLocalNodePosition } from "@/lib/graph/data";
import { withScores, type ScoreUpdate } from "@/lib/graph/graph-patches";
import { setNodeParent } from "@/lib/graph/hierarchy";
import {
  checkNodeDraft,
  createDraftFromNode,
  defaultCreateNodeDraft,
  editedNodeFields,
  embeddingTextChanged,
  newNodeRow,
} from "@/lib/graph/node-draft";
import { buildEdgePayloadFromSelection, type EdgeRelationOptionId } from "@/lib/graph/relationships";
import type { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { CreateNodeInput, Edge, Node, Workspace } from "@/types/graph";

import type { ChatThread } from "./use-chat-thread";
import type { GraphView } from "./use-graph-view";
import type { ShellPanels } from "./use-shell-ui";
import type { StepSuggestions } from "./use-step-suggestions";
import type { WorkspaceGraph } from "./use-workspace-graph";

export function useNodeEditor({
  supabase,
  userId,
  workspaceId,
  selectedWorkspace,
  workspaceName,
  graph,
  view,
  panels,
  setChatScope,
  steps,
  showToast,
}: {
  supabase: ReturnType<typeof getSupabaseBrowserClient>;
  userId: string | null;
  workspaceId: string | null;
  selectedWorkspace: Workspace | null;
  workspaceName: string;
  graph: Pick<WorkspaceGraph, "graphData" | "setGraphData">;
  view: GraphView;
  panels: ShellPanels;
  setChatScope: ChatThread["setChatScope"];
  steps: Pick<StepSuggestions, "maybeOfferBreakdown" | "forgetBreakdownFor">;
  showToast: (message: string) => void;
}) {
  const { graphData, setGraphData } = graph;
  const { selectedNodeId, setSelectedNodeId, selectedNodeRecord, selectedNodeDeletePlan } = view;
  const { setRightPanelOpen, setActiveRailTab } = panels;
  const [editMode, setEditMode] = useState(false);
  const [createNodeDraft, setCreateNodeDraft] = useState<CreateNodeInput | null>(null);
  const [createNodeError, setCreateNodeError] = useState<string | null>(null);
  const [createNodeSubmitting, setCreateNodeSubmitting] = useState(false);
  const [editNodeDraft, setEditNodeDraft] = useState<CreateNodeInput | null>(null);
  const [editNodeError, setEditNodeError] = useState<string | null>(null);
  const [editNodeSubmitting, setEditNodeSubmitting] = useState(false);
  const [deleteNodeConfirmOpen, setDeleteNodeConfirmOpen] = useState(false);
  const [deleteNodeSubmitting, setDeleteNodeSubmitting] = useState(false);
  const [edgeRelationId, setEdgeRelationId] = useState<EdgeRelationOptionId>("contains");
  const [edgeTargetId, setEdgeTargetId] = useState("");
  const [edgeError, setEdgeError] = useState<string | null>(null);
  const [edgeSubmitting, setEdgeSubmitting] = useState(false);
  const [edgeDeleteSubmittingId, setEdgeDeleteSubmittingId] = useState<string | null>(null);
  const [edgeUpdateSubmittingId, setEdgeUpdateSubmittingId] = useState<string | null>(null);

  // Workspace switch: no sheet, draft, edit mode or connection form carries over.
  useEffect(() => {
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEditMode(false);
    setEdgeRelationId("contains");
    setEdgeTargetId("");
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
  }, [workspaceId]);

  // A selected node that the filters hide is let go, with its sheet.
  useEffect(() => {
    if (selectedNodeId && view.filteredGraphData.nodes.some((node) => node.id === selectedNodeId)) {
      return;
    }

    if (!selectedNodeId) {
      return;
    }

    setSelectedNodeId(null);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setRightPanelOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.filteredGraphData.nodes, selectedNodeId]);

  const selectNode = (nodeId: string | null) => {
    view.setSuppressInitialFocusAnimation(false);
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);

    if (!nodeId) {
      setSelectedNodeId(null);
      setEditNodeDraft(null);
      setEdgeTargetId("");
      return;
    }

    const nextSelectedNode = graphData.nodes.find((node) => node.id === nodeId);

    setSelectedNodeId(nodeId);
    view.setFocusRequestKey((currentKey) => currentKey + 1);

    if (!nextSelectedNode) {
      return;
    }

    if (editMode) {
      setActiveRailTab("details");
      setRightPanelOpen(false);
      setEditNodeDraft(createDraftFromNode(nextSelectedNode));
      setEdgeTargetId("");
      return;
    }

    setEditNodeDraft(null);
    setEdgeTargetId("");
    setRightPanelOpen(true);
  };

  const submitGraphSearch = () => {
    view.setSuppressInitialFocusAnimation(false);
    const matchingNode = findFirstMatchingNode(view.filteredGraphData, view.graphSearchValue);

    if (!matchingNode) {
      return;
    }

    setSelectedNodeId(matchingNode.id);
    view.setFocusRequestKey((currentKey) => currentKey + 1);
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);

    if (editMode) {
      setActiveRailTab("details");
      setRightPanelOpen(false);
      setEditNodeDraft(createDraftFromNode(matchingNode));
      setEdgeTargetId("");
      return;
    }

    setEditNodeDraft(null);
    setEdgeTargetId("");
    setRightPanelOpen(true);
  };

  const openCreateNode = () => {
    if (!editMode) {
      return;
    }

    panels.setSystemPanelOpen(false);
    panels.setWorkspaceMenuOpen(false);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    setSelectedNodeId(null);
    setActiveRailTab("details");
    setRightPanelOpen(false);
    setCreateNodeError(null);
    // A new node hangs under the workspace root by default, like a chat- or
    // dump-made one; the sheet's "Under" changes it ("" = top level).
    const rootId = selectedWorkspace?.bootstrap_root_node_id ?? "";
    const rootLive = rootId !== "" && graphData.nodes.some((node) => node.id === rootId);
    setCreateNodeDraft({ ...defaultCreateNodeDraft, parent_id: rootLive ? rootId : "" });
  };

  const changeCreateField = <Field extends keyof CreateNodeInput>(field: Field, value: CreateNodeInput[Field]) => {
    setCreateNodeDraft((currentDraft) => {
      const next = { ...(currentDraft ?? defaultCreateNodeDraft), [field]: value };
      // An importance picked on the slider is the user's call, as in the edit
      // sheet — the rescore after the node's intake keeps it.
      if (field === "importance_index") {
        next.manual_weight = Math.max(0, Math.min(100, Number(value)));
      }
      return next;
    });
  };

  // A hand-made or hand-edited node gets the intake an AI-made one gets
  // (/api/nodes/[id]/intake, #25): fired after the save, never awaited by
  // it. A new node's judgment → rescore comes back as scores, and the graph
  // resizes when they land.
  const runIntake = (nodeId: string, reason: "created" | "edited") => {
    if (!workspaceId) return;
    void fetch(`/api/nodes/${nodeId}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, reason }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { scores?: Array<ScoreUpdate & { importance_reason?: string | null }> };
        if (data.scores && data.scores.length > 0) {
          const scores = data.scores;
          setGraphData((current) => withScores(current, scores));
        }
      })
      .catch(() => {
        // Best-effort: the nightly rescore and the embedding backfill catch up.
      });
  };

  const closeCreateNode = () => {
    setCreateNodeDraft(null);
    setCreateNodeError(null);
  };

  const changeEditField = <Field extends keyof CreateNodeInput>(field: Field, value: CreateNodeInput[Field]) => {
    setEditNodeDraft((currentDraft) => {
      const base = currentDraft ?? defaultCreateNodeDraft;
      const next = { ...base, [field]: value };
      // In edit mode, dragging the importance slider sets a manual override so
      // the scorer won't overwrite it on the next rescore.
      if (field === "importance_index") {
        next.manual_weight = Math.max(0, Math.min(100, Number(value)));
      }
      return next;
    });
  };

  const resetManualWeight = () => {
    setEditNodeDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      return { ...currentDraft, manual_weight: null };
    });
  };

  const closeEditNode = () => {
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    setRightPanelOpen(false);
  };

  const toggleEditMode = () => {
    setEditMode((currentMode) => {
      const nextMode = !currentMode;

      if (!nextMode) {
        setCreateNodeDraft(null);
        setCreateNodeError(null);
        setEditNodeDraft(null);
        setEditNodeError(null);
        setDeleteNodeConfirmOpen(false);
        setEdgeError(null);
        setEdgeUpdateSubmittingId(null);
        setRightPanelOpen(Boolean(selectedNodeId));
      } else if (selectedNodeRecord) {
        setCreateNodeDraft(null);
        setCreateNodeError(null);
        setEditNodeDraft(createDraftFromNode(selectedNodeRecord));
        setEditNodeError(null);
        setDeleteNodeConfirmOpen(false);
        setEdgeError(null);
        setEdgeUpdateSubmittingId(null);
        setActiveRailTab("details");
        setRightPanelOpen(false);
      }

      return nextMode;
    });
  };

  const submitCreateNode = async () => {
    if (!supabase || !userId || !workspaceId || !createNodeDraft) {
      setCreateNodeError("Workspace or auth context is unavailable.");
      return;
    }

    const checked = checkNodeDraft(createNodeDraft);
    if (!checked.ok) {
      setCreateNodeError(checked.error);
      return;
    }

    setCreateNodeSubmitting(true);
    setCreateNodeError(null);

    const { data, error } = await supabase
      .from("nodes")
      .insert(newNodeRow(createNodeDraft, checked, { userId, workspaceId }))
      .select("*")
      .single();

    if (error || !data) {
      setCreateNodeSubmitting(false);
      setCreateNodeError(error?.message ?? "Unable to create node.");
      return;
    }

    const createdNode = data as Node;

    // Its parent: one belongs_to edge through the one writer of parents.
    // A failure here keeps the node (top level) rather than losing it.
    let parentEdge: Edge | null = null;
    const parentId = createNodeDraft.parent_id ?? "";
    if (parentId && graphData.nodes.some((node) => node.id === parentId)) {
      const parentResult = await setNodeParent({
        supabase,
        userId,
        workspaceId,
        nodeId: createdNode.id,
        parentId,
      });
      if (parentResult.ok) {
        const { data: edgeRow } = await supabase
          .from("edges")
          .select("*")
          .eq("source_node_id", createdNode.id)
          .eq("target_node_id", parentId)
          .eq("edge_type", "belongs_to")
          .eq("status", "active")
          .limit(1)
          .maybeSingle();
        parentEdge = (edgeRow as Edge | null) ?? null;
      } else {
        showToast(`Created "${createdNode.title}" at the top level — ${parentResult.error}.`);
      }
    }

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      nodes: [...currentGraphData.nodes, createdNode],
      edges: parentEdge ? [...currentGraphData.edges, parentEdge] : currentGraphData.edges,
    }));
    setCreateNodeSubmitting(false);
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setSelectedNodeId(createdNode.id);
    setRightPanelOpen(true);
    setActiveRailTab("details");
    runIntake(createdNode.id, "created");

    // Sizing layer: only second-guess plain tasks. If the user explicitly
    // created a project/goal/etc., take it at face value. Runs after the
    // node is already on screen so the common (task) path has zero delay.
    if (checked.nodeType === "task") {
      void steps.maybeOfferBreakdown(createdNode);
    }
  };

  const submitEditNode = async () => {
    if (!supabase || !userId || !workspaceId || !selectedNodeRecord || !editNodeDraft) {
      setEditNodeError("Workspace or auth context is unavailable.");
      return;
    }

    const checked = checkNodeDraft(editNodeDraft);
    if (!checked.ok) {
      setEditNodeError(checked.error);
      return;
    }

    setEditNodeSubmitting(true);
    setEditNodeError(null);

    const { data, error } = await supabase
      .from("nodes")
      .update(editedNodeFields(editNodeDraft, checked))
      .eq("id", selectedNodeRecord.id)
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .select("*")
      .single();

    setEditNodeSubmitting(false);

    if (error || !data) {
      setEditNodeError(error?.message ?? "Unable to update node.");
      return;
    }

    const updatedNode = data as Node;
    if (embeddingTextChanged(selectedNodeRecord, updatedNode)) {
      runIntake(updatedNode.id, "edited");
    }

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      nodes: currentGraphData.nodes.map((node) => (node.id === updatedNode.id ? updatedNode : node)),
    }));
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setSelectedNodeId(updatedNode.id);
    setRightPanelOpen(false);
    setActiveRailTab("details");
  };

  const deleteNode = async () => {
    if (!supabase || !userId || !workspaceId || !selectedNodeRecord || !selectedNodeDeletePlan) {
      setEditNodeError("Workspace or auth context is unavailable.");
      return;
    }

    const { edgeIds, nodeIds } = selectedNodeDeletePlan;

    setDeleteNodeSubmitting(true);
    setEditNodeError(null);

    if (edgeIds.length > 0) {
      const { error: deleteEdgesError } = await supabase
        .from("edges")
        .delete()
        .in("id", edgeIds)
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId);

      if (deleteEdgesError) {
        setDeleteNodeSubmitting(false);
        setEditNodeError(deleteEdgesError.message);
        return;
      }
    }

    const { error: deleteNodeError } = await supabase
      .from("nodes")
      .delete()
      .in("id", nodeIds)
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId);

    setDeleteNodeSubmitting(false);

    if (deleteNodeError) {
      setEditNodeError(deleteNodeError.message);
      return;
    }

    nodeIds.forEach((nodeId) => {
      removeLocalNodePosition(userId, workspaceId, nodeId);
    });

    setGraphData((currentGraphData) => ({
      nodes: currentGraphData.nodes.filter((node) => !nodeIds.includes(node.id)),
      edges: currentGraphData.edges.filter((edge) => !edgeIds.includes(edge.id)),
    }));
    setSelectedNodeId(null);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    // Drop a pending breakdown offer if its node was just deleted.
    steps.forgetBreakdownFor(nodeIds);
    setChatScope(createWorkspaceScope(workspaceName));
    setRightPanelOpen(true);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    if (panels.activeRailTab === "chat") {
      setActiveRailTab("details");
    }
  };

  const createEdge = async () => {
    if (!supabase || !userId || !workspaceId || !selectedNodeId) {
      setEdgeError("Workspace or auth context is unavailable.");
      return;
    }

    if (edgeTargetId.length === 0) {
      setEdgeError("Choose a node to connect.");
      return;
    }

    if (edgeTargetId === selectedNodeId) {
      setEdgeError("A node cannot connect to itself.");
      return;
    }

    const payload = buildEdgePayloadFromSelection(selectedNodeId, edgeTargetId, edgeRelationId);

    const duplicateEdge = graphData.edges.find((edge) => {
      return (
        edge.edge_type === payload.edge_type &&
        edge.source_node_id === payload.source_node_id &&
        edge.target_node_id === payload.target_node_id
      );
    });

    if (duplicateEdge) {
      setEdgeError("That connection already exists.");
      return;
    }

    setEdgeSubmitting(true);
    setEdgeError(null);

    const { data, error } = await supabase
      .from("edges")
      .insert({
        ...payload,
        user_id: userId,
        workspace_id: workspaceId,
      })
      .select("*")
      .single();

    setEdgeSubmitting(false);

    if (error || !data) {
      setEdgeError(error?.message ?? "Unable to create edge.");
      return;
    }

    const createdEdge = data as Edge;

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      edges: [...currentGraphData.edges, createdEdge],
    }));
    setEdgeError(null);
    setEdgeRelationId("contains");
    setEdgeTargetId("");
  };

  const updateEdge = async (edgeId: string, relationId: EdgeRelationOptionId) => {
    if (!supabase || !userId || !workspaceId || !selectedNodeId) {
      setEdgeError("Workspace or auth context is unavailable.");
      return;
    }

    const existingEdge = graphData.edges.find((edge) => edge.id === edgeId);

    if (!existingEdge) {
      setEdgeError("Connection no longer exists.");
      return;
    }

    const targetNodeId =
      existingEdge.source_node_id === selectedNodeId ? existingEdge.target_node_id : existingEdge.source_node_id;

    const payload = buildEdgePayloadFromSelection(selectedNodeId, targetNodeId, relationId);

    const duplicateEdge = graphData.edges.find((edge) => {
      if (edge.id === edgeId) {
        return false;
      }

      return (
        edge.edge_type === payload.edge_type &&
        edge.source_node_id === payload.source_node_id &&
        edge.target_node_id === payload.target_node_id
      );
    });

    if (duplicateEdge) {
      setEdgeError("That connection already exists.");
      return;
    }

    setEdgeUpdateSubmittingId(edgeId);
    setEdgeError(null);

    const { data, error } = await supabase
      .from("edges")
      .update(payload)
      .eq("id", edgeId)
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .select("*")
      .single();

    setEdgeUpdateSubmittingId(null);

    if (error || !data) {
      setEdgeError(error?.message ?? "Unable to update connection.");
      return;
    }

    const updatedEdge = data as Edge;

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      edges: currentGraphData.edges.map((edge) => (edge.id === edgeId ? updatedEdge : edge)),
    }));
  };

  const deleteEdge = async (edgeId: string) => {
    if (!supabase || !userId || !workspaceId) {
      setEdgeError("Workspace or auth context is unavailable.");
      return;
    }

    setEdgeDeleteSubmittingId(edgeId);
    setEdgeError(null);

    const { error } = await supabase
      .from("edges")
      .delete()
      .eq("id", edgeId)
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId);

    setEdgeDeleteSubmittingId(null);

    if (error) {
      setEdgeError(error.message);
      return;
    }

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      edges: currentGraphData.edges.filter((edge) => edge.id !== edgeId),
    }));
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
  };

  const commitNodePosition = (nodeId: string, position: { x: number; y: number }) => {
    if (!userId || !workspaceId) {
      return;
    }

    const normalizedPosition = {
      x: Number(position.x.toFixed(2)),
      y: Number(position.y.toFixed(2)),
    };

    persistLocalNodePosition(userId, workspaceId, nodeId, normalizedPosition);

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      nodes: currentGraphData.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              manual_position: true,
              position_x: normalizedPosition.x,
              position_y: normalizedPosition.y,
            }
          : node,
      ),
    }));

    if (!supabase) {
      return;
    }

    void supabase
      .from("nodes")
      .update({
        manual_position: true,
        position_x: normalizedPosition.x,
        position_y: normalizedPosition.y,
      })
      .eq("id", nodeId)
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId);
  };

  return {
    editMode,
    createNodeDraft,
    createNodeError,
    createNodeSubmitting,
    editNodeDraft,
    editNodeError,
    editNodeSubmitting,
    deleteNodeConfirmOpen,
    setDeleteNodeConfirmOpen,
    deleteNodeSubmitting,
    edgeRelationId,
    setEdgeRelationId,
    edgeTargetId,
    setEdgeTargetId,
    edgeError,
    edgeSubmitting,
    edgeDeleteSubmittingId,
    edgeUpdateSubmittingId,
    selectNode,
    submitGraphSearch,
    openCreateNode,
    changeCreateField,
    closeCreateNode,
    changeEditField,
    resetManualWeight,
    closeEditNode,
    toggleEditMode,
    submitCreateNode,
    submitEditNode,
    deleteNode,
    createEdge,
    updateEdge,
    deleteEdge,
    commitNodePosition,
  };
}

export type NodeEditor = ReturnType<typeof useNodeEditor>;
