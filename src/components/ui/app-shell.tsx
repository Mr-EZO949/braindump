"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { MainStage } from "@/components/graph/main-stage";
import { AssistantMode as AssistantModeView } from "@/components/assistant/assistant-mode";
import { ModeDock, type AppMode } from "@/components/ui/mode-dock";
import { BrainDumpOverlay } from "@/components/ui/brain-dump-overlay";
import { ProposedNodesReview } from "@/components/ui/proposed-nodes-review";
import { ProposedEdgesReview } from "@/components/ui/proposed-edges-review";
import { MergeAlert } from "@/components/ui/merge-alert";
import { WorkspaceBootstrapWizard } from "@/components/ui/workspace-bootstrap-wizard";
import { OnboardingTutorial, shouldShowTutorial } from "@/components/ui/onboarding-tutorial";
import type { ProposedEdgeWithNodes } from "@/lib/ai/connection";
import type { MergeCandidate } from "@/lib/ai/merge";
import {
  createNodeScope,
  createUserChatMessage,
  createWorkspaceScope,
} from "@/lib/graph/chat";
import {
  buildChatNodeContext,
  findFirstMatchingNode,
  loadWorkspaceGraphData,
  loadWorkspaces,
  persistLocalCameraView,
  persistLocalNodePosition,
  persistLocalSelectedNode,
  readLocalGraphViewState,
  removeLocalNodePosition,
  type LocalGraphCameraView,
} from "@/lib/graph/data";
import { demoGraphData } from "@/lib/graph/demo-data";
import { getImportanceIndex, getImportanceLabel } from "@/lib/graph/importance";
import {
  buildEdgePayloadFromSelection,
  isEdgeHiddenInUi,
  visibleEdgeRelationOptions,
  getEdgeRelationOptionIdForSelection,
  type EdgeRelationOptionId,
} from "@/lib/graph/relationships";
import { getStructuralSubtree } from "@/lib/graph/structure";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import type { RailTab, ChatMessage, ChatScope } from "@/types/chat";
import type { CreateNodeInput, Edge, GraphData, Node, Workspace } from "@/types/graph";
import type { ProposedNode } from "@/types/ai";

type AuthUserState = {
  email: string | null;
  id: string;
};

type AppShellProps = {
  initialUser: AuthUserState;
};

type AnalysisResponse = {
  proposed_edges?: ProposedEdgeWithNodes[];
  merge_candidates?: MergeCandidate[];
  proposed?: number;
  skipped?: number;
  failed?: number;
  paused?: number;
  warning?: string;
  error?: string;
};

type AINotice = {
  tone: "warning" | "error";
  message: string;
};

const defaultCreateNodeDraft: CreateNodeInput = {
  custom_type: "",
  importance_index: 58,
  node_type: "concept",
  raw_text: "",
  summary: "",
  title: "",
};

const nodeColorByType: Record<Exclude<CreateNodeInput["node_type"], "custom">, string> = {
  class: "#96784d",
  concept: "#677480",
  goal: "#d8d0c4",
  project: "#8c4a57",
  task: "#a35258",
};

const baseEditableNodeTypes = new Set<CreateNodeInput["node_type"]>([
  "goal",
  "project",
  "task",
  "concept",
  "class",
]);

const importanceFilterOptions = [
  { label: "All importance", value: "all" },
  { label: "70 and above", value: "70" },
  { label: "55 and above", value: "55" },
  { label: "40 and above", value: "40" },
] as const;

function formatNodeTypeLabel(nodeType: string) {
  return nodeType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function createDraftFromNode(node: Node): CreateNodeInput {
  const resolvedType = node.node_type.toLowerCase();
  const nodeType = baseEditableNodeTypes.has(resolvedType as CreateNodeInput["node_type"])
    ? (resolvedType as Exclude<CreateNodeInput["node_type"], "custom">)
    : "custom";

  return {
    custom_type: nodeType === "custom" ? node.node_type : "",
    importance_index: getImportanceIndex(node),
    node_type: nodeType,
    raw_text: node.raw_text ?? "",
    summary: node.summary ?? "",
    title: node.title,
  };
}

function buildAnalysisNotice(result: AnalysisResponse): AINotice | null {
  if (result.warning && result.warning.trim()) {
    return {
      tone: "warning",
      message: result.warning.trim(),
    };
  }

  if (result.failed && result.failed > 0) {
    return {
      tone: "warning",
      message:
        result.proposed_edges && result.proposed_edges.length > 0
          ? `Some connection checks failed (${result.failed}), but partial results are still shown.`
          : `Connection analysis failed for ${result.failed} item${result.failed === 1 ? "" : "s"}. Retry when ready.`,
    };
  }

  return null;
}

export function AppShell({ initialUser }: AppShellProps) {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  // App-level mode state
  const [appMode, setAppMode] = useState<AppMode>("graph");
  const [brainDumpOpen, setBrainDumpOpen] = useState(false);
  // Workspace captured at open time — stays fixed even if the user switches workspace mid-dump.
  const [brainDumpWorkspaceId, setBrainDumpWorkspaceId] = useState<string | null>(null);
  const [brainDumpValue, setBrainDumpValue] = useState("");
  const [brainDumpSubmitting, setBrainDumpSubmitting] = useState(false);
  const [brainDumpRetrying, setBrainDumpRetrying] = useState(false);
  const [brainDumpError, setBrainDumpError] = useState<string | null>(null);
  const [brainDumpFailedEntryId, setBrainDumpFailedEntryId] = useState<string | null>(null);
  const [proposedNodes, setProposedNodes] = useState<ProposedNode[]>([]);
  const [proposedReviewOpen, setProposedReviewOpen] = useState(false);
  const [proposedEdges, setProposedEdges] = useState<ProposedEdgeWithNodes[]>([]);
  const [edgeReviewOpen, setEdgeReviewOpen] = useState(false);
  const [analyzingConnections, setAnalyzingConnections] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [aiNotice, setAiNotice] = useState<AINotice | null>(null);

  // Panel state
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [systemPanelOpen, setSystemPanelOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>("details");
  const [railChatInput, setRailChatInput] = useState("");

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatScope, setChatScope] = useState<ChatScope>(createWorkspaceScope("General"));
  const [chatLoading, setChatLoading] = useState(false);

  // Graph state
  const [graphData, setGraphData] = useState<GraphData>(demoGraphData);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphSearchValue, setGraphSearchValue] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUserState | null>(initialUser);
  const [signingOut, setSigningOut] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [nodeTypeFilter, setNodeTypeFilter] = useState("all");
  const [importanceFilter, setImportanceFilter] =
    useState<(typeof importanceFilterOptions)[number]["value"]>("all");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [cameraView, setCameraView] = useState<LocalGraphCameraView | null>(null);
  const [initialCameraView, setInitialCameraView] = useState<LocalGraphCameraView | null>(null);
  const [pendingRestoredSelectionId, setPendingRestoredSelectionId] = useState<
    string | null | undefined
  >(undefined);
  const [suppressInitialFocusAnimation, setSuppressInitialFocusAnimation] = useState(false);
  const [viewStateHydrated, setViewStateHydrated] = useState(false);
  const [createNodeDraft, setCreateNodeDraft] = useState<CreateNodeInput | null>(null);
  const [createNodeError, setCreateNodeError] = useState<string | null>(null);
  const [createNodeSubmitting, setCreateNodeSubmitting] = useState(false);
  const [editNodeDraft, setEditNodeDraft] = useState<CreateNodeInput | null>(null);
  const [editNodeError, setEditNodeError] = useState<string | null>(null);
  const [editNodeSubmitting, setEditNodeSubmitting] = useState(false);
  const [deleteNodeConfirmOpen, setDeleteNodeConfirmOpen] = useState(false);
  const [deleteNodeSubmitting, setDeleteNodeSubmitting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [edgeRelationId, setEdgeRelationId] = useState<EdgeRelationOptionId>("contains");
  const [edgeTargetId, setEdgeTargetId] = useState("");
  const [edgeError, setEdgeError] = useState<string | null>(null);
  const [edgeSubmitting, setEdgeSubmitting] = useState(false);
  const [edgeDeleteSubmittingId, setEdgeDeleteSubmittingId] = useState<string | null>(null);
  const [edgeUpdateSubmittingId, setEdgeUpdateSubmittingId] = useState<string | null>(null);
  const [cascadeChildren, setCascadeChildren] = useState<Array<{ id: string; title: string }>>([]);
  const [cascadeParentTitle, setCascadeParentTitle] = useState<string | null>(null);
  const [cascadeSubmitting, setCascadeSubmitting] = useState(false);
  // Bootstrap wizard — shown when a new empty workspace is created OR loaded empty
  const [bootstrapWorkspaceId, setBootstrapWorkspaceId] = useState<string | null>(null);
  // Onboarding tutorial — shown once per user (persisted via localStorage)
  const [showTutorial, setShowTutorial] = useState(false);
  const tutorialShownRef = useRef(false);
  const workspaceCreationFlowRef = useRef<{
    previousWorkspaceId: string | null;
    workspaceId: string;
  } | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const workspaceName = selectedWorkspace?.name ?? "General";

  const selectedNode = useMemo(
    () => buildChatNodeContext(graphData, selectedNodeId),
    [graphData, selectedNodeId],
  );

  const nodeTypeFilterOptions = useMemo(() => {
    const values = Array.from(new Set(graphData.nodes.map((node) => node.node_type))).sort(
      (typeA, typeB) => formatNodeTypeLabel(typeA).localeCompare(formatNodeTypeLabel(typeB)),
    );

    return [
      { label: "All types", value: "all" },
      ...values.map((value) => ({
        label: formatNodeTypeLabel(value),
        value,
      })),
    ];
  }, [graphData.nodes]);

  // Completed nodes are hidden by default; user can reveal them via the filter bar.
  const [hideCompleted, setHideCompleted] = useState(true);

  const filteredGraphData = useMemo(() => {
    const minimumImportance =
      importanceFilter === "all" ? null : Number.parseInt(importanceFilter, 10);

    const nodes = graphData.nodes.filter((node) => {
      // Archived nodes are hidden unless the user toggled the archive view
      if (node.status === "archived" && !showArchived) {
        return false;
      }

      // Completed nodes are hidden by default
      if (node.status === "completed" && hideCompleted) {
        return false;
      }

      if (nodeTypeFilter !== "all" && node.node_type !== nodeTypeFilter) {
        return false;
      }

      if (minimumImportance !== null && getImportanceIndex(node) < minimumImportance) {
        return false;
      }

      return true;
    });
    const visibleNodeIds = new Set(nodes.map((node) => node.id));

    return {
      nodes,
      edges: graphData.edges.filter(
        (edge) =>
          !isEdgeHiddenInUi(edge.edge_type) &&
          edge.status !== "orphaned" &&
          visibleNodeIds.has(edge.source_node_id) &&
          visibleNodeIds.has(edge.target_node_id),
      ),
    };
  }, [graphData, hideCompleted, importanceFilter, nodeTypeFilter, showArchived]);

  const selectedNodeRecord = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphData.nodes, selectedNodeId],
  );

  const selectedNodeDeletePlan = useMemo(
    () => (selectedNodeId ? getStructuralSubtree(graphData, selectedNodeId) : null),
    [graphData, selectedNodeId],
  );

  const existingNodeTitleMap = useMemo(
    () => Object.fromEntries(graphData.nodes.map((node) => [node.id, node.title])),
    [graphData.nodes],
  );

  const connectableNodes = useMemo(
    () =>
      graphData.nodes
        .filter((node) => node.id !== selectedNodeId)
        .sort((nodeA, nodeB) => nodeA.title.localeCompare(nodeB.title)),
    [graphData.nodes, selectedNodeId],
  );

  const selectedNodeConnections = useMemo(() => {
    if (!selectedNodeId) {
      return [];
    }

    const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));

    return graphData.edges
      .flatMap((edge) => {
        if (isEdgeHiddenInUi(edge.edge_type)) {
          return [];
        }

        if (edge.source_node_id !== selectedNodeId && edge.target_node_id !== selectedNodeId) {
          return [];
        }

        const linkedNodeId =
          edge.source_node_id === selectedNodeId ? edge.target_node_id : edge.source_node_id;
        const linkedNode = nodesById.get(linkedNodeId);

        if (!linkedNode) {
          return [];
        }

        return [
          {
            edgeId: edge.id,
            nodeId: linkedNode.id,
            nodeType: linkedNode.node_type,
            relationId: getEdgeRelationOptionIdForSelection(edge, selectedNodeId),
            title: linkedNode.title,
          },
        ];
      })
      .sort((connectionA, connectionB) => connectionA.title.localeCompare(connectionB.title));
  }, [graphData.edges, graphData.nodes, selectedNodeId]);

  const defaultChatScope = useMemo(
    () =>
      selectedNode
        ? createNodeScope(workspaceName, selectedNode)
        : createWorkspaceScope(workspaceName),
    [selectedNode, workspaceName],
  );

  useEffect(() => {
    let active = true;

    void loadWorkspaces(authUser?.id ?? null).then((nextWorkspaces) => {
      if (!active) {
        return;
      }

      setWorkspaces(nextWorkspaces);
      setSelectedWorkspaceId((currentWorkspaceId) => {
        if (
          currentWorkspaceId &&
          nextWorkspaces.some((workspace) => workspace.id === currentWorkspaceId)
        ) {
          return currentWorkspaceId;
        }

        return (
          nextWorkspaces.find((workspace) => workspace.name === "Personal")?.id ??
          nextWorkspaces.find((workspace) => workspace.name === "General")?.id ??
          nextWorkspaces[0]?.id ??
          null
        );
      });
    });

    return () => {
      active = false;
    };
  }, [authUser?.id]);

  useEffect(() => {
    let active = true;

    setGraphLoading(true);

    void loadWorkspaceGraphData(
      authUser?.id ?? null,
      selectedWorkspaceId,
      selectedWorkspace?.name ?? null,
    ).then((nextGraphData) => {
      if (!active) {
        return;
      }

      setGraphData(nextGraphData);
      setGraphLoading(false);

      // Show bootstrap wizard for any workspace that loads with 0 nodes
      if (nextGraphData.nodes.length === 0 && selectedWorkspaceId) {
        setBootstrapWorkspaceId(selectedWorkspaceId);
      }
    });

    return () => {
      active = false;
    };
  }, [authUser?.id, selectedWorkspace?.name, selectedWorkspaceId]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active || error) {
        return;
      }

      setAuthUser(
        data.session?.user
          ? {
              email: data.session.user.email ?? null,
              id: data.session.user.id,
            }
          : null,
      );
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(
        session?.user
          ? {
              email: session.user.email ?? null,
              id: session.user.id,
            }
          : null,
      );
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (chatMessages.length === 0) {
      setChatScope(defaultChatScope);
    }
  }, [chatMessages.length, defaultChatScope]);

  useEffect(() => {
    setSelectedNodeId(null);
    setGraphSearchValue("");
    setRailChatInput("");
    setChatMessages([]);
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEditMode(false);
    setNodeTypeFilter("all");
    setImportanceFilter("all");
    setCameraView(null);
    setEdgeRelationId("contains");
    setEdgeTargetId("");
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    setChatScope(createWorkspaceScope(workspaceName));
  }, [workspaceName]);

  useEffect(() => {
    const localViewState = readLocalGraphViewState(authUser?.id ?? null, selectedWorkspaceId);

    setViewStateHydrated(false);
    setInitialCameraView(localViewState.cameraView);
    setPendingRestoredSelectionId(localViewState.selectedNodeId);
    setSuppressInitialFocusAnimation(
      Boolean(localViewState.cameraView || localViewState.selectedNodeId),
    );
  }, [authUser?.id, selectedWorkspaceId]);

  useEffect(() => {
    if (graphLoading || pendingRestoredSelectionId === undefined) {
      return;
    }

    const nextSelectedNode =
      pendingRestoredSelectionId === null
        ? null
        : graphData.nodes.find((node) => node.id === pendingRestoredSelectionId) ?? null;

    setSelectedNodeId(nextSelectedNode?.id ?? null);
    setRightPanelOpen(Boolean(nextSelectedNode));
    setPendingRestoredSelectionId(undefined);
    setSuppressInitialFocusAnimation(false);
    setViewStateHydrated(true);
  }, [graphData.nodes, graphLoading, pendingRestoredSelectionId]);

  useEffect(() => {
    if (!viewStateHydrated) {
      return;
    }

    persistLocalSelectedNode(authUser?.id ?? null, selectedWorkspaceId, selectedNodeId);
  }, [authUser?.id, selectedNodeId, selectedWorkspaceId, viewStateHydrated]);

  useEffect(() => {
    if (!viewStateHydrated || !cameraView) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      persistLocalCameraView(authUser?.id ?? null, selectedWorkspaceId, cameraView);
    }, 140);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [authUser?.id, cameraView, selectedWorkspaceId, viewStateHydrated]);

  useEffect(() => {
    if (selectedNodeId && filteredGraphData.nodes.some((node) => node.id === selectedNodeId)) {
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
  }, [filteredGraphData.nodes, selectedNodeId]);

  const submitMessage = async (message: string, duplicateUserMessage = true) => {
    const trimmedMessage = message.trim();

    if (trimmedMessage.length === 0 || chatLoading) {
      return;
    }

    const nextScope = chatMessages.length === 0 ? defaultChatScope : chatScope;

    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatScope(nextScope);
    setRailChatInput("");

    const assistantMsgId = `chat-${Math.random().toString(36).slice(2, 10)}`;

    setChatMessages((prev) => [
      ...prev,
      ...(duplicateUserMessage ? [createUserChatMessage(trimmedMessage)] : []),
      {
        id: assistantMsgId,
        role: "assistant" as const,
        body: "",
        createdAt: new Date().toISOString(),
        status: "ready" as const,
      },
    ]);

    setChatLoading(true);

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage,
          workspace_id: selectedWorkspaceId,
          selected_node_id: nextScope.kind === "node" ? nextScope.node.id : null,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Chat request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, body: m.body + chunk } : m,
          ),
        );
      }
    } catch {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, body: "Response unavailable. Try again.", status: "error" as const }
            : m,
        ),
      );
    } finally {
      setChatLoading(false);
    }
  };

  const retryLastMessage = () => {
    const lastUserMessage = [...chatMessages].reverse().find((message) => message.role === "user");

    if (!lastUserMessage) {
      return;
    }

    void submitMessage(lastUserMessage.body, false);
  };

  const handleSelectNode = (nodeId: string | null) => {
    setSuppressInitialFocusAnimation(false);
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

  const handleGraphSearchSubmit = () => {
    setSuppressInitialFocusAnimation(false);
    const matchingNode = findFirstMatchingNode(filteredGraphData, graphSearchValue);

    if (!matchingNode) {
      return;
    }

    setSelectedNodeId(matchingNode.id);
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

  const handleOpenCreateNode = () => {
    if (!editMode) {
      return;
    }

    setSystemPanelOpen(false);
    setWorkspaceMenuOpen(false);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    setSelectedNodeId(null);
    setActiveRailTab("details");
    setRightPanelOpen(false);
    setCreateNodeError(null);
    setCreateNodeDraft({ ...defaultCreateNodeDraft });
  };

  const handleChangeCreateNodeField = <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => {
    setCreateNodeDraft((currentDraft) => ({
      ...(currentDraft ?? defaultCreateNodeDraft),
      [field]: value,
    }));
  };

  const handleCloseCreateNode = () => {
    setCreateNodeDraft(null);
    setCreateNodeError(null);
  };

  const handleChangeEditNodeField = <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => {
    setEditNodeDraft((currentDraft) => ({
      ...(currentDraft ?? defaultCreateNodeDraft),
      [field]: value,
    }));
  };

  const handleCloseEditNode = () => {
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    setRightPanelOpen(false);
  };

  const handleToggleEditMode = () => {
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

  const handleResetFilters = () => {
    setNodeTypeFilter("all");
    setImportanceFilter("all");
  };

  const handleSubmitCreateNode = async () => {
    if (!supabase || !authUser?.id || !selectedWorkspaceId || !createNodeDraft) {
      setCreateNodeError("Workspace or auth context is unavailable.");
      return;
    }

    const title = createNodeDraft.title.trim();
    const resolvedNodeType =
      createNodeDraft.node_type === "custom"
        ? createNodeDraft.custom_type.trim()
        : createNodeDraft.node_type;

    if (title.length === 0) {
      setCreateNodeError("Title is required.");
      return;
    }

    if (resolvedNodeType.length === 0) {
      setCreateNodeError("Choose a node type or enter a custom type.");
      return;
    }

    setCreateNodeSubmitting(true);
    setCreateNodeError(null);

    const payload = {
      color:
        createNodeDraft.node_type === "custom"
          ? nodeColorByType.concept
          : nodeColorByType[createNodeDraft.node_type],
      importance: getImportanceLabel(createNodeDraft.importance_index),
      importance_index: createNodeDraft.importance_index,
      node_type: resolvedNodeType as Node["node_type"],
      raw_text: createNodeDraft.raw_text.trim() || null,
      summary: createNodeDraft.summary.trim() || null,
      title,
      user_id: authUser.id,
      workspace_id: selectedWorkspaceId,
    };

    const { data, error } = await supabase
      .from("nodes")
      .insert(payload)
      .select("*")
      .single();

    setCreateNodeSubmitting(false);

    if (error || !data) {
      setCreateNodeError(error?.message ?? "Unable to create node.");
      return;
    }

    const createdNode = data as Node;

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      nodes: [...currentGraphData.nodes, createdNode],
    }));
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setSelectedNodeId(createdNode.id);
    setRightPanelOpen(true);
    setActiveRailTab("details");
  };

  const handleSubmitEditNode = async () => {
    if (
      !supabase ||
      !authUser?.id ||
      !selectedWorkspaceId ||
      !selectedNodeRecord ||
      !editNodeDraft
    ) {
      setEditNodeError("Workspace or auth context is unavailable.");
      return;
    }

    const title = editNodeDraft.title.trim();
    const resolvedNodeType =
      editNodeDraft.node_type === "custom"
        ? editNodeDraft.custom_type.trim()
        : editNodeDraft.node_type;

    if (title.length === 0) {
      setEditNodeError("Title is required.");
      return;
    }

    if (resolvedNodeType.length === 0) {
      setEditNodeError("Choose a node type or enter a custom type.");
      return;
    }

    setEditNodeSubmitting(true);
    setEditNodeError(null);

    const payload = {
      color:
        editNodeDraft.node_type === "custom"
          ? nodeColorByType.concept
          : nodeColorByType[editNodeDraft.node_type],
      importance: getImportanceLabel(editNodeDraft.importance_index),
      importance_index: editNodeDraft.importance_index,
      node_type: resolvedNodeType as Node["node_type"],
      summary: editNodeDraft.summary.trim() || null,
      title,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("nodes")
      .update(payload)
      .eq("id", selectedNodeRecord.id)
      .eq("user_id", authUser.id)
      .eq("workspace_id", selectedWorkspaceId)
      .select("*")
      .single();

    setEditNodeSubmitting(false);

    if (error || !data) {
      setEditNodeError(error?.message ?? "Unable to update node.");
      return;
    }

    const updatedNode = data as Node;

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      nodes: currentGraphData.nodes.map((node) =>
        node.id === updatedNode.id ? updatedNode : node,
      ),
    }));
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setSelectedNodeId(updatedNode.id);
    setRightPanelOpen(false);
    setActiveRailTab("details");
  };

  const handleDeleteNode = async () => {
    if (
      !supabase ||
      !authUser?.id ||
      !selectedWorkspaceId ||
      !selectedNodeRecord ||
      !selectedNodeDeletePlan
    ) {
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
        .eq("user_id", authUser.id)
        .eq("workspace_id", selectedWorkspaceId);

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
      .eq("user_id", authUser.id)
      .eq("workspace_id", selectedWorkspaceId);

    setDeleteNodeSubmitting(false);

    if (deleteNodeError) {
      setEditNodeError(deleteNodeError.message);
      return;
    }

    nodeIds.forEach((nodeId) => {
      removeLocalNodePosition(authUser.id, selectedWorkspaceId, nodeId);
    });

    setGraphData((currentGraphData) => ({
      nodes: currentGraphData.nodes.filter((node) => !nodeIds.includes(node.id)),
      edges: currentGraphData.edges.filter((edge) => !edgeIds.includes(edge.id)),
    }));
    setSelectedNodeId(null);
    setEditNodeDraft(null);
    setEditNodeError(null);
    setDeleteNodeConfirmOpen(false);
    setChatScope(createWorkspaceScope(workspaceName));
    setRightPanelOpen(true);
    setEdgeError(null);
    setEdgeUpdateSubmittingId(null);
    if (activeRailTab === "chat") {
      setActiveRailTab("details");
    }
  };

  const handleSubmitCreateEdge = async () => {
    if (!supabase || !authUser?.id || !selectedWorkspaceId || !selectedNodeId) {
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
        user_id: authUser.id,
        workspace_id: selectedWorkspaceId,
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

  const handleUpdateEdge = async (edgeId: string, relationId: EdgeRelationOptionId) => {
    if (!supabase || !authUser?.id || !selectedWorkspaceId || !selectedNodeId) {
      setEdgeError("Workspace or auth context is unavailable.");
      return;
    }

    const existingEdge = graphData.edges.find((edge) => edge.id === edgeId);

    if (!existingEdge) {
      setEdgeError("Connection no longer exists.");
      return;
    }

    const targetNodeId =
      existingEdge.source_node_id === selectedNodeId
        ? existingEdge.target_node_id
        : existingEdge.source_node_id;

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
      .eq("user_id", authUser.id)
      .eq("workspace_id", selectedWorkspaceId)
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

  const handleDeleteEdge = async (edgeId: string) => {
    if (!supabase || !authUser?.id || !selectedWorkspaceId) {
      setEdgeError("Workspace or auth context is unavailable.");
      return;
    }

    setEdgeDeleteSubmittingId(edgeId);
    setEdgeError(null);

    const { error } = await supabase
      .from("edges")
      .delete()
      .eq("id", edgeId)
      .eq("user_id", authUser.id)
      .eq("workspace_id", selectedWorkspaceId);

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

  const handleCommitNodePosition = (nodeId: string, position: { x: number; y: number }) => {
    if (!authUser?.id || !selectedWorkspaceId) {
      return;
    }

    const normalizedPosition = {
      x: Number(position.x.toFixed(2)),
      y: Number(position.y.toFixed(2)),
    };

    persistLocalNodePosition(authUser.id, selectedWorkspaceId, nodeId, normalizedPosition);

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
      .eq("user_id", authUser.id)
      .eq("workspace_id", selectedWorkspaceId);
  };

  const handleSignOut = async () => {
    if (!supabase || signingOut) {
      return;
    }

    setSigningOut(true);

    const { error } = await supabase.auth.signOut();

    setSigningOut(false);

    if (error) {
      return;
    }

    setSystemPanelOpen(false);
    router.replace("/login");
  };

  const deleteWorkspace = async (
    workspaceId: string,
    options?: { fallbackWorkspaceId?: string | null },
  ) => {
    const res = await fetch(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
    if (!res.ok) {
      return false;
    }

    const remainingWorkspaces = workspaces.filter((workspace) => workspace.id !== workspaceId);
    setWorkspaces(remainingWorkspaces);

    if (selectedWorkspaceId === workspaceId) {
      if (
        options?.fallbackWorkspaceId &&
        remainingWorkspaces.some((workspace) => workspace.id === options.fallbackWorkspaceId)
      ) {
        setSelectedWorkspaceId(options.fallbackWorkspaceId);
      } else {
        setSelectedWorkspaceId(remainingWorkspaces[0]?.id ?? null);
      }
    }

    setBootstrapWorkspaceId((currentWorkspaceId) =>
      currentWorkspaceId === workspaceId ? null : currentWorkspaceId,
    );

    if (workspaceCreationFlowRef.current?.workspaceId === workspaceId) {
      workspaceCreationFlowRef.current = null;
    }

    return true;
  };

  const handleCancelWorkspaceCreation = async () => {
    if (
      !bootstrapWorkspaceId ||
      workspaceCreationFlowRef.current?.workspaceId !== bootstrapWorkspaceId
    ) {
      setBootstrapWorkspaceId(null);
      return;
    }

    const previousWorkspaceId = workspaceCreationFlowRef.current.previousWorkspaceId;
    const fallbackWorkspaceId =
      previousWorkspaceId &&
      workspaces.some((workspace) => workspace.id === previousWorkspaceId)
        ? previousWorkspaceId
        : workspaces.find((workspace) => workspace.id !== bootstrapWorkspaceId)?.id ?? null;

    const deleted = await deleteWorkspace(bootstrapWorkspaceId, { fallbackWorkspaceId });

    if (!deleted) {
      setBootstrapWorkspaceId(null);
    }
  };

  const handleBrainDumpSubmit = async () => {
    const trimmed = brainDumpValue.trim();
    // Use the workspace captured at open time, not the current selection.
    const targetWorkspaceId = brainDumpWorkspaceId ?? selectedWorkspaceId;
    if (!trimmed || brainDumpSubmitting || !targetWorkspaceId) return;

    setBrainDumpSubmitting(true);
    setBrainDumpError(null);
    setBrainDumpFailedEntryId(null);
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: trimmed, workspace_id: targetWorkspaceId }),
      });
      const data = await res.json() as {
        proposed_nodes?: ProposedNode[];
        raw_entry_id?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok && res.status !== 207) {
        setBrainDumpError(data.error ?? data.message ?? "Could not process that brain dump.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? null);
        return;
      }
      if (res.status === 207) {
        setBrainDumpError(data.error ?? data.message ?? "Extraction failed. Retry when ready.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? null);
        return;
      }

      setBrainDumpValue("");
      setBrainDumpOpen(false);
      setBrainDumpError(null);
      setBrainDumpFailedEntryId(null);
      if (data.proposed_nodes && data.proposed_nodes.length > 0) {
        setProposedNodes(data.proposed_nodes);
        setProposedReviewOpen(true);
      }
    } catch (err) {
      setBrainDumpError(
        err instanceof Error ? err.message : "Could not process that brain dump.",
      );
    } finally {
      setBrainDumpSubmitting(false);
    }
  };

  const handleBrainDumpRetry = async () => {
    if (!brainDumpFailedEntryId || brainDumpRetrying) {
      return;
    }

    setBrainDumpRetrying(true);
    setBrainDumpError(null);
    try {
      const res = await fetch(`/api/entries/${brainDumpFailedEntryId}/retry`, {
        method: "POST",
      });
      const data = await res.json() as {
        proposed_nodes?: ProposedNode[];
        raw_entry_id?: string;
        error?: string;
      };

      if (!res.ok && res.status !== 207) {
        setBrainDumpError(data.error ?? "Retry failed.");
        return;
      }
      if (res.status === 207) {
        setBrainDumpError(data.error ?? "Retry failed.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? brainDumpFailedEntryId);
        return;
      }

      setBrainDumpValue("");
      setBrainDumpOpen(false);
      setBrainDumpError(null);
      setBrainDumpFailedEntryId(null);
      if (data.proposed_nodes && data.proposed_nodes.length > 0) {
        setProposedNodes(data.proposed_nodes);
        setProposedReviewOpen(true);
      }
    } catch (err) {
      setBrainDumpError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setBrainDumpRetrying(false);
    }
  };

  const handleProposalReview = async (
    actions: Array<{
      id: string;
      action: "accept" | "reject";
      edits?: { proposed_title: string; proposed_summary: string | null; proposed_node_type: string };
    }>
  ) => {
    const res = await fetch("/api/proposals/nodes/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    const data = await res.json() as { accepted_nodes?: Node[]; accepted_edges?: Edge[] };
    if (data.accepted_nodes && data.accepted_nodes.length > 0) {
      const nodes = data.accepted_nodes;
      const acceptedEdges = data.accepted_edges ?? [];
      const attachedNodeIds = new Set(
        acceptedEdges
          .filter((edge) => edge.edge_type === "belongs_to" || edge.edge_type === "required_for")
          .map((edge) => edge.source_node_id),
      );

      // Cluster new nodes near the viewport center instead of scattering them.
      // Viewport center in graph coords = (-panX/zoom, -panY/zoom).
      const zoom = cameraView?.zoom ?? 1;
      const panX = cameraView?.panX ?? 0;
      const panY = cameraView?.panY ?? 0;
      const cx = -panX / zoom;
      const cy = -panY / zoom;

      const SPACING = 220; // graph units between nodes
      const unattachedNodes = nodes.filter((node) => !attachedNodeIds.has(node.id));
      const cols = Math.max(1, Math.ceil(Math.sqrt(unattachedNodes.length || 1)));
      const startX = cx - ((cols - 1) * SPACING) / 2;
      const startY = cy - (Math.ceil((unattachedNodes.length || 1) / cols) - 1) * SPACING / 2;
      let unattachedIndex = 0;

      const positioned = nodes.map((node) => {
        if (attachedNodeIds.has(node.id)) {
          if (authUser?.id && selectedWorkspaceId) {
            removeLocalNodePosition(authUser.id, selectedWorkspaceId, node.id);
          }

          return {
            ...node,
            manual_position: false,
            position_x: null,
            position_y: null,
          };
        }

        const col = unattachedIndex % cols;
        const row = Math.floor(unattachedIndex / cols);
        unattachedIndex += 1;

        const px = Math.round(startX + col * SPACING);
        const py = Math.round(startY + row * SPACING);
        if (authUser?.id && selectedWorkspaceId) {
          persistLocalNodePosition(authUser.id, selectedWorkspaceId, node.id, { x: px, y: py });
        }
        return { ...node, position_x: px, position_y: py, manual_position: true };
      });

      setGraphData((prev) => ({
        ...prev,
        nodes: [...prev.nodes, ...positioned],
        edges: [...prev.edges, ...acceptedEdges],
      }));
    }
    setProposedReviewOpen(false);
    setProposedNodes([]);

    // Phase 5 — trigger connection analysis for newly accepted nodes
    if (data.accepted_nodes && data.accepted_nodes.length > 0 && selectedWorkspaceId) {
      const nodeIds = (data.accepted_nodes as Node[]).map((n) => n.id);
      void analyzeNodes(nodeIds);
    }
  };

  const applyAnalysisResult = (result: AnalysisResponse) => {
    if (result.merge_candidates && result.merge_candidates.length > 0) {
      setMergeCandidates(result.merge_candidates);
    }
    if (result.proposed_edges && result.proposed_edges.length > 0) {
      setProposedEdges(result.proposed_edges);
      setEdgeReviewOpen(true);
    }

    setAiNotice(buildAnalysisNotice(result));
  };

  const analyzeNodes = async (nodeIds: string[]) => {
    if (!selectedWorkspaceId) {
      return;
    }

    setAnalyzingConnections(true);
    setAiNotice(null);

    try {
      const res = await fetch("/api/nodes/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_ids: nodeIds, workspace_id: selectedWorkspaceId }),
      });
      const data = await res.json() as AnalysisResponse;

      if (!res.ok) {
        throw new Error(data.error ?? "Connection analysis failed.");
      }

      applyAnalysisResult(data);
    } catch (error) {
      setAiNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Connection analysis failed.",
      });
    } finally {
      setAnalyzingConnections(false);
    }
  };

  const handleEdgeReview = async (
    actions: Array<{ id: string; action: "accept" | "reject" }>
  ) => {
    const res = await fetch("/api/proposals/edges/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    const data = await res.json() as {
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
      if (authUser?.id && selectedWorkspaceId) {
        const key = `brain-dump:graph-layout:${authUser.id}:${selectedWorkspaceId}`;
        try { localStorage.removeItem(key); } catch {}
      }

      setGraphData((prev) => ({
        ...prev,
        edges: [...prev.edges, ...newEdges],
        nodes: prev.nodes.map((n) => ({
          ...n,
          ...(updatedNodeMap.get(n.id) ?? {}),
          manual_position: false,
          position_x: null,
          position_y: null,
        })),
      }));
    } else if (updatedNodeMap.size > 0) {
      setGraphData((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) => ({
          ...node,
          ...(updatedNodeMap.get(node.id) ?? {}),
        })),
      }));
    }

    setEdgeReviewOpen(false);
    setProposedEdges([]);
  };

  const handleStatusChange = async (nodeId: string, status: Node["status"]) => {
    const previousNode = graphData.nodes.find((n) => n.id === nodeId);
    if (!previousNode) return;

    // Apply optimistic update immediately so the UI responds on first click.
    function applyStatusLocally(prev: GraphData, targetStatus: Node["status"]): GraphData {
      return {
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                status: targetStatus,
                completed_at:
                  targetStatus === "completed" ? new Date().toISOString() : n.completed_at,
              }
            : n,
        ),
        edges:
          targetStatus === "archived"
            ? prev.edges.map((e) =>
                e.source_node_id === nodeId || e.target_node_id === nodeId
                  ? { ...e, status: "orphaned" as const }
                  : e,
              )
            : prev.edges.map((e) =>
                (e.source_node_id === nodeId || e.target_node_id === nodeId) &&
                e.status === "orphaned"
                  ? { ...e, status: "active" as const }
                  : e,
              ),
      };
    }

    setGraphData((prev) => applyStatusLocally(prev, status));

    const res = await fetch(`/api/nodes/${nodeId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      // Revert optimistic update on failure
      setGraphData((prev) => applyStatusLocally(prev, previousNode.status));
      return;
    }

    const data = await res.json() as {
      updated_node?: Node | null;
      affected_children?: Array<{ id: string; title: string }>;
      recomputed_scores?: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }>;
    };
    const updatedNode = data.updated_node ?? null;
    const scoreMap = new Map(
      (data.recomputed_scores ?? []).map((s) => [s.id, s]),
    );

    // Merge authoritative server state (scores etc.) onto the already-optimistic UI
    setGraphData((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => {
        if (n.id === nodeId) {
          return {
            ...n,
            ...(updatedNode ?? {}),
            status,
            completed_at:
              updatedNode?.completed_at ??
              (status === "completed" ? new Date().toISOString() : n.completed_at),
          };
        }
        const scoreUpdate = scoreMap.get(n.id);
        if (scoreUpdate) {
          return {
            ...n,
            current_importance_score: scoreUpdate.current_importance_score,
            importance_index: scoreUpdate.importance_index,
            importance: scoreUpdate.importance as Node["importance"],
          };
        }
        return n;
      }),
    }));

    // 6.3 belongs_to cascade: prompt user about active child nodes
    if (status === "completed" && data.affected_children && data.affected_children.length > 0) {
      const parentTitle = graphData.nodes.find((n) => n.id === nodeId)?.title ?? null;
      setCascadeParentTitle(parentTitle);
      setCascadeChildren(data.affected_children);
    }
  };

  const handleCascadeComplete = async () => {
    setCascadeSubmitting(true);
    for (const child of cascadeChildren) {
      await fetch(`/api/nodes/${child.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
    }
    setGraphData((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        cascadeChildren.some((c) => c.id === n.id)
          ? { ...n, status: "completed" as const, completed_at: new Date().toISOString() }
          : n,
      ),
    }));
    setCascadeChildren([]);
    setCascadeParentTitle(null);
    setCascadeSubmitting(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
      <TopCommandBar
        onToggleSystemPanel={() => {
          setWorkspaceMenuOpen(false);
          setSystemPanelOpen((open) => !open);
        }}
        onToggleWorkspaceMenu={() => {
          setSystemPanelOpen(false);
          setWorkspaceMenuOpen((open) => !open);
        }}
        onSelectWorkspace={(workspaceId) => {
          setSelectedWorkspaceId(workspaceId);
          setWorkspaceMenuOpen(false);
        }}
        onCreateWorkspace={async (name) => {
          const res = await fetch("/api/workspaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) return;
          const workspace = (await res.json()) as Workspace;
          workspaceCreationFlowRef.current = {
            previousWorkspaceId: selectedWorkspaceId,
            workspaceId: workspace.id,
          };
          setWorkspaces((prev) => [...prev, workspace]);
          setSelectedWorkspaceId(workspace.id);
          setBootstrapWorkspaceId(workspace.id);
          setWorkspaceMenuOpen(false);
        }}
        onDeleteWorkspace={async (workspaceId) => {
          await deleteWorkspace(workspaceId);
        }}
        selectedWorkspaceId={selectedWorkspaceId}
        systemPanelOpen={systemPanelOpen}
        workspaces={workspaces}
        workspaceMenuOpen={workspaceMenuOpen}
        workspaceName={workspaceName}
      />

      <div className="relative flex h-[calc(100vh-64px)] min-h-0">
        <button
          aria-hidden={!systemPanelOpen && !workspaceMenuOpen}
          aria-label="Close panel"
          className={`absolute inset-0 z-10 transition-opacity duration-200 ease-out ${
            systemPanelOpen
              ? "bg-[rgba(0,0,0,0.22)] opacity-100"
              : workspaceMenuOpen
                ? "bg-transparent opacity-100"
                : "pointer-events-none opacity-0"
          }`}
          onClick={() => {
            setSystemPanelOpen(false);
            setWorkspaceMenuOpen(false);
          }}
          tabIndex={systemPanelOpen || workspaceMenuOpen ? 0 : -1}
          type="button"
        />

        <SystemPanel
          onClose={() => setSystemPanelOpen(false)}
          onSignOut={() => {
            void handleSignOut();
          }}
          open={systemPanelOpen}
          signingOut={signingOut}
          userEmail={authUser?.email ?? null}
        />

        <AnimatePresence mode="wait" initial={false}>
          {appMode === "graph" ? (
            <motion.div
              key="graph"
              className="flex min-w-0 flex-1"
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <MainStage
                cameraView={initialCameraView}
                createNodeDraft={createNodeDraft}
                createNodeError={createNodeError}
                createNodeSubmitting={createNodeSubmitting}
                deleteDescendantCount={selectedNodeDeletePlan?.descendantCount ?? 0}
                deleteEdgeCount={selectedNodeDeletePlan?.edgeIds.length ?? 0}
                deleteNodeCount={selectedNodeDeletePlan?.nodeIds.length ?? 1}
                deleteNodeConfirmOpen={deleteNodeConfirmOpen}
                deleteNodeSubmitting={deleteNodeSubmitting}
                editMode={editMode}
                editNodeDraft={editNodeDraft}
                editNodeError={editNodeError}
                editNodeSubmitting={editNodeSubmitting}
                edgeConnectionDeleteSubmittingId={edgeDeleteSubmittingId}
                edgeConnectionError={edgeError}
                edgeConnectionRelationId={edgeRelationId}
                edgeConnectionSubmitting={edgeSubmitting}
                edgeConnectionTargetId={edgeTargetId}
                edgeConnectionTargetOptions={connectableNodes}
                edgeConnectionTypeOptions={visibleEdgeRelationOptions}
                edgeConnectionUpdateSubmittingId={edgeUpdateSubmittingId}
                edgeConnections={selectedNodeConnections}
                graphData={filteredGraphData}
                graphLoading={graphLoading}
                graphImportanceFilter={importanceFilter}
                graphSearchValue={graphSearchValue}
                graphTypeFilter={nodeTypeFilter}
                graphTypeFilterOptions={nodeTypeFilterOptions}
                graphImportanceFilterOptions={importanceFilterOptions.map((option) => ({
                  label: option.label,
                  value: option.value,
                }))}
                onCameraViewChange={setCameraView}
                onCancelDeleteNode={() => setDeleteNodeConfirmOpen(false)}
                onChangeCreateNodeField={handleChangeCreateNodeField}
                onChangeEditNodeField={handleChangeEditNodeField}
                onChangeNewEdgeConnectionRelation={setEdgeRelationId}
                onChangeNewEdgeConnectionTarget={setEdgeTargetId}
                onCommitNodePosition={handleCommitNodePosition}
                onConfirmDeleteNode={() => {
                  void handleDeleteNode();
                }}
                onCloseCreateNode={handleCloseCreateNode}
                onCloseEditNode={handleCloseEditNode}
                onCreateEdgeConnection={() => {
                  void handleSubmitCreateEdge();
                }}
                onDeleteEdgeConnection={(edgeId) => {
                  void handleDeleteEdge(edgeId);
                }}
                onChangeGraphImportanceFilter={(value) =>
                  setImportanceFilter(
                    value as (typeof importanceFilterOptions)[number]["value"],
                  )
                }
                onGraphSearchChange={setGraphSearchValue}
                onGraphSearchSubmit={handleGraphSearchSubmit}
                onChangeGraphTypeFilter={setNodeTypeFilter}
                onOpenCreateNode={handleOpenCreateNode}
                onResetGraphFilters={handleResetFilters}
                onToggleShowArchived={() => setShowArchived((v) => !v)}
                showArchived={showArchived}
                hideCompleted={hideCompleted}
                onToggleHideCompleted={() => setHideCompleted((v) => !v)}
                onToggleEditMode={handleToggleEditMode}
                onRequestDeleteNode={() => setDeleteNodeConfirmOpen(true)}
                onSelectNode={handleSelectNode}
                onSubmitCreateNode={() => {
                  void handleSubmitCreateNode();
                }}
                onSubmitEditNode={() => {
                  void handleSubmitEditNode();
                }}
                onUpdateEdgeConnection={(edgeId, relationId) => {
                  void handleUpdateEdge(edgeId, relationId);
                }}
                selectedNodeId={selectedNodeId}
                suppressInitialFocusAnimation={suppressInitialFocusAnimation}
              />
              <ContextRail
                activeTab={activeRailTab}
                chatInputValue={railChatInput}
                chatLoading={chatLoading}
                chatMessages={chatMessages}
                chatScope={chatScope}
                graphData={graphData}
                onChatInputChange={setRailChatInput}
                onClearChatScope={() => setChatScope(createWorkspaceScope(workspaceName))}
                onRetryChat={retryLastMessage}
                onSelectPrompt={(prompt) => {
                  void submitMessage(prompt);
                }}
                onSetActiveTab={setActiveRailTab}
                onStatusChange={(nodeId, status) => {
                  void handleStatusChange(nodeId, status);
                }}
                onFindConnections={(nodeId) => {
                  if (!selectedWorkspaceId) return;
                  void analyzeNodes([nodeId]);
                }}
                onSelectLinkedNode={handleSelectNode}
                onSubmitChatInput={(message) => {
                  void submitMessage(message);
                }}
                onSaveAnswerAsNode={(text) => {
                  if (!selectedWorkspaceId) return;
                  // Pre-fill create node form with the assistant's answer text
                  setCreateNodeDraft({
                    ...defaultCreateNodeDraft,
                    node_type: "concept",
                    raw_text: text.slice(0, 800),
                    title: text.split(/[.!?]/)[0]?.slice(0, 80).trim() ?? "Assistant note",
                  });
                }}
                onToggle={() => setRightPanelOpen((open) => !open)}
                open={rightPanelOpen}
                selectedNode={selectedNode}
              />
            </motion.div>
          ) : (
            <motion.div
              key="assistant"
              className="flex min-w-0 flex-1"
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <AssistantModeView
                graphData={graphData}
                selectedNodeId={selectedNodeId}
                workspaceId={selectedWorkspaceId}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Proposed nodes review — centered modal */}
      <AnimatePresence>
        {proposedReviewOpen && proposedNodes.length > 0 && (
          <motion.div
            key="prn-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ background: "rgba(0,0,0,0.45)" }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setProposedReviewOpen(false);
                setProposedNodes([]);
              }
            }}
          >
            <ProposedNodesReview
              existingNodeTitles={existingNodeTitleMap}
              proposals={proposedNodes}
              onAccept={handleProposalReview}
              onClose={() => {
                setProposedReviewOpen(false);
                setProposedNodes([]);
              }}
              submitting={false}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI status chip — shown during extraction and connection analysis */}
      <AnimatePresence>
        {(brainDumpSubmitting || analyzingConnections) && (
          <motion.div
            key="ai-status"
            className="ai-status-chip"
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <span className="ai-status-dot" />
            {brainDumpSubmitting ? "Extracting nodes…" : "Finding connections…"}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {aiNotice && (
          <motion.div
            key={`${aiNotice.tone}:${aiNotice.message}`}
            className={`ai-notice ai-notice--${aiNotice.tone}`}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <span>{aiNotice.message}</span>
            <button
              className="ai-notice-dismiss"
              onClick={() => setAiNotice(null)}
              type="button"
            >
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Merge duplicate alerts */}
      {mergeCandidates.length > 0 && (
        <MergeAlert
          candidates={mergeCandidates}
          onKeepBoth={(c) => {
            // Dismiss — keep both, record in DB (best-effort)
            void fetch(`/api/nodes/merge-suggestions/${c.suggestion_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "dismissed" }),
            });
            setMergeCandidates((prev) => prev.filter((x) => x.new_node_id !== c.new_node_id));
          }}
          onNever={(c) => {
            // Suppress pair forever
            void fetch(`/api/nodes/merge-suggestions/${c.suggestion_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "never" }),
            });
            setMergeCandidates((prev) => prev.filter((x) => x.new_node_id !== c.new_node_id));
          }}
          onMerge={(c) => {
            // Safe merge: reattach edges from new → existing, archive new
            void fetch(`/api/nodes/${c.new_node_id}/merge`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                target_node_id: c.existing_node_id,
                suggestion_id: c.suggestion_id,
              }),
            })
              .then((r) => r.json() as Promise<{
                archived_node_id?: string;
                recomputed_scores?: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }>;
              }>)
              .then((data) => {
                const scoreMap = new Map(
                  (data.recomputed_scores ?? []).map((s) => [s.id, s]),
                );
                setGraphData((prev) => ({
                  ...prev,
                  nodes: prev.nodes
                    .filter((n) => n.id !== data.archived_node_id)
                    .map((n) => {
                      const scoreUpdate = scoreMap.get(n.id);
                      return scoreUpdate
                        ? {
                            ...n,
                            current_importance_score: scoreUpdate.current_importance_score,
                            importance_index: scoreUpdate.importance_index,
                            importance: scoreUpdate.importance as Node["importance"],
                          }
                        : n;
                    }),
                  edges: prev.edges.filter(
                    (e) =>
                      e.source_node_id !== data.archived_node_id &&
                      e.target_node_id !== data.archived_node_id,
                  ),
                }));
                setMergeCandidates((prev) => prev.filter((x) => x.new_node_id !== c.new_node_id));
              })
              .catch(() => {
                // If merge fails, still dismiss from UI
                setMergeCandidates((prev) => prev.filter((x) => x.new_node_id !== c.new_node_id));
              });
          }}
        />
      )}

      {/* Proposed edges review — centered modal */}
      {edgeReviewOpen && proposedEdges.length > 0 && (
        <ProposedEdgesReview
          edges={proposedEdges}
          onConfirm={(actions) => void handleEdgeReview(actions)}
          onDismiss={() => {
            setEdgeReviewOpen(false);
            setProposedEdges([]);
          }}
        />
      )}

      {/* 6.3 belongs_to cascade dialog */}
      <AnimatePresence>
        {cascadeChildren.length > 0 && (
          <motion.div
            key="cascade-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.45)" }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              className="cascade-dialog"
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              initial={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.15 }}
            >
              <p className="cascade-dialog-heading">
                You completed{cascadeParentTitle ? ` "${cascadeParentTitle}"` : " a parent node"}.
              </p>
              <p className="cascade-dialog-sub">
                {cascadeChildren.length === 1
                  ? "This child node is still active. Is it also done?"
                  : `${cascadeChildren.length} child nodes are still active. Are they also done?`}
              </p>
              <ul className="cascade-dialog-list">
                {cascadeChildren.map((child) => (
                  <li key={child.id} className="cascade-dialog-item">
                    {child.title}
                  </li>
                ))}
              </ul>
              <div className="cascade-dialog-actions">
                <button
                  className="cascade-dialog-btn-skip"
                  disabled={cascadeSubmitting}
                  onClick={() => {
                    setCascadeChildren([]);
                    setCascadeParentTitle(null);
                  }}
                  type="button"
                >
                  Skip
                </button>
                <button
                  className="cascade-dialog-btn-confirm"
                  disabled={cascadeSubmitting}
                  onClick={() => void handleCascadeComplete()}
                  type="button"
                >
                  {cascadeSubmitting ? "Marking done…" : "Mark all done"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating dock / brain dump overlay */}

      <AnimatePresence mode="wait" initial={false}>
        {brainDumpOpen ? (
          <motion.div
            key="brain-dump"
            className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <BrainDumpOverlay
              errorMessage={brainDumpError}
              onChange={setBrainDumpValue}
              onClose={() => {
                setBrainDumpOpen(false);
                setBrainDumpWorkspaceId(null);
                setBrainDumpValue("");
                setBrainDumpError(null);
                setBrainDumpFailedEntryId(null);
              }}
              onRetry={() => void handleBrainDumpRetry()}
              onSubmit={() => void handleBrainDumpSubmit()}
              retryAvailable={Boolean(brainDumpFailedEntryId)}
              retrying={brainDumpRetrying}
              submitting={brainDumpSubmitting}
              value={brainDumpValue}
            />
          </motion.div>
        ) : (
          <motion.div
            key="dock"
            className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <ModeDock
              mode={appMode}
              onSetMode={setAppMode}
              onOpenBrainDump={() => {
                setBrainDumpError(null);
                setBrainDumpFailedEntryId(null);
                setBrainDumpWorkspaceId(selectedWorkspaceId);
                setBrainDumpOpen(true);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Workspace bootstrap wizard — shown when bootstrapWorkspaceId matches current workspace */}
      {bootstrapWorkspaceId && bootstrapWorkspaceId === selectedWorkspaceId && (
        <WorkspaceBootstrapWizard
          workspaceId={selectedWorkspaceId}
          workspaceName={workspaceName}
          onComplete={() => {
            if (workspaceCreationFlowRef.current?.workspaceId === selectedWorkspaceId) {
              workspaceCreationFlowRef.current = null;
            }
            setBootstrapWorkspaceId(null);
            // Show tutorial after bootstrap for new users
            if (!tutorialShownRef.current && authUser && shouldShowTutorial(authUser.id)) {
              tutorialShownRef.current = true;
              setShowTutorial(true);
            }
            void loadWorkspaceGraphData(
              authUser?.id ?? null,
              selectedWorkspaceId,
              selectedWorkspace?.name ?? null,
            ).then((nextGraphData) => {
              setGraphData(nextGraphData);
            });
          }}
          onSkip={() => {
            void handleCancelWorkspaceCreation();
          }}
        />
      )}

      {/* Onboarding tutorial — shown once per user */}
      {showTutorial && authUser && (
        <OnboardingTutorial userId={authUser.id} onDone={() => setShowTutorial(false)} />
      )}
    </div>
  );
}
