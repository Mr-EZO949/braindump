"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { MainStage } from "@/components/graph/main-stage";
import { AssistantMode as AssistantModeView } from "@/components/assistant/assistant-mode";
import { TodosView } from "@/components/ui/todos-view";
import { HabitsView } from "@/components/ui/habits-view";
import { RoadmapView } from "@/components/ui/roadmap-view";
import { PomodoroView } from "@/components/ui/pomodoro-view";
import { ModeDock, type AppMode } from "@/components/ui/mode-dock";
import { BrainDumpOverlay } from "@/components/ui/brain-dump-overlay";
import { WhatNowDialog } from "@/components/ui/what-now-dialog";
import { WeeklyReflectionModal } from "@/components/ui/weekly-reflection-modal";
import {
  listChatSessions,
  loadChatSession,
  upsertChatSession,
  deleteChatSession,
  type ChatSessionMeta,
} from "@/lib/chat/sessions";
import { ProposedNodesReview } from "@/components/ui/proposed-nodes-review";
import { ProposedEdgesReview } from "@/components/ui/proposed-edges-review";
import { GraphEditReview } from "@/components/ui/graph-edit-review";
import { MergeAlert } from "@/components/ui/merge-alert";
import { NudgeRibbon } from "@/components/nudges/nudge-ribbon";
import { WorkspaceBootstrapWizard } from "@/components/ui/workspace-bootstrap-wizard";
import { WelcomeScreen, shouldShowWelcome, markWelcomeDone } from "@/components/ui/onboarding-tutorial";
import { GuidedTour } from "@/components/ui/guided-tour";
import { FocusTimerPill } from "@/components/ui/focus-timer-pill";
import { useFocusTimer } from "@/hooks/use-focus-timer";
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
  persistLocalSelectedWorkspaceId,
  persistLocalSelectedNode,
  readLocalSelectedWorkspaceId,
  readLocalGraphViewState,
  removeLocalNodePosition,
  type LocalGraphCameraView,
} from "@/lib/graph/data";

import {
  findChildlessProjects,
  looksLikeBrainDump,
} from "@/lib/graph/dump-heuristic";
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
import { createPauseMarkerParser } from "@/lib/chat/pause-marker";
import { classifyTaskSize } from "@/lib/ai/sizing";
import { needsNextAction } from "@/lib/graph/next-action";
import type { RailTab, ChatMessage, ChatScope, Nudge, PendingAction } from "@/types/chat";
import type { CreateNodeInput, Edge, GraphData, GraphEditOperation, Node, NodeType, Workspace } from "@/types/graph";
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
  failed_node_ids?: string[];
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
  manual_weight: null,
  node_type: "concept",
  raw_text: "",
  summary: "",
  body: "",
  title: "",
  target_date: "",
};

const nodeColorByType: Record<Exclude<CreateNodeInput["node_type"], "custom">, string> = {
  class: "#96784d",
  concept: "#677480",
  goal: "#d8d0c4",
  habit: "#4a7c6b",
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
    manual_weight: typeof node.manual_weight === "number" ? node.manual_weight : null,
    node_type: nodeType,
    raw_text: node.raw_text ?? "",
    summary: node.summary ?? "",
    body: node.body ?? "",
    title: node.title,
    target_date: typeof node.target_date === "string" ? node.target_date : "",
  };
}

const CHAT_HISTORY_MAX = 200;

function getChatHistoryKey(userId: string | null, workspaceId: string | null): string | null {
  if (!userId || !workspaceId) return null;
  return `brain-dump:chat-history:${userId}:${workspaceId}`;
}

function readChatHistory(
  userId: string | null,
  workspaceId: string | null,
): ChatMessage[] {
  if (typeof window === "undefined") return [];
  const key = getChatHistoryKey(userId, workspaceId);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function writeChatHistory(
  userId: string | null,
  workspaceId: string | null,
  messages: ChatMessage[],
): void {
  if (typeof window === "undefined") return;
  const key = getChatHistoryKey(userId, workspaceId);
  if (!key) return;
  try {
    const trimmed = messages.slice(-CHAT_HISTORY_MAX);
    window.localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    // Ignore storage failures — chat still works in memory.
  }
}

// Weekly reflection unlocks on Sunday (JS Date.getDay() === 0). For dev/QA,
// localStorage flag `dev:unlock-weekly=1` overrides the check.
function isWeeklyReflectionAvailable(now = new Date()): boolean {
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage.getItem("dev:unlock-weekly") === "1") return true;
    } catch {
      // ignore
    }
  }
  return now.getDay() === 0;
}

function getChatSessionIdKey(userId: string | null, workspaceId: string | null): string | null {
  if (!userId || !workspaceId) return null;
  return `brain-dump:chat-session-id:${userId}:${workspaceId}`;
}

function readChatSessionId(userId: string | null, workspaceId: string | null): string | null {
  if (typeof window === "undefined") return null;
  const key = getChatSessionIdKey(userId, workspaceId);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeChatSessionId(
  userId: string | null,
  workspaceId: string | null,
  sessionId: string | null,
): void {
  if (typeof window === "undefined") return;
  const key = getChatSessionIdKey(userId, workspaceId);
  if (!key) return;
  try {
    if (sessionId) window.localStorage.setItem(key, sessionId);
    else window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
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
  const [whatNowOpen, setWhatNowOpen] = useState(false);
  const [weeklyReflectionOpen, setWeeklyReflectionOpen] = useState(false);
  // Bumped whenever the server cascades plan_tasks updates (e.g. graph
  // completion auto-marked a linked task). The planner subscribes via prop
  // and re-loads its tasks list when the key changes — keeps the two views
  // in sync without a full page refresh.
  const [plannerRefreshKey, setPlannerRefreshKey] = useState(0);
  const [proposedNodes, setProposedNodes] = useState<ProposedNode[]>([]);
  const [proposedReviewOpen, setProposedReviewOpen] = useState(false);
  const [proposedNodesSubmitting, setProposedNodesSubmitting] = useState(false);
  // Clarifying questions returned alongside (or instead of) proposals — the
  // extractor asks back when the dump is vague. Paired with the raw dump
  // text so the chat seed can echo the full context.
  const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
  const [lastDumpRawText, setLastDumpRawText] = useState<string>("");
  // Flag set when the proposed-nodes review was opened by the bootstrap
  // wizard handoff. We use it to skip the auto suggest-steps modal +
  // post-acceptance connection analysis so a first dump doesn't dogpile
  // the user with three modals + several Sonnet calls. They can still
  // trigger suggest-steps manually from any node's details panel.
  const [proposalsFromBootstrap, setProposalsFromBootstrap] = useState(false);
  const [stepSuggestionNodes, setStepSuggestionNodes] = useState<Array<{ id: string; title: string; summary: string | null; node_type: string }>>([]);
  const [stepSuggestionOpen, setStepSuggestionOpen] = useState(false);
  const [stepSuggestionLoading, setStepSuggestionLoading] = useState(false);
  const [graphEditOps, setGraphEditOps] = useState<GraphEditOperation[]>([]);
  const [graphEditReviewOpen, setGraphEditReviewOpen] = useState(false);
  const [proposedEdges, setProposedEdges] = useState<ProposedEdgeWithNodes[]>([]);
  const [edgeReviewOpen, setEdgeReviewOpen] = useState(false);
  const [analyzingConnections, setAnalyzingConnections] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [aiNotice, setAiNotice] = useState<AINotice | null>(null);
  const [lastAnalysisNodeIds, setLastAnalysisNodeIds] = useState<string[]>([]);
  const [lastAnalysisFailedNodeIds, setLastAnalysisFailedNodeIds] = useState<string[]>([]);
  const [lastAnalysisWorkspaceId, setLastAnalysisWorkspaceId] = useState<string | null>(null);
  const [findAllConfirmOpen, setFindAllConfirmOpen] = useState(false);

  // Panel state.
  // IMPORTANT: this must initialize to the SAME value the server renders
  // (true) — reading window.matchMedia in the initializer makes the first
  // client render diverge from SSR on mobile and breaks hydration. The real
  // viewport-derived value is applied in a mount effect below, after
  // hydration, so there is no server/client mismatch.
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [systemPanelOpen, setSystemPanelOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>("details");
  const [railChatInput, setRailChatInput] = useState("");
  // When a chat message looks like a brain dump, we hold it here and show an
  // inline "Brain dump / Just chatting" chooser instead of routing silently.
  const [pendingDumpText, setPendingDumpText] = useState<string | null>(null);
  // When a freshly-created task looks like a multi-session project, we hold it
  // here and show an inline "break it down?" chooser in the chat rail (the
  // sizing layer — see lib/ai/sizing.ts).
  const [pendingSizeBreakdown, setPendingSizeBreakdown] = useState<{
    nodeId: string;
    title: string;
  } | null>(null);
  // Project ids we've already offered a roadmap for this session — so the
  // in-thread "want a roadmap?" prompt never nags about the same project.
  const roadmapPromptedRef = useRef<Set<string>>(new Set());
  // Container ids we've already auto-suggested a next action for via Focus —
  // so re-focusing an empty/declined container doesn't re-fire a billable
  // suggest-steps call each time.
  const focusSuggestedRef = useRef<Set<string>>(new Set());

  // Apply the viewport-derived default for the right panel AFTER hydration.
  // On mobile the rail should start closed; doing this in an effect (not the
  // useState initializer) keeps the first client render identical to the
  // server's, avoiding the hydration mismatch. Runs once on mount.
  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setRightPanelOpen(false);
    }
  }, []);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatScope, setChatScope] = useState<ChatScope>(createWorkspaceScope("General"));
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingActionBusy, setPendingActionBusy] = useState(false);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const chatAbortRef = useRef<AbortController | null>(null);

  // Chat history (persistent sessions)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const chatSessionIdRef = useRef<string | null>(null);
  const chatSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Graph state
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphSearchValue, setGraphSearchValue] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const [authUser, setAuthUser] = useState<AuthUserState | null>(initialUser);
  const [signingOut, setSigningOut] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [nodeTypeFilter, setNodeTypeFilter] = useState("all");
  const [importanceFilter, setImportanceFilter] =
    useState<(typeof importanceFilterOptions)[number]["value"]>("all");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  // Focus timer — one persistent Pomodoro per workspace, backed by localStorage
  // so it survives mode/view switches and reloads. Lives at the shell so the
  // pill renders above every view.
  const focusTimer = useFocusTimer(selectedWorkspaceId);
  // Minimal hand-rolled toast (no library). Cleared after ~3s.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );
  const [cameraView, setCameraView] = useState<LocalGraphCameraView | null>(null);
  // initialCameraView removed — graph-canvas now always computes a fresh fitted view
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
  // Bootstrap wizard — shown when a new empty workspace is created OR loaded empty
  const [bootstrapWorkspaceId, setBootstrapWorkspaceId] = useState<string | null>(null);
  // Welcome screen — shown once per user on first login
  const [showWelcome, setShowWelcome] = useState(false);
  // Guided tour — shown after workspace wizard during onboarding
  const [showTour, setShowTour] = useState(false);
  const workspaceCreationFlowRef = useRef<{
    previousWorkspaceId: string | null;
    workspaceId: string;
  } | null>(null);
  const pendingAnalysisRef = useRef<{ nodeIds: string[]; workspaceId: string } | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const workspaceName = selectedWorkspace?.name ?? "General";

  const selectedNode = useMemo(
    () => buildChatNodeContext(graphData, selectedNodeId),
    [graphData, selectedNodeId],
  );

  const nodeTypeCounts = useMemo(() => {
    const bucket = new Map<string, number>();
    for (const node of graphData.nodes) {
      if (node.status === "archived" || node.status === "completed") continue;
      bucket.set(node.node_type, (bucket.get(node.node_type) ?? 0) + 1);
    }
    return Array.from(bucket.entries())
      .map(([type, count]) => ({
        type: type as NodeType,
        label: formatNodeTypeLabel(type),
        count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [graphData.nodes]);

  const nodeTypeTotalCount = useMemo(
    () => nodeTypeCounts.reduce((sum, item) => sum + item.count, 0),
    [nodeTypeCounts],
  );

  // Completed nodes are hidden by default; user can reveal them via the filter bar.
  const [hideCompleted, setHideCompleted] = useState(true);

  const completedNodes = useMemo(
    () => graphData.nodes.filter((node) => node.status === "completed"),
    [graphData.nodes],
  );

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
        const storedWorkspaceId = readLocalSelectedWorkspaceId(authUser?.id ?? null);

        if (
          currentWorkspaceId &&
          nextWorkspaces.some((workspace) => workspace.id === currentWorkspaceId)
        ) {
          return currentWorkspaceId;
        }

        if (
          storedWorkspaceId &&
          nextWorkspaces.some((workspace) => workspace.id === storedWorkspaceId)
        ) {
          return storedWorkspaceId;
        }

        return (
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

      // For empty workspaces: show welcome for brand-new users,
      // or go straight to the wizard if welcome was already seen
      if (
        nextGraphData.nodes.length === 0 &&
        selectedWorkspaceId &&
        authUser
      ) {
        if (shouldShowWelcome(authUser.id)) {
          setShowWelcome(true);
        } else if (!selectedWorkspace?.bootstrap_completed_at) {
          setBootstrapWorkspaceId(selectedWorkspaceId);
        }
      }
    });

    return () => {
      active = false;
    };
  }, [authUser?.id, selectedWorkspace?.name, selectedWorkspaceId, selectedWorkspace?.bootstrap_completed_at]);

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
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED" && !session) {
        // Redirect to login when session is lost (e.g. invalid refresh token)
        router.push("/login");
        return;
      }

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

  // Keep chat scope in sync with node selection — when the user selects a
  // different node (or deselects), update the scope so the assistant always
  // has the right context.  This also covers the empty-messages case.
  useEffect(() => {
    setChatScope(defaultChatScope);
  }, [defaultChatScope]);

  useEffect(() => {
    if (workspaces.length === 0) {
      return;
    }

    persistLocalSelectedWorkspaceId(authUser?.id ?? null, selectedWorkspaceId);
  }, [authUser?.id, selectedWorkspaceId, workspaces.length]);

  useEffect(() => {
    // Workspace-switch reset. Keyed on selectedWorkspaceId (stable across
    // a workspace's lifetime) rather than workspaceName — the latter
    // briefly resolves from "General" → the actual name during bootstrap,
    // which would re-run this effect mid-flow and wipe any in-flight chat
    // messages (e.g. inline answers from the proposed-nodes review) that
    // hadn't been flushed to localStorage yet.
    setSelectedNodeId(null);
    setGraphSearchValue("");
    setRailChatInput("");
    setChatMessages(readChatHistory(authUser?.id ?? null, selectedWorkspaceId));
    const storedSessionId = readChatSessionId(authUser?.id ?? null, selectedWorkspaceId);
    setChatSessionId(storedSessionId);
    chatSessionIdRef.current = storedSessionId;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId]);

  useEffect(() => {
    writeChatHistory(authUser?.id ?? null, selectedWorkspaceId, chatMessages);
  }, [authUser?.id, selectedWorkspaceId, chatMessages]);

  // Keep the ref + localStorage in sync so the debounced save reads the current
  // session id and reloads restore it across page refreshes.
  useEffect(() => {
    chatSessionIdRef.current = chatSessionId;
    writeChatSessionId(authUser?.id ?? null, selectedWorkspaceId, chatSessionId);
  }, [chatSessionId, authUser?.id, selectedWorkspaceId]);

  // Debounced persistence to Supabase — fires 800ms after the last change.
  useEffect(() => {
    if (!authUser?.id || !selectedWorkspaceId) return;
    if (chatMessages.length === 0) return;

    if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
    chatSaveTimerRef.current = setTimeout(() => {
      void (async () => {
        const saved = await upsertChatSession({
          id: chatSessionIdRef.current,
          workspaceId: selectedWorkspaceId,
          scope: chatScope,
          messages: chatMessages,
        });
        if (saved) {
          if (!chatSessionIdRef.current) {
            chatSessionIdRef.current = saved.id;
            setChatSessionId(saved.id);
          }
          setChatSessions((prev) => {
            const filtered = prev.filter((s) => s.id !== saved.id);
            return [
              { ...(prev.find((s) => s.id === saved.id) ?? {} as ChatSessionMeta), ...saved },
              ...filtered,
            ];
          });
        }
      })();
    }, 800);

    return () => {
      if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
    };
  }, [authUser?.id, selectedWorkspaceId, chatMessages, chatScope]);


  // Load the list of past sessions when workspace changes. The workspace-switch
  // effect above already sets chatSessionId from localStorage, so we only
  // refresh the list here.
  useEffect(() => {
    if (!selectedWorkspaceId) {
      setChatSessions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await listChatSessions(selectedWorkspaceId);
      if (!cancelled) setChatSessions(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  const handleStartNewChat = () => {
    if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
    setChatMessages([]);
    setChatSessionId(null);
    chatSessionIdRef.current = null;
    setChatScope(createWorkspaceScope(workspaceName));
    setChatHistoryOpen(false);
  };

  const handleLoadChatSession = async (sessionId: string) => {
    const detail = await loadChatSession(sessionId);
    if (!detail) return;
    if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
    setChatSessionId(detail.id);
    chatSessionIdRef.current = detail.id;
    setChatMessages(detail.messages ?? []);
    if (detail.scope_kind === "node" && detail.scope_node_id) {
      const node = buildChatNodeContext(graphData, detail.scope_node_id);
      if (node) {
        setChatScope(createNodeScope(workspaceName, node));
      } else {
        setChatScope(createWorkspaceScope(workspaceName));
      }
    } else {
      setChatScope(createWorkspaceScope(workspaceName));
    }
    setActiveRailTab("chat");
    setRightPanelOpen(true);
    setChatHistoryOpen(false);
  };

  const handleDeleteChatSession = async (sessionId: string) => {
    const ok = await deleteChatSession(sessionId);
    if (!ok) return;
    setChatSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (sessionId === chatSessionIdRef.current) {
      setChatMessages([]);
      setChatSessionId(null);
      chatSessionIdRef.current = null;
    }
  };

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setNudges([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/assistant/nudges?workspace_id=${encodeURIComponent(selectedWorkspaceId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { nudges?: Nudge[] };
        if (!cancelled) setNudges(data.nudges ?? []);
      } catch {
        // Nudges are optional — failing silently keeps the empty-state clean.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    const localViewState = readLocalGraphViewState(authUser?.id ?? null, selectedWorkspaceId);

    setViewStateHydrated(false);
    setPendingRestoredSelectionId(localViewState.selectedNodeId);
    setSuppressInitialFocusAnimation(Boolean(localViewState.selectedNodeId));
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

  const handleExtractNodes = async (
    nodesContent: string,
    wsId: string,
    options?: { defaultParentNodeId?: string },
  ) => {
    try {
      const entryRes = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: nodesContent,
          workspace_id: wsId,
          source_type: "assistant_save",
          default_parent_node_id: options?.defaultParentNodeId ?? null,
        }),
      });
      const entryData = await entryRes.json() as {
        proposed_nodes?: ProposedNode[];
        clarifying_questions?: string[];
      };
      const nodes = entryData.proposed_nodes ?? [];
      const questions = entryData.clarifying_questions ?? [];
      if (entryRes.ok && (nodes.length > 0 || questions.length > 0)) {
        setProposedNodes(nodes);
        setClarifyingQuestions(questions);
        setLastDumpRawText(nodesContent);
        setProposedReviewOpen(true);
      }
    } catch {
      // Extraction failed silently
    }
  };

  // Streams /api/assistant/chat (or /resume) into the assistant bubble.
  // Handles the <<BRAINDUMP_PAUSE>> marker: when seen, attaches a pending
  // action to the bubble so the user gets an inline Accept/Reject card.
  // Also runs the legacy <nodes> / <graph_edit> / <recompute_scores/> post-
  // processing on the marker-stripped final text.
  const consumeAssistantStream = async (
    res: Response,
    assistantMsgId: string,
    targetWorkspaceId: string | null,
    appendToExistingBody = false,
  ) => {
    if (!res.ok || !res.body) {
      throw new Error("Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createPauseMarkerParser();
    let cleanText = "";
    let sawPause = false;

    // Snapshot the pre-stream body once so appends don't accumulate on top
    // of their own prior output. Each write then sets body = base + stream.
    const baseBody = appendToExistingBody
      ? (chatMessages.find((m) => m.id === assistantMsgId)?.body.trimEnd() ?? "")
      : "";

    const writeBody = (nextCleanText: string) => {
      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          if (appendToExistingBody) {
            const joiner = baseBody.length > 0 && nextCleanText.length > 0 ? "\n\n" : "";
            return { ...m, body: baseBody + joiner + nextCleanText };
          }
          return { ...m, body: nextCleanText };
        }),
      );
    };

    const attachPending = (action: PendingAction) => {
      setChatMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, pendingAction: action } : m)),
      );
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const parsed = parser.push(chunk);
      if (parsed.text.length > 0) {
        cleanText += parsed.text;
        writeBody(cleanText);
      }
      if (parsed.pause && !sawPause) {
        sawPause = true;
        attachPending({ ...parsed.pause, status: "awaiting" });
      }
    }
    const tail = parser.flush();
    if (tail.text.length > 0) {
      cleanText += tail.text;
      writeBody(cleanText);
    }

    if (sawPause) return;

    // Legacy tag post-processing — only when we reached end_turn (no pause).
    const nodesMatch = cleanText.match(/<nodes>\s*([\s\S]*?)\s*<\/nodes>/);
    if (nodesMatch && nodesMatch[1]?.trim() && targetWorkspaceId) {
      const nodesContent = nodesMatch[1].trim();
      cleanText = cleanText.replace(/<nodes>[\s\S]*?<\/nodes>/, "").trimEnd();
      writeBody(cleanText);
      void handleExtractNodes(nodesContent, targetWorkspaceId);
    }

    if (/<recompute_scores\s*\/?>/.test(cleanText) && targetWorkspaceId) {
      cleanText = cleanText.replace(/<recompute_scores\s*\/?>/g, "").trimEnd();
      writeBody(cleanText);

      fetch("/api/nodes/scores/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: targetWorkspaceId }),
      })
        .then(async (scoreRes) => {
          if (scoreRes.ok) {
            const nextGraphData = await loadWorkspaceGraphData(
              authUser?.id ?? null,
              targetWorkspaceId,
              selectedWorkspace?.name ?? null,
            );
            setGraphData(nextGraphData);
          }
        })
        .catch(() => {
          // Score recompute failed silently
        });
    }

    const editMatch = cleanText.match(/<graph_edit>\s*([\s\S]*?)\s*<\/graph_edit>/);
    if (editMatch && editMatch[1]?.trim() && targetWorkspaceId) {
      cleanText = cleanText.replace(/<graph_edit>[\s\S]*?<\/graph_edit>/, "").trimEnd();
      writeBody(cleanText);
      try {
        const parsedOps = JSON.parse(editMatch[1].trim()) as GraphEditOperation[];
        if (Array.isArray(parsedOps) && parsedOps.length > 0) {
          setGraphEditOps(parsedOps);
          setGraphEditReviewOpen(true);
        }
      } catch {
        // Invalid JSON — ignore silently
      }
    }
  };

  const submitMessage = async (message: string, duplicateUserMessage = true) => {
    const trimmedMessage = message.trim();

    if (trimmedMessage.length === 0 || chatLoading) {
      return;
    }

    const nextScope = chatMessages.length === 0 ? defaultChatScope : chatScope;
    const targetWorkspaceId = selectedWorkspaceId;

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

    // Prior turns in this thread — send as plain {role, body} so the server
    // can compress old ones if the history gets long.
    const history = chatMessages
      .filter((m) => (m.body ?? "").trim().length > 0 && m.status !== "error")
      .map((m) => ({ role: m.role, body: m.body }));

    const abortCtrl = new AbortController();
    chatAbortRef.current = abortCtrl;

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage,
          workspace_id: targetWorkspaceId,
          selected_node_id: nextScope.kind === "node" ? nextScope.node.id : null,
          history,
        }),
        signal: abortCtrl.signal,
      });

      await consumeAssistantStream(res, assistantMsgId, targetWorkspaceId);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        setChatMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsgId) return m;
            const body = m.body.trim().length > 0 ? m.body : "Stopped.";
            return { ...m, body, status: "ready" as const };
          }),
        );
      } else {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, body: "Response unavailable. Try again.", status: "error" as const }
              : m,
          ),
        );
      }
    } finally {
      if (chatAbortRef.current === abortCtrl) chatAbortRef.current = null;
      setChatLoading(false);
    }
  };

  const cancelChat = () => {
    chatAbortRef.current?.abort();
  };

  const resolvePendingAction = async (
    messageId: string,
    decision: "accept" | "reject" | "choice",
    choice?: string,
  ) => {
    if (pendingActionBusy) return;

    const target = chatMessages.find((m) => m.id === messageId);
    const action = target?.pendingAction;
    if (!action || action.status !== "awaiting") return;

    const targetWorkspaceId = selectedWorkspaceId;

    setPendingActionBusy(true);
    setChatLoading(true);
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.pendingAction
          ? {
              ...m,
              pendingAction: {
                ...m.pendingAction,
                status: decision === "reject" ? "rejected" : "accepted",
              },
            }
          : m,
      ),
    );

    const abortCtrl = new AbortController();
    chatAbortRef.current = abortCtrl;

    try {
      const res = await fetch("/api/assistant/chat/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: action.runId, decision, choice }),
        signal: abortCtrl.signal,
      });

      await consumeAssistantStream(res, messageId, targetWorkspaceId, true);

      // If the user accepted a graph-changing tool, refresh the graph.
      if (decision === "accept" && targetWorkspaceId && authUser?.id) {
        const prevNodeIds = new Set(graphData.nodes.map((n) => n.id));
        const nextGraphData = await loadWorkspaceGraphData(
          authUser.id,
          targetWorkspaceId,
          selectedWorkspace?.name ?? null,
        );
        setGraphData(nextGraphData);

        // Parity with the braindump pipeline: any node the assistant just
        // created is run through connection inference so it links to the
        // nodes that logically make sense (surfaced in the edge-review
        // modal), instead of floating disconnected. No new nodes (e.g. an
        // accepted complete_node / propose_edge) → analyzeNodes no-ops.
        const newNodeIds = nextGraphData.nodes
          .filter((n) => !prevNodeIds.has(n.id))
          .map((n) => n.id);
        if (newNodeIds.length > 0) {
          void analyzeNodes(newNodeIds, targetWorkspaceId);
        }

        // If the accepted tool mutated calendar tasks, the planner's persisted
        // tasks are now stale — bump the refresh key so AssistantMode re-fetches.
        const PLANNER_TOOLS = ["add_task_to_calendar", "reschedule_task", "mark_task_done"];
        if (action.toolName && PLANNER_TOOLS.includes(action.toolName)) {
          setPlannerRefreshKey((v) => v + 1);
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        // Abort mid-resume — leave the card state as-is (already accepted/rejected)
        // and just stop the follow-up text.
      } else {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.pendingAction
              ? {
                  ...m,
                  pendingAction: {
                    ...m.pendingAction,
                    status: "error",
                    errorMessage: "Could not complete the action. Try again.",
                  },
                }
              : m,
          ),
        );
      }
    } finally {
      if (chatAbortRef.current === abortCtrl) chatAbortRef.current = null;
      setPendingActionBusy(false);
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

  const showToast = (message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  };

  // Start a focus session on a node. Duration = the linked plan_task's
  // duration_minutes for today if one exists, else 25m. No AI estimate call —
  // keep "Start working" free and instant (v1).
  const handleStartFocus = async (nodeId: string) => {
    const node = graphData.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    let durationMinutes = 25;
    if (supabase && selectedWorkspaceId && authUser?.id) {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await supabase
        .from("plan_tasks")
        .select("duration_minutes")
        .eq("user_id", authUser.id)
        .eq("workspace_id", selectedWorkspaceId)
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
    focusTimer.start({ nodeId, title: node.title, durationMinutes });
  };

  // Complete a focus session: stop the timer, confirm via toast, and — if a
  // linked plan_task exists for today — mark it done and refresh the planner.
  const handleFocusDone = async () => {
    const active = focusTimer.timer;
    focusTimer.stop();
    showToast("Nice work — focus session done.");
    if (!active || !supabase || !selectedWorkspaceId || !authUser?.id) return;
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from("plan_tasks")
      .update({ done: true })
      .eq("user_id", authUser.id)
      .eq("workspace_id", selectedWorkspaceId)
      .eq("node_id", active.nodeId)
      .eq("scheduled_date", today)
      .eq("done", false)
      .select("id");
    if (data && data.length > 0) {
      setPlannerRefreshKey((v) => v + 1);
    }
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
    setFocusRequestKey((currentKey) => currentKey + 1);

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
    setFocusRequestKey((currentKey) => currentKey + 1);
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

  const handleResetManualWeight = () => {
    setEditNodeDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      return { ...currentDraft, manual_weight: null };
    });
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

    const trimmedTargetDate = createNodeDraft.target_date.trim();
    const targetDate =
      trimmedTargetDate.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(trimmedTargetDate)
        ? trimmedTargetDate
        : null;

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
      body: createNodeDraft.body.trim() || null,
      title,
      target_date: targetDate,
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

    // Sizing layer: only second-guess plain tasks. If the user explicitly
    // created a project/goal/etc., take it at face value. Runs after the
    // node is already on screen so the common (task) path has zero delay.
    if (resolvedNodeType === "task") {
      void maybeOfferBreakdown(createdNode);
    }
  };

  // Decide whether a just-created task is really a multi-session endeavour and,
  // if so, offer the inline "break it into steps?" chooser. The cheap heuristic
  // decides most titles for free; only 'ambiguous' ones cost a Haiku call,
  // which fails safe to "task" (no interruption) on any error.
  //
  // We do NOT mutate the node here. Breaking it down just nests generated steps
  // under it (a task can have children), and only if the user accepts — so
  // "Keep as one task" genuinely leaves it untouched. No DB write happens until
  // the user actually picks "Break it down".
  //
  // No concurrency guard: the sole caller is the manual create-node form, where
  // a second creation can't realistically land within the classify window, and
  // a clobbered chooser causes no harm now that nothing is mutated.
  const maybeOfferBreakdown = async (node: Node) => {
    const title = node.title;
    let verdict = classifyTaskSize(title);
    if (verdict === "ambiguous") {
      verdict = "task"; // fail-safe: don't interrupt unless we're confident
      try {
        const res = await fetch("/api/assistant/classify-size", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (res.ok) {
          const data = (await res.json()) as { size?: "task" | "project" };
          if (data.size === "project") verdict = "project";
        }
      } catch {
        // network error — keep the task default, never block creation
      }
    }
    if (verdict !== "project") return;
    setPendingSizeBreakdown({ nodeId: node.id, title });
    setRightPanelOpen(true);
    setActiveRailTab("chat");
  };

  // Resolve the breakdown chooser. "light"/"full" generate nested steps under
  // the task (leaving its type alone) at the chosen depth; "keep" leaves the
  // task exactly as created.
  const handleResolveSizeBreakdown = (choice: "light" | "full" | "keep") => {
    const pending = pendingSizeBreakdown;
    setPendingSizeBreakdown(null);
    if (pending && choice !== "keep") {
      void handleSuggestStepsForNode(pending.nodeId, choice);
    }
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

    const trimmedTargetDate = editNodeDraft.target_date.trim();
    const targetDate =
      trimmedTargetDate.length === 0
        ? null
        : /^\d{4}-\d{2}-\d{2}$/.test(trimmedTargetDate)
          ? trimmedTargetDate
          : null;

    const payload = {
      color:
        editNodeDraft.node_type === "custom"
          ? nodeColorByType.concept
          : nodeColorByType[editNodeDraft.node_type],
      importance: getImportanceLabel(editNodeDraft.importance_index),
      importance_index: editNodeDraft.importance_index,
      manual_weight: editNodeDraft.manual_weight,
      manual_weight_set_at:
        editNodeDraft.manual_weight == null ? null : new Date().toISOString(),
      node_type: resolvedNodeType as Node["node_type"],
      summary: editNodeDraft.summary.trim() || null,
      body: editNodeDraft.body.trim() || null,
      target_date: targetDate,
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
    // Drop a pending breakdown offer if its node was just deleted.
    setPendingSizeBreakdown((p) =>
      p && nodeIds.includes(p.nodeId) ? null : p,
    );
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

  const handleDeleteAccount = async () => {
    if (deletingAccount) {
      return;
    }

    setDeletingAccount(true);

    try {
      const res = await fetch("/api/account/delete", { method: "POST" });

      if (!res.ok) {
        setDeletingAccount(false);
        return false;
      }

      // Clear the local session, then leave. The server already removed
      // every row this user owned via FK cascade.
      if (supabase) {
        await supabase.auth.signOut();
      }

      setSystemPanelOpen(false);
      router.replace("/login");
      return true;
    } catch {
      setDeletingAccount(false);
      return false;
    }
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

  // Shared tail for every dump (button, chat, bootstrap): mirror the dump +
  // a conversational summary into chat, then open the proposed-nodes review
  // modal. One implementation so all entry points behave identically.
  const applyDumpExtraction = (
    rawText: string,
    data: {
      proposed_nodes?: ProposedNode[];
      clarifying_questions?: string[];
      completed_existing_node_titles?: string[];
    },
  ) => {
    const nodes = data.proposed_nodes ?? [];
    const questions = data.clarifying_questions ?? [];
    const completedTitles = data.completed_existing_node_titles ?? [];

    const summary = [
      nodes.length > 0
        ? `I analyzed your dump and proposed ${nodes.length} node${nodes.length === 1 ? "" : "s"} and their connections — review and accept them in the panel that just opened.`
        : "I went through your dump but didn't find anything new worth proposing.",
      completedTitles.length > 0
        ? `I also marked ${completedTitles.length} existing item${completedTitles.length === 1 ? "" : "s"} done: ${completedTitles.slice(0, 3).join(", ")}${completedTitles.length > 3 ? "…" : ""}.`
        : null,
      questions.length > 0
        ? `I have ${questions.length} quick clarifying question${questions.length === 1 ? "" : "s"} — answer inline when ready.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    const nowIso = new Date().toISOString();
    setChatMessages((prev) => [
      ...prev,
      {
        id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
        role: "user" as const,
        body: rawText,
        createdAt: nowIso,
        status: "ready" as const,
      },
      {
        id: `chat-extract-${Math.random().toString(36).slice(2, 10)}`,
        role: "assistant" as const,
        body: summary,
        createdAt: nowIso,
        status: "ready" as const,
      },
    ]);
    setRightPanelOpen(true);
    setActiveRailTab("chat");

    if (nodes.length > 0 || questions.length > 0) {
      setProposedNodes(nodes);
      setClarifyingQuestions(questions);
      setLastDumpRawText(rawText);
      setProposedReviewOpen(true);
    }
  };

  // Dump submitted from the chat composer (after the user picked "Brain
  // dump" in the chooser). Same extraction pipeline as the button.
  const submitDumpFromChat = async (text: string) => {
    const trimmed = text.trim();
    const targetWorkspaceId = selectedWorkspaceId;
    if (!trimmed || !targetWorkspaceId) return;
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: trimmed, workspace_id: targetWorkspaceId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        proposed_nodes?: ProposedNode[];
        clarifying_questions?: string[];
        completed_existing_node_titles?: string[];
        error?: string;
        message?: string;
      };
      if (!res.ok && res.status !== 207) {
        const nowIso = new Date().toISOString();
        setChatMessages((prev) => [
          ...prev,
          {
            id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
            role: "user" as const,
            body: trimmed,
            createdAt: nowIso,
            status: "ready" as const,
          },
          {
            id: `chat-err-${Math.random().toString(36).slice(2, 10)}`,
            role: "assistant" as const,
            body:
              data.error ??
              data.message ??
              "I couldn't process that as a dump. Try again or rephrase it.",
            createdAt: nowIso,
            status: "error" as const,
          },
        ]);
        setRightPanelOpen(true);
        setActiveRailTab("chat");
        return;
      }
      applyDumpExtraction(trimmed, data);
    } catch {
      const nowIso = new Date().toISOString();
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-err-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: "Network error processing that dump. Try again.",
          createdAt: nowIso,
          status: "error" as const,
        },
      ]);
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
        clarifying_questions?: string[];
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
      applyDumpExtraction(trimmed, data);
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
        clarifying_questions?: string[];
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

      const retriedDumpText = brainDumpValue.trim();
      setBrainDumpValue("");
      setBrainDumpOpen(false);
      setBrainDumpError(null);
      setBrainDumpFailedEntryId(null);
      const nodes = data.proposed_nodes ?? [];
      const questions = data.clarifying_questions ?? [];
      if (nodes.length > 0 || questions.length > 0) {
        setProposedNodes(nodes);
        setClarifyingQuestions(questions);
        setLastDumpRawText(retriedDumpText);
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
      replaced_by_node_id?: string;
      edits?: { proposed_title: string; proposed_summary: string | null; proposed_node_type: string };
    }>
  ) => {
    setProposedNodesSubmitting(true);
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

      // After accepting, if any project landed with no steps under it,
      // proactively ask in-thread whether they want a roadmap. Guarded so
      // it never nags about the same project twice in a session. The user
      // replies in chat → the assistant proposes steps via the normal
      // propose-with-Accept/Reject flow.
      const mergedGraph: GraphData = {
        nodes: [...graphData.nodes, ...positioned],
        edges: [...graphData.edges, ...acceptedEdges],
      };
      const childless = findChildlessProjects(mergedGraph).filter(
        (p) => !roadmapPromptedRef.current.has(p.id),
      );
      if (childless.length > 0) {
        childless.forEach((p) => roadmapPromptedRef.current.add(p.id));
        const names = childless.slice(0, 3).map((p) => `"${p.title}"`);
        const extra = childless.length - names.length;
        const nameList =
          names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
        const body =
          childless.length === 1
            ? `${nameList} is a project with no steps under it yet. Want me to suggest a roadmap for it? Just say the word and I'll propose steps you can review.`
            : `${nameList}${extra > 0 ? ` and ${extra} more` : ""} are projects with no steps under them yet. Want me to suggest a roadmap for any of them?`;
        setChatMessages((prev) => [
          ...prev,
          {
            id: `chat-roadmap-${Math.random().toString(36).slice(2, 10)}`,
            role: "assistant" as const,
            body,
            createdAt: new Date().toISOString(),
            status: "ready" as const,
          },
        ]);
        setRightPanelOpen(true);
        setActiveRailTab("chat");
      }
    }
    setProposedNodesSubmitting(false);
    setProposedReviewOpen(false);
    setProposedNodes([]);

    // After the review closes, surface any clarifying questions the user
    // didn't already answer inline — without switching off their current
    // view.
    const questionsToAsk = clarifyingQuestions.filter(
      (q) => !answeredInlineQuestions.has(q),
    );
    const dumpToAsk = lastDumpRawText;
    setClarifyingQuestions([]);
    setLastDumpRawText("");
    if (questionsToAsk.length > 0) {
      openClarifyingQuestionsInChat(questionsToAsk, dumpToAsk);
    }

    // First-dump shortcut: if these proposals came from the bootstrap
    // wizard, skip BOTH the suggest-steps modal and the post-acceptance
    // connection-analysis call. A first dump already produces enough nodes
    // and the user just spent time reviewing them — don't dogpile them
    // with two more modals and a stack of Sonnet calls. Suggest-steps is
    // still available manually from any node's details panel.
    if (proposalsFromBootstrap) {
      setProposalsFromBootstrap(false);
    } else if (data.accepted_nodes && data.accepted_nodes.length > 0 && selectedWorkspaceId) {
      const acceptedNodes = data.accepted_nodes as Node[];
      const nodeIds = acceptedNodes.map((n) => n.id);

      // Only suggest steps for leaf nodes — anything that's already a parent
      // already has structure beneath it.
      const acceptedEdges = (data.accepted_edges as Edge[]) ?? [];
      const parentIds = new Set<string>();
      for (const edge of [...graphData.edges, ...acceptedEdges]) {
        if (edge.edge_type === "belongs_to") {
          parentIds.add(edge.target_node_id);
        }
      }
      const goalOrProjectNodes = acceptedNodes.filter(
        (n) =>
          (n.node_type === "goal" || n.node_type === "project" || n.node_type === "habit") &&
          !parentIds.has(n.id),
      );

      if (goalOrProjectNodes.length > 0) {
        // Store node IDs so connection analysis can run after step flow
        pendingAnalysisRef.current = { nodeIds, workspaceId: selectedWorkspaceId };
        setStepSuggestionNodes(
          goalOrProjectNodes.map((n) => ({
            id: n.id,
            title: n.title,
            summary: n.summary,
            node_type: n.node_type,
          })),
        );
        setStepSuggestionOpen(true);
      } else {
        // No goals/projects — run connection analysis immediately
        void analyzeNodes(nodeIds);
      }
    }
  };

  // Manual roadmap-suggestion for a single node from the details panel.
  // Fires regardless of node type or whether it already has children —
  // user-initiated re-prompt for finer breakdown is intentional here.
  // Feeds the AI's text back through the standard extraction pipeline so
  // the user reviews each proposed step before it lands in the graph.
  const handleSuggestStepsForNode = async (
    nodeId: string,
    mode: "light" | "full" = "full",
  ) => {
    if (!selectedWorkspaceId || stepSuggestionLoading) return;
    const node = graphData.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    setStepSuggestionLoading(true);
    try {
      const res = await fetch("/api/nodes/suggest-steps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: node.title,
          summary: node.summary,
          node_type: node.node_type,
          workspace_id: selectedWorkspaceId,
          mode,
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { steps_text?: string };
      if (data.steps_text) {
        // Pin the generated steps under the source node so they don't
        // float to the workspace root.
        await handleExtractNodes(data.steps_text, selectedWorkspaceId, {
          defaultParentNodeId: nodeId,
        });
      }
    } catch {
      // step generation failed — silent for now; could surface a toast later
    } finally {
      setStepSuggestionLoading(false);
    }
  };

  const handleGenerateSteps = async () => {
    if (!selectedWorkspaceId || stepSuggestionNodes.length === 0) return;
    setStepSuggestionLoading(true);
    setStepSuggestionOpen(false);

    try {
      // Generate steps for each goal/project node, then extract them all
      const allStepsTexts: string[] = [];
      for (const node of stepSuggestionNodes) {
        const res = await fetch("/api/nodes/suggest-steps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: node.title,
            summary: node.summary,
            node_type: node.node_type,
            workspace_id: selectedWorkspaceId,
          }),
        });
        if (res.ok) {
          const data = await res.json() as { steps_text?: string };
          if (data.steps_text) {
            allStepsTexts.push(data.steps_text);
          }
        }
      }

      if (allStepsTexts.length > 0) {
        await handleExtractNodes(allStepsTexts.join("\n\n"), selectedWorkspaceId);
      }
    } catch {
      // Step generation failed silently
    } finally {
      setStepSuggestionLoading(false);
      setStepSuggestionNodes([]);
      // Now run deferred connection analysis
      const pending = pendingAnalysisRef.current;
      if (pending) {
        pendingAnalysisRef.current = null;
        void analyzeNodes(pending.nodeIds);
      }
    }
  };

  const dismissStepSuggestion = () => {
    setStepSuggestionOpen(false);
    setStepSuggestionNodes([]);
    // Run deferred connection analysis
    const pending = pendingAnalysisRef.current;
    if (pending) {
      pendingAnalysisRef.current = null;
      void analyzeNodes(pending.nodeIds);
    }
  };

  const closeProposedNodesReview = () => {
    // Capture pending questions/dump BEFORE we wipe state, so we can hand
    // unanswered ones to chat after the modal closes.
    const questionsToAsk = clarifyingQuestions.filter(
      (q) => !answeredInlineQuestions.has(q),
    );
    const dumpToAsk = lastDumpRawText;

    setProposedReviewOpen(false);
    setProposedNodes([]);
    setClarifyingQuestions([]);
    setLastDumpRawText("");

    if (questionsToAsk.length > 0) {
      openClarifyingQuestionsInChat(questionsToAsk, dumpToAsk);
    }
  };

  const requestCloseProposedNodesReview = () => {
    // Only confirm if there are nodes worth losing — a questions-only review
    // closing is cheap.
    if (proposedNodes.length > 0) {
      const confirmed = window.confirm(
        "Close node review? The extracted nodes will stay pending review and your current selections will be lost.",
      );
      if (!confirmed) {
        return;
      }
    }

    closeProposedNodesReview();
  };

  // Tracks whether we've already injected the brain dump into chat for the
  // current review session — so inline-answer + after-close dispatch don't
  // both add it. Reset every time a new review opens.
  const dumpInChatRef = useRef(false);
  // Questions the user already answered inline while the modal was open;
  // these are excluded from the after-close auto-dispatch.
  const [answeredInlineQuestions, setAnsweredInlineQuestions] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (proposedReviewOpen) {
      dumpInChatRef.current = false;
      setAnsweredInlineQuestions(new Set());
    }
  }, [proposedReviewOpen]);

  // Opens the right-rail chat with the prior dump + extractor questions as
  // an initial conversation. Crucially does NOT switch app mode — the user
  // stays on whatever view they were on (graph, list, etc.) and the chat
  // appears alongside as a side panel. Called automatically after the
  // proposed-nodes review closes when there are unanswered questions.
  const openClarifyingQuestionsInChat = (questions: string[], dumpText: string) => {
    if (questions.length === 0) return;
    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatMessages((prev) => {
      const out = [...prev];
      if (!dumpInChatRef.current && dumpText.length > 0) {
        out.push({
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: dumpText,
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        });
        dumpInChatRef.current = true;
      }
      for (const q of questions) {
        out.push({
          id: `chat-q-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: q,
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        });
      }
      return out;
    });
    setRailChatInput("");
  };

  // Handler for inline answers from the modal. Threads (dump →) question →
  // answer into the chat rail without disturbing the user's view. The
  // modal stays open so they can keep reviewing nodes.
  const handleClarifyingAnswerInline = (question: string, answer: string) => {
    const dumpText = lastDumpRawText;
    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatMessages((prev) => {
      const out = [...prev];
      if (!dumpInChatRef.current && dumpText.length > 0) {
        out.push({
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: dumpText,
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        });
        dumpInChatRef.current = true;
      }
      out.push({
        id: `chat-q-${Math.random().toString(36).slice(2, 10)}`,
        role: "assistant" as const,
        body: question,
        createdAt: new Date().toISOString(),
        status: "ready" as const,
      });
      out.push({
        id: `chat-a-${Math.random().toString(36).slice(2, 10)}`,
        role: "user" as const,
        body: answer,
        createdAt: new Date().toISOString(),
        status: "ready" as const,
      });
      return out;
    });
    setAnsweredInlineQuestions((prev) => {
      const next = new Set(prev);
      next.add(question);
      return next;
    });
  };

  const closeProposedEdgesReview = () => {
    setEdgeReviewOpen(false);
    setProposedEdges([]);
  };

  const requestCloseProposedEdgesReview = () => {
    const confirmed = window.confirm(
      "Close connection review? The suggested edges will stay pending review and your current selections will be lost.",
    );
    if (!confirmed) {
      return;
    }

    closeProposedEdgesReview();
  };

  const handleGraphEditConfirm = async (ops: GraphEditOperation[]) => {
    if (!selectedWorkspaceId) return;
    setGraphEditReviewOpen(false);
    setGraphEditOps([]);

    try {
      const res = await fetch("/api/graph-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: selectedWorkspaceId, operations: ops }),
      });
      const data = await res.json() as {
        updated_nodes?: Node[];
        updated_edges?: Edge[];
      };

      if (res.ok && data.updated_nodes && data.updated_edges) {
        setGraphData({
          nodes: data.updated_nodes as Node[],
          edges: (data.updated_edges as Edge[]).filter(
            (e) => e.status !== "orphaned" && e.status !== "user_rejected",
          ),
        });
      }
    } catch {
      // Failed silently
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

    // Track which nodes specifically failed so retry can target only those
    // instead of replaying the whole batch.
    setLastAnalysisFailedNodeIds(
      Array.isArray(result.failed_node_ids) ? result.failed_node_ids : [],
    );

    setAiNotice(buildAnalysisNotice(result));
  };

  const analyzeNodes = async (nodeIds: string[], workspaceIdOverride?: string) => {
    const workspaceId = workspaceIdOverride ?? selectedWorkspaceId;
    const normalizedNodeIds = Array.from(
      new Set(nodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string" && nodeId.length > 0)),
    );

    if (!workspaceId || normalizedNodeIds.length === 0) {
      return;
    }

    setLastAnalysisNodeIds(normalizedNodeIds);
    setLastAnalysisFailedNodeIds([]);
    setLastAnalysisWorkspaceId(workspaceId);
    setAnalyzingConnections(true);
    setAiNotice(null);

    try {
      const res = await fetch("/api/nodes/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_ids: normalizedNodeIds, workspace_id: workspaceId }),
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

  const retryLastConnectionAnalysis = () => {
    if (!lastAnalysisWorkspaceId) {
      return;
    }

    // Prefer retrying only the nodes that actually failed. Fall back to the full
    // batch if the API didn't report specific failures (e.g. transport-level error
    // before the response was parsed).
    const nodesToRetry =
      lastAnalysisFailedNodeIds.length > 0
        ? lastAnalysisFailedNodeIds
        : lastAnalysisNodeIds;

    if (nodesToRetry.length === 0) {
      return;
    }

    void analyzeNodes(nodesToRetry, lastAnalysisWorkspaceId);
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
      updated_nodes?: Node[];
      recomputed_scores?: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }>;
      updated_task_ids?: string[];
    };
    const updatedNode = data.updated_node ?? null;
    const updatedNodeMap = new Map(
      (data.updated_nodes ?? []).map((updated) => [updated.id, updated]),
    );

    // If the server cascaded any plan_tasks (linked-task auto-toggle), bump
    // the planner refresh key so AssistantMode re-loads its task list.
    if (data.updated_task_ids && data.updated_task_ids.length > 0) {
      setPlannerRefreshKey((v) => v + 1);
    }
    const scoreMap = new Map(
      (data.recomputed_scores ?? []).map((s) => [s.id, s]),
    );

    // Merge authoritative server state (scores etc.) onto the already-optimistic UI
    setGraphData((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => {
        const nextNodeState = updatedNodeMap.get(n.id) ?? (n.id === nodeId ? updatedNode : null);
        const scoreUpdate = scoreMap.get(n.id);

        if (!nextNodeState && !scoreUpdate) {
          return n;
        }

        return {
          ...n,
          ...(nextNodeState ?? {}),
          ...(scoreUpdate
            ? {
                current_importance_score: scoreUpdate.current_importance_score,
                importance_index: scoreUpdate.importance_index,
                importance: scoreUpdate.importance as Node["importance"],
              }
            : {}),
        };
      }),
    }));
  };

  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-(--color-bg-base) text-(--color-text-primary)">
      <TopCommandBar
        onToggleSystemPanel={() => {
          setWorkspaceMenuOpen(false);
          setSystemPanelOpen((open) => !open);
        }}
        onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
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

      <div className="app-main-area relative flex min-h-0">
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
          onDeleteAccount={() => {
            void handleDeleteAccount();
          }}
          open={systemPanelOpen}
          signingOut={signingOut}
          deletingAccount={deletingAccount}
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
                key={selectedWorkspaceId ?? "workspace-none"}
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
                graphTypeCounts={nodeTypeCounts}
                graphTypeTotalCount={nodeTypeTotalCount}
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
                onResetEditManualWeight={handleResetManualWeight}
                onResetGraphFilters={handleResetFilters}
                onToggleShowArchived={() => setShowArchived((v) => !v)}
                showArchived={showArchived}
                hideCompleted={hideCompleted}
                completedNodes={completedNodes}
                onSelectCompletedNode={(nodeId) => {
                  setHideCompleted(false);
                  handleSelectNode(nodeId);
                }}
                onToggleHideCompleted={() => setHideCompleted((v) => !v)}
                onFindAllConnections={() => {
                  if (!selectedWorkspaceId || analyzingConnections) return;
                  if (graphData.nodes.length === 0) return;
                  setFindAllConfirmOpen(true);
                }}
                findingConnections={analyzingConnections}
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
                focusRequestKey={focusRequestKey}
                selectedNodeId={selectedNodeId}
                suppressInitialFocusAnimation={suppressInitialFocusAnimation}
              />
            </motion.div>
          ) : appMode === "assistant" ? (
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
                tasksRefreshKey={plannerRefreshKey}
                onAskInChat={(message) => {
                  void submitMessage(message);
                }}
                onLinkedNodeStatusChange={(nodeId, nextStatus) => {
                  // Mirror the planner toggle in the local graphData so the
                  // graph view shows the matching status without a refetch.
                  setGraphData((prev) => ({
                    ...prev,
                    nodes: prev.nodes.map((n) =>
                      n.id === nodeId ? { ...n, status: nextStatus } : n,
                    ),
                  }));
                }}
              />
            </motion.div>
          ) : appMode === "todos" ? (
            <motion.div
              key="todos"
              className="flex min-w-0 flex-1 lists-bg"
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <TodosView
                graphData={graphData}
                onSelectNode={(nodeId) => {
                  setAppMode("graph");
                  handleSelectNode(nodeId);
                }}
                onToggleStatus={(nodeId, status) => {
                  void handleStatusChange(nodeId, status);
                }}
              />
            </motion.div>
          ) : appMode === "habits" ? (
            <motion.div
              key="habits"
              className="flex min-w-0 flex-1 lists-bg"
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <HabitsView
                graphData={graphData}
                onSelectNode={(nodeId) => {
                  setAppMode("graph");
                  handleSelectNode(nodeId);
                }}
                onPlannerInvalidate={() => {
                  setPlannerRefreshKey((v) => v + 1);
                }}
              />
            </motion.div>
          ) : appMode === "roadmap" ? (
            <motion.div
              key="roadmap"
              className="flex min-w-0 flex-1 lists-bg"
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <RoadmapView
                graphData={graphData}
                onSelectNode={(nodeId) => {
                  setAppMode("graph");
                  handleSelectNode(nodeId);
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="pomodoro"
              className="flex min-w-0 flex-1 lists-bg"
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <PomodoroView graphData={graphData} focusTimer={focusTimer} />
            </motion.div>
          )}
        </AnimatePresence>

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
          onResolvePendingAction={(messageId, decision, choice) => {
            void resolvePendingAction(messageId, decision, choice);
          }}
          onCancelChat={cancelChat}
          pendingActionBusy={pendingActionBusy}
          nudges={nudges}
          onSelectNudge={(nudge) => {
            void submitMessage(nudge.starter);
          }}
          onSelectPrompt={(prompt) => {
            void submitMessage(prompt);
          }}
          onSetActiveTab={setActiveRailTab}
          onStatusChange={(nodeId, status) => {
            void handleStatusChange(nodeId, status);
          }}
          onStartFocusSession={(nodeId) => {
            void handleStartFocus(nodeId);
          }}
          onFindConnections={(nodeId) => {
            if (!selectedWorkspaceId) return;
            void analyzeNodes([nodeId]);
          }}
          onSuggestSteps={(nodeId, mode) => {
            void handleSuggestStepsForNode(nodeId, mode);
          }}
          suggestStepsBusy={stepSuggestionLoading}
          onSelectLinkedNode={handleSelectNode}
          onSubmitChatInput={(message) => {
            const trimmed = message.trim();
            if (!trimmed) return;
            // Two-stage detection so most chat messages incur ZERO AI cost:
            //   1. Cheap client-side regex (looksLikeBrainDump) gates everything.
            //   2. Only when it fires do we ask Haiku to confirm it's actually
            //      a dump (vs a multi-clause question that happens to look
            //      dump-like). Classifier failures fail-safe to "yes, dump"
            //      so the chooser still shows and we never silently swallow
            //      a real dump.
            if (
              pendingDumpText === null &&
              !chatLoading &&
              looksLikeBrainDump(trimmed)
            ) {
              setRailChatInput("");
              void (async () => {
                let isDump = true; // fail-safe default
                try {
                  const res = await fetch("/api/assistant/classify-dump", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: trimmed }),
                  });
                  if (res.ok) {
                    const data = (await res.json()) as { is_dump?: boolean };
                    isDump = data.is_dump !== false;
                  }
                } catch {
                  // Network error: keep the fail-safe (treat as dump).
                }
                if (isDump) {
                  setPendingDumpText(trimmed);
                  setRightPanelOpen(true);
                  setActiveRailTab("chat");
                } else {
                  void submitMessage(trimmed);
                }
              })();
              return;
            }
            void submitMessage(message);
          }}
          pendingDumpText={pendingDumpText}
          onResolveDumpChoice={(choice) => {
            const text = pendingDumpText;
            setPendingDumpText(null);
            if (!text) return;
            if (choice === "chat") {
              void submitMessage(text);
              return;
            }
            void submitDumpFromChat(text);
          }}
          pendingSizeBreakdown={pendingSizeBreakdown}
          onResolveSizeBreakdown={handleResolveSizeBreakdown}
          onToggle={() => setRightPanelOpen((open) => !open)}
          open={rightPanelOpen}
          selectedNode={selectedNode}
          chatSessions={chatSessions}
          activeChatSessionId={chatSessionId}
          chatHistoryOpen={chatHistoryOpen}
          onToggleChatHistory={() => setChatHistoryOpen((v) => !v)}
          onStartNewChat={handleStartNewChat}
          onSelectChatSession={(id) => {
            void handleLoadChatSession(id);
          }}
          onDeleteChatSession={(id) => {
            void handleDeleteChatSession(id);
          }}
        />
      </div>

      {/* Proposed nodes review — centered modal */}
      <AnimatePresence>
        {proposedReviewOpen && (proposedNodes.length > 0 || clarifyingQuestions.length > 0) && (
          <motion.div
            key="prn-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <ProposedNodesReview
              existingNodeTitles={existingNodeTitleMap}
              proposals={proposedNodes}
              onAccept={handleProposalReview}
              onClose={requestCloseProposedNodesReview}
              submitting={proposedNodesSubmitting}
              clarifyingQuestions={clarifyingQuestions}
              onAnswerInline={handleClarifyingAnswerInline}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Graph edit review — centered modal */}
      <AnimatePresence>
        {graphEditReviewOpen && graphEditOps.length > 0 && (
          <motion.div
            key="ger-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <GraphEditReview
              operations={graphEditOps}
              onConfirm={(ops) => handleGraphEditConfirm(ops)}
              onDismiss={() => { setGraphEditReviewOpen(false); setGraphEditOps([]); }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Step suggestion prompt — shown after accepting goals/projects */}
      <AnimatePresence>
        {stepSuggestionOpen && stepSuggestionNodes.length > 0 && (
          <motion.div
            key="step-suggest-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <motion.div
              className="step-suggest-modal"
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.99 }}
              initial={{ opacity: 0, y: 16, scale: 0.99 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="step-suggest-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
              <div className="step-suggest-body">
                <p className="step-suggest-title">Suggested steps</p>
                <p className="step-suggest-desc">
                  Want me to break down{" "}
                  {stepSuggestionNodes.map((n, i) => (
                    <span key={n.id}>
                      {i > 0 && (i === stepSuggestionNodes.length - 1 ? " and " : ", ")}
                      <strong>{n.title}</strong>
                    </span>
                  ))}{" "}
                  into actionable steps?
                </p>
              </div>
              <div className="step-suggest-actions">
                <button
                  className="per-btn-ghost"
                  onClick={dismissStepSuggestion}
                  type="button"
                >
                  Skip
                </button>
                <button
                  className="per-btn-primary"
                  onClick={() => void handleGenerateSteps()}
                  type="button"
                >
                  Generate steps
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-graph reconnect confirmation */}
      <AnimatePresence>
        {findAllConfirmOpen && (
          <motion.div
            key="find-all-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ background: "rgba(0,0,0,0.45)" }}
            onClick={() => setFindAllConfirmOpen(false)}
          >
            <motion.div
              className="step-suggest-modal"
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.99 }}
              initial={{ opacity: 0, y: 16, scale: 0.99 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="step-suggest-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                </svg>
              </div>
              <div className="step-suggest-body">
                <p className="step-suggest-title">Reanalyze the entire graph?</p>
                <p className="step-suggest-desc">
                  This will run connection analysis across all{" "}
                  <strong>{graphData.nodes.length}</strong> nodes in this
                  workspace. It can take a while and uses AI credits. New
                  connections will be proposed for you to review.
                </p>
              </div>
              <div className="step-suggest-actions">
                <button
                  className="per-btn-ghost"
                  onClick={() => setFindAllConfirmOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="per-btn-primary"
                  onClick={() => {
                    setFindAllConfirmOpen(false);
                    if (!selectedWorkspaceId) return;
                    const allNodeIds = graphData.nodes.map((n) => n.id);
                    if (allNodeIds.length === 0) return;
                    void analyzeNodes(allNodeIds);
                  }}
                  type="button"
                >
                  Reanalyze all
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Step generation loading indicator */}
      <AnimatePresence>
        {stepSuggestionLoading && (
          <motion.div
            key="step-loading"
            className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2"
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <div className="ai-status-chip">
              <span className="ai-status-spinner" />
              Generating steps…
            </div>
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
            <div className="ai-notice-actions">
              {lastAnalysisNodeIds.length > 0 &&
              lastAnalysisWorkspaceId === selectedWorkspaceId &&
              !analyzingConnections ? (
                <button
                  className="ai-notice-action"
                  onClick={retryLastConnectionAnalysis}
                  type="button"
                >
                  Find connections
                </button>
              ) : null}
              <button
                className="ai-notice-dismiss"
                onClick={() => setAiNotice(null)}
                type="button"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI reach-out ribbon — top-of-screen nudges */}
      <NudgeRibbon
        onOpenNode={(nodeId, workspaceId) => {
          if (workspaceId && workspaceId !== selectedWorkspaceId) {
            setSelectedWorkspaceId(workspaceId);
          }
          handleSelectNode(nodeId);
        }}
      />

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
          onConfirm={(actions) => handleEdgeReview(actions)}
          onDismiss={requestCloseProposedEdgesReview}
        />
      )}

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
              onOpenWhatNow={() => setWhatNowOpen((open) => !open)}
              onOpenWeeklyReflection={() => setWeeklyReflectionOpen(true)}
              weeklyReflectionLocked={!isWeeklyReflectionAvailable()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {weeklyReflectionOpen && selectedWorkspaceId ? (
          <WeeklyReflectionModal
            key="weekly-reflection"
            workspaceId={selectedWorkspaceId}
            workspaceName={workspaceName}
            onClose={() => setWeeklyReflectionOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {whatNowOpen ? (
          <motion.div
            key="what-now"
            className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2"
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.14 }}
          >
            <WhatNowDialog
              workspaceId={selectedWorkspaceId}
              userId={authUser?.id ?? null}
              onClose={() => setWhatNowOpen(false)}
              onFocusNode={(nodeId) => {
                setAppMode("graph");
                setWhatNowOpen(false);
                handleSelectNode(nodeId);
                // "Pick something to work on" is the focus intent — start the
                // timer on the chosen node.
                void handleStartFocus(nodeId);
                // If Focus pointed at a container with no actionable child,
                // generate one light next-action so the user isn't dead-ended.
                // Fires AI only here (on the explicit focus pick), only when
                // there's genuinely nothing to do under it, and at most once
                // per container per session (the dedupe ref) so re-focusing a
                // declined/empty container doesn't re-bill.
                if (
                  !focusSuggestedRef.current.has(nodeId) &&
                  needsNextAction(nodeId, graphData.nodes, graphData.edges)
                ) {
                  focusSuggestedRef.current.add(nodeId);
                  void handleSuggestStepsForNode(nodeId, "light");
                }
              }}
              onScheduledToPlanner={() => {
                setWhatNowOpen(false);
                setAppMode("assistant");
              }}
              onSelectNudge={(nudge) => {
                setWhatNowOpen(false);
                // No app-mode swap — the chat fires in the right rail
                // regardless of which view you were on. Yanking to Planner
                // is a context shift the user didn't ask for.
                setActiveRailTab("chat");
                setRightPanelOpen(true);
                void submitMessage(nudge.starter);
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Workspace bootstrap wizard — only shown for an in-progress creation flow */}
      {bootstrapWorkspaceId && bootstrapWorkspaceId === selectedWorkspaceId && (
        <WorkspaceBootstrapWizard
          workspaceId={selectedWorkspaceId}
          workspaceName={workspaceName}
          isOnboarding={!workspaceCreationFlowRef.current}
          onComplete={(handoff) => {
            const wasOnboarding = !workspaceCreationFlowRef.current;
            if (workspaceCreationFlowRef.current?.workspaceId === selectedWorkspaceId) {
              workspaceCreationFlowRef.current = null;
            }
            setBootstrapWorkspaceId(null);

            // Mirror the first (bootstrap) dump into the chat thread, exactly
            // like every later brain dump does — so the user's most important
            // dump isn't the one missing from their history.
            const bootstrapDumpText = handoff?.raw_text?.trim() ?? "";
            if (bootstrapDumpText) {
              const nodeCount = handoff?.proposed_nodes?.length ?? 0;
              const questionCount = handoff?.clarifying_questions?.length ?? 0;
              const bootstrapSummary = [
                nodeCount > 0
                  ? `I analyzed your first dump and proposed ${nodeCount} node${nodeCount === 1 ? "" : "s"} and their connections — review and accept them in the panel that just opened.`
                  : "I went through your dump but didn't find anything new worth proposing yet.",
                questionCount > 0
                  ? `I have ${questionCount} quick clarifying question${questionCount === 1 ? "" : "s"} — answer inline when ready.`
                  : null,
              ]
                .filter(Boolean)
                .join(" ");
              const bootstrapNowIso = new Date().toISOString();
              setChatMessages((prev) => [
                ...prev,
                {
                  id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
                  role: "user" as const,
                  body: bootstrapDumpText,
                  createdAt: bootstrapNowIso,
                  status: "ready" as const,
                },
                {
                  id: `chat-extract-${Math.random().toString(36).slice(2, 10)}`,
                  role: "assistant" as const,
                  body: bootstrapSummary,
                  createdAt: bootstrapNowIso,
                  status: "ready" as const,
                },
              ]);
            }

            // If the bootstrap dump produced proposed nodes, hand them
            // straight to the review modal so the user immediately sees
            // what got extracted from their first dump.
            const hasHandoff =
              handoff &&
              ((handoff.proposed_nodes && handoff.proposed_nodes.length > 0) ||
                (handoff.clarifying_questions && handoff.clarifying_questions.length > 0));
            if (hasHandoff) {
              setProposedNodes(
                (handoff!.proposed_nodes ?? []) as typeof proposedNodes,
              );
              setClarifyingQuestions(
                (handoff!.clarifying_questions ?? []) as typeof clarifyingQuestions,
              );
              setLastDumpRawText(handoff!.raw_text);
              setProposalsFromBootstrap(true);
              setProposedReviewOpen(true);
            }
            void loadWorkspaceGraphData(
              authUser?.id ?? null,
              selectedWorkspaceId,
              selectedWorkspace?.name ?? null,
            ).then((nextGraphData) => {
              setGraphData(nextGraphData);
              // After onboarding wizard, start the guided tour — but only
              // if there's no review modal already grabbing focus, else
              // the tour pops over the proposals which is jarring.
              if (wasOnboarding && !hasHandoff) {
                setShowTour(true);
              }
            });
          }}
          onSkip={() => {
            void handleCancelWorkspaceCreation();
          }}
        />
      )}

      {/* Welcome screen — guides new users into workspace setup */}
      {showWelcome && authUser && (
        <WelcomeScreen
          onGetStarted={() => {
            markWelcomeDone(authUser.id);
            setShowWelcome(false);
            if (selectedWorkspaceId) {
              setBootstrapWorkspaceId(selectedWorkspaceId);
            }
          }}
          onSkip={() => {
            markWelcomeDone(authUser.id);
            setShowWelcome(false);
          }}
        />
      )}

      {/* Guided tour — walks user through UI features after onboarding */}
      {showTour && (
        <GuidedTour onDone={() => setShowTour(false)} />
      )}

      {/* Focus timer pill — persistent across every mode/view, except the
          dedicated Pomodoro view which owns the full-size countdown. */}
      {focusTimer.timer && appMode !== "pomodoro" && (
        <FocusTimerPill
          timer={focusTimer.timer}
          remainingSeconds={focusTimer.remainingSeconds}
          onPause={focusTimer.pause}
          onResume={focusTimer.resume}
          onStop={focusTimer.stop}
          onDone={() => {
            void handleFocusDone();
          }}
        />
      )}
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  );
}
