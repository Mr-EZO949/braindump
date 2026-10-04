"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { MainStage } from "@/components/graph/main-stage";
import { AssistantMode as AssistantModeView } from "@/components/assistant/assistant-mode";
import { TodosView } from "@/components/ui/todos-view";
import { HabitsView } from "@/components/ui/habits-view";
import { RoadmapView } from "@/components/ui/roadmap-view";
import { PomodoroView } from "@/components/ui/pomodoro-view";
import { SectionBackdrop } from "@/components/ui/section-backdrop";
import { ModeDock, type AppMode } from "@/components/ui/mode-dock";
import { BrainDumpOverlay } from "@/components/ui/brain-dump-overlay";
import { clearFocusCache, WhatNowDialog } from "@/components/ui/what-now-dialog";
import { WeeklyReflectionModal } from "@/components/ui/weekly-reflection-modal";
import { DumpHistoryModal } from "@/components/ui/dump-history-modal";
import {
  listChatSessions,
  loadChatSession,
  upsertChatSession,
  deleteChatSession,
  type ChatSessionMeta,
} from "@/lib/chat/sessions";
import { ProposedNodesReview } from "@/components/ui/proposed-nodes-review";
import { ProposedEdgesReview } from "@/components/ui/proposed-edges-review";
import { MergeAlert } from "@/components/ui/merge-alert";
import { NudgeRibbon } from "@/components/nudges/nudge-ribbon";
import { WorkspaceBootstrapWizard } from "@/components/ui/workspace-bootstrap-wizard";
import { AboutYouIntake } from "@/components/ui/about-you-intake";
import { ClusterSuggestionStack } from "@/components/clustering/cluster-suggestion-stack";
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
import {
  buildPrimaryStructuralTree,
  getStructuralSubtreeFromIndexes,
} from "@/lib/graph/structure";
import { isLiveEdge, pickEdgesToRestore } from "@/lib/graph/archive-edges";
import { setNodeParent } from "@/lib/graph/hierarchy";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import { createPauseMarkerParser } from "@/lib/chat/pause-marker";
import {
  appliedActionFromPayload,
  appliedActionNote,
  appliedUndoEndpoint,
  createAppliedMarkerParser,
  isCommitmentAction,
  type AppliedMarkerPayload,
} from "@/lib/chat/applied-marker";
import { connectionsNote, turnNote } from "@/lib/chat/turn-note";
import { createTurnMarkerParser, createUndoMarkerParser, turnCardFromApplied } from "@/lib/chat/turn-marker";
import { readDumpResponse } from "@/lib/chat/dump-stream";
import type { DumpProgressState } from "@/components/ui/dump-progress";
import { classifyTaskSize } from "@/lib/ai/sizing";
import { needsNextAction } from "@/lib/graph/next-action";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { computeWorkProgress } from "@/lib/graph/work-progress";
import { NODE_TYPE_INFO, NODE_TYPES, normalizeNodeType } from "@/lib/graph/node-types";
import type {
  AppliedAction,
  RailTab,
  ChatMessage,
  ChatScope,
  Nudge,
  PendingAction,
  TurnAddedStatus,
  TurnCardData,
  TurnSection,
} from "@/types/chat";
import type { CreateNodeInput, Edge, GraphData, Node, NodeType, Workspace } from "@/types/graph";
import { addDaysISO, localDateISO } from "@/lib/time/local-date";
import { todayIsoDate } from "@/lib/planner/auto-schedule";
import { clientDayHints } from "@/lib/habits/streak";
import { acceptProposalsNow, undoAutoApplied } from "@/lib/graph/auto-apply-client";
import { AutoApplyNotice } from "@/components/ui/auto-apply-notice";
import type { DumpTurn, ProposedNode } from "@/types/ai";

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
  node_type: "task",
  raw_text: "",
  summary: "",
  body: "",
  title: "",
  target_date: "",
};

// One palette for every surface (src/lib/graph/node-colors.ts).
const nodeColorByType = NODE_COLOR_BY_TYPE;

// Every current type opens in the sheet as itself; a legacy value (e.g. an
// old "concept" row) opens as its v2 equivalent.
const baseEditableNodeTypes = new Set<CreateNodeInput["node_type"]>(NODE_TYPES);

// How long a completed node stays on the graph board before moving to the
// completed shelf (#17: keep the win visible, without months of clutter).
const RECENT_COMPLETION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// 32-bit FNV-1a over the fields that change what the user would see: node
// identity/status/edit time/deadline/score and edge identity/status. Cheap
// (one pass over a few KB) and collision-safe enough for a cache key.
function hashGraphContent(nodes: Node[], edges: Edge[]): string {
  let hash = 0x811c9dc5;
  const feed = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const n of nodes) {
    feed(
      `${n.id}|${n.status ?? ""}|${n.updated_at ?? ""}|${n.target_date ?? ""}|${
        n.current_importance_score ?? ""
      };`,
    );
  }
  for (const e of edges) {
    feed(`${e.id}|${e.status ?? ""};`);
  }
  return `${nodes.length}:${edges.length}:${(hash >>> 0).toString(36)}`;
}

function isRecentCompletion(node: Node, cutoffMs: number): boolean {
  if (!node.completed_at) return false;
  const completedMs = Date.parse(node.completed_at);
  return Number.isFinite(completedMs) && completedMs >= cutoffMs;
}

function formatNodeTypeLabel(nodeType: string) {
  return NODE_TYPE_INFO[normalizeNodeType(nodeType)].label;
}

function createDraftFromNode(node: Node): CreateNodeInput {
  const resolvedType = normalizeNodeType(node.node_type.toLowerCase(), node.node_type as NodeType);
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
// How long a node pulses after its priority changed, and how far "Still
// waiting" on a Focus check-back pushes the next check (ranking v2).
const PRIORITY_PULSE_MS = 2600;
const CHECK_BACK_SNOOZE_DAYS = 7;

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
  // Where a submitted dump is (box or chat) — streamed by /api/entries.
  const [dumpProgress, setDumpProgress] = useState<DumpProgressState | null>(null);
  const [brainDumpRetrying, setBrainDumpRetrying] = useState(false);
  const [brainDumpError, setBrainDumpError] = useState<string | null>(null);
  const [brainDumpFailedEntryId, setBrainDumpFailedEntryId] = useState<string | null>(null);
  const [whatNowOpen, setWhatNowOpen] = useState(false);
  const [weeklyReflectionOpen, setWeeklyReflectionOpen] = useState(false);
  const [dumpHistoryOpen, setDumpHistoryOpen] = useState(false);
  // Bumped whenever the server cascades plan_tasks updates (e.g. graph
  // completion auto-marked a linked task). The planner subscribes via prop
  // and re-loads its tasks list when the key changes — keeps the two views
  // in sync without a full page refresh.
  const [plannerRefreshKey, setPlannerRefreshKey] = useState(0);
  // Bumped when a chat `plan_day` is accepted, to pull its freshly-drafted plan
  // into the planner's review UI (journal #6).
  const [draftPlanRefreshKey, setDraftPlanRefreshKey] = useState(0);
  // That plan_day's start time and the busy time named in chat, so Accept in
  // the Planner lays the blocks where the plan was made for.
  const [draftPlanHint, setDraftPlanHint] = useState<{
    startTime: unknown;
    busy: unknown;
    window: unknown;
    acceptedAt: number;
  } | null>(null);
  const [proposedNodes, setProposedNodes] = useState<ProposedNode[]>([]);
  const [proposedReviewOpen, setProposedReviewOpen] = useState(false);
  const [proposedNodesSubmitting, setProposedNodesSubmitting] = useState(false);
  // Life-areas inferred from the dump (same call the wizard uses), surfaced in
  // the review modal so a normal dump can also spin up top-level branches.
  const [suggestedAreas, setSuggestedAreas] = useState<
    Array<{ title: string; area_type: string }>
  >([]);
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
  const [stepSuggestionNodes, setStepSuggestionNodes] = useState<Array<{ id: string; title: string; summary: string | null; node_type: string; selected: boolean }>>([]);
  const [stepSuggestionOpen, setStepSuggestionOpen] = useState(false);
  // On-load anti-freeze nudge — dismissible; resets when the workspace changes.
  const [freezeNudgeDismissed, setFreezeNudgeDismissed] = useState(false);
  // Occasional, not every-reload: a localStorage snooze timestamp gates it.
  // Showing it snoozes briefly; dismissing snoozes for weeks (like a "rate us").
  const [freezeNudgeAllowed, setFreezeNudgeAllowed] = useState(false);
  const freezeNudgeShownRef = useRef(false);
  useEffect(() => {
    try {
      const until = Number(localStorage.getItem("braindump:freeze-nudge-snooze") ?? 0);
      setFreezeNudgeAllowed(!(Number.isFinite(until) && Date.now() < until));
    } catch {
      setFreezeNudgeAllowed(true);
    }
  }, []);
  const snoozeFreezeNudge = (days: number) => {
    try {
      localStorage.setItem(
        "braindump:freeze-nudge-snooze",
        String(Date.now() + days * 24 * 60 * 60 * 1000),
      );
    } catch {
      /* localStorage unavailable — nudge just isn't throttled */
    }
  };
  const [stepSuggestionLoading, setStepSuggestionLoading] = useState(false);
  // Calibrated auto-apply: what was added without review, for one-tap Undo.
  const [autoApplyUndo, setAutoApplyUndo] = useState<{
    proposalIds: string[];
    nodeIds: string[];
    count: number;
  } | null>(null);
  // Lets the user cancel a slow roadmap/step generation (#5). Aborting the
  // fetch also aborts the upstream model call server-side (the route forwards
  // req.signal to Anthropic), so a cancel doesn't keep burning tokens.
  const stepSuggestAbortRef = useRef<AbortController | null>(null);
  const [proposedEdges, setProposedEdges] = useState<ProposedEdgeWithNodes[]>([]);
  const [edgeReviewOpen, setEdgeReviewOpen] = useState(false);
  const [analyzingConnections, setAnalyzingConnections] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [aiNotice, setAiNotice] = useState<AINotice | null>(null);
  // Bumped after a dump-review accept so the cluster-suggestion stack re-polls
  // (the clustering pass runs server-side inside /api/proposals/nodes/review).
  const [clusterRefreshKey, setClusterRefreshKey] = useState(0);
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
  // The thread as of the last render — for async work that finishes later
  // (connection analysis) and must know whether its message is still shown.
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);
  const [chatScope, setChatScope] = useState<ChatScope>(createWorkspaceScope("General"));
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingActionBusy, setPendingActionBusy] = useState(false);
  // Nodes whose priority just changed (chat, Focus check-back, Undo) — the
  // graph pulses them once so the resize reads as a response.
  const [priorityPulseIds, setPriorityPulseIds] = useState<ReadonlySet<string> | null>(null);
  const priorityPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const chatAbortRef = useRef<AbortController | null>(null);

  // Chat history (persistent sessions)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const chatSessionIdRef = useRef<string | null>(null);
  const chatSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous re-entry lock for the chat send + resume paths. State flags
  // (chatLoading / pendingActionBusy) update async, so two events in the same
  // tick could both pass the check and fire two API calls (#11 credit-burn).
  const chatSendingRef = useRef(false);
  // Whether the current brain-dump's text has already been echoed into chat.
  // applyDumpExtraction / the onboarding handoff set it true after echoing the
  // dump once; the clarifying-question flow reads it so it never re-echoes the
  // same dump (#11 duplication). Category-B openers (retry, legacy <nodes>)
  // that DON'T echo reset it to false so the clarifying flow echoes once.
  const dumpInChatRef = useRef(false);

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
  const [edgeRelationId, setEdgeRelationId] = useState<EdgeRelationOptionId>("contains");
  const [edgeTargetId, setEdgeTargetId] = useState("");
  const [edgeError, setEdgeError] = useState<string | null>(null);
  const [edgeSubmitting, setEdgeSubmitting] = useState(false);
  const [edgeDeleteSubmittingId, setEdgeDeleteSubmittingId] = useState<string | null>(null);
  const [edgeUpdateSubmittingId, setEdgeUpdateSubmittingId] = useState<string | null>(null);
  // User-level "about you" intake — a one-time sign-up moment gated on
  // profiles.intake_completed_at. "loading" until we've checked; "open" shows
  // the intake; "done" lets the workspace onboarding (welcome/bootstrap) run.
  const [profileIntakeState, setProfileIntakeState] = useState<"loading" | "open" | "done">(
    "loading",
  );
  // Bootstrap wizard — shown when a new empty workspace is created OR loaded empty
  const [bootstrapWorkspaceId, setBootstrapWorkspaceId] = useState<string | null>(null);
  // Workspaces whose onboarding wizard the user "Skip for now"-ed this session.
  // We do NOT write bootstrap_completed_at on skip, so the wizard can re-offer
  // itself on a later still-empty load — but this set stops it from re-opening
  // immediately when the empty-workspace effect re-runs this same session.
  const bootstrapSkippedThisSessionRef = useRef<Set<string>>(new Set());
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

  // Build graph lookups once per data change. Selection and details-panel
  // rendering are frequent; repeatedly scanning every node and edge there made
  // opening a node progressively slower as a workspace grew.
  const graphIndexes = useMemo(() => {
    const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
    const incidentEdgesByNode = new Map<string, Edge[]>();
    for (const edge of graphData.edges) {
      for (const nodeId of [edge.source_node_id, edge.target_node_id]) {
        const incident = incidentEdgesByNode.get(nodeId) ?? [];
        incident.push(edge);
        incidentEdgesByNode.set(nodeId, incident);
      }
    }
    return {
      ...buildPrimaryStructuralTree(graphData),
      incidentEdgesByNode,
      nodesById,
    };
  }, [graphData]);

  const selectedNode = useMemo(
    () => buildChatNodeContext(graphData, selectedNodeId, graphIndexes),
    [graphData, graphIndexes, selectedNodeId],
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

  // Completed nodes that are NOT on the board (all of them when "Hide done" is
  // on, otherwise the ones older than the recency window) — the shelf lists these.
  const completedNodes = useMemo(
    () =>
      graphData.nodes.filter(
        (node) =>
          node.status === "completed" &&
          (hideCompleted || !isRecentCompletion(node, recentCompletionCutoffMs)),
      ),
    [graphData.nodes, hideCompleted, recentCompletionCutoffMs],
  );

  // Content signature for caches that must invalidate on ANY meaningful graph
  // change (the Focus brief, #9). The old key was "nodes:edges:completedCount",
  // which missed renames, deadline edits, archiving (archived nodes stay in
  // graphData, so counts didn't move), rescoring, and a complete+reopen pair.
  const graphContentSignature = useMemo(
    () => hashGraphContent(graphData.nodes, graphData.edges),
    [graphData.nodes, graphData.edges],
  );

  // Actionable-but-empty nodes (goal/project/class with no next step) — drives
  // the on-load anti-freeze nudge so the user sees what's ready to map out.
  const needsActionNodes = useMemo(
    () => graphData.nodes.filter((n) => needsNextAction(n.id, graphData.nodes, graphData.edges)),
    [graphData],
  );

  // Once the nudge is actually visible this session, snooze it so it doesn't
  // greet the user on the next few reloads.
  useEffect(() => {
    const visible =
      appMode === "graph" &&
      freezeNudgeAllowed &&
      !freezeNudgeDismissed &&
      !stepSuggestionOpen &&
      needsActionNodes.length > 0;
    if (visible && !freezeNudgeShownRef.current) {
      freezeNudgeShownRef.current = true;
      try {
        localStorage.setItem(
          "braindump:freeze-nudge-snooze",
          String(Date.now() + 2 * 24 * 60 * 60 * 1000),
        );
      } catch {
        /* ignore */
      }
    }
  }, [appMode, freezeNudgeAllowed, freezeNudgeDismissed, stepSuggestionOpen, needsActionNodes.length]);

  // Big task / project progress counts done steps even while the canvas
  // hides completed nodes, so it's computed from the full graph.
  const workProgressByNode = useMemo(() => computeWorkProgress(graphData), [graphData]);

  const filteredGraphData = useMemo(() => {
    const nodes = graphData.nodes.filter((node) => {
      // Archived nodes have orphaned edges, so they live in the grouped
      // History shelf rather than floating loose on the canvas.
      if (node.status === "archived") {
        return false;
      }

      // Completed nodes: on the board only while recent (and "Hide done" is off);
      // everything else lives in the Done section of History.
      if (
        node.status === "completed" &&
        (hideCompleted || !isRecentCompletion(node, recentCompletionCutoffMs))
      ) {
        return false;
      }

      if (nodeTypeFilter !== "all" && node.node_type !== nodeTypeFilter) {
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
  }, [
    graphData,
    hideCompleted,
    nodeTypeFilter,
    recentCompletionCutoffMs,
  ]);

  const selectedNodeRecord = useMemo(
    () => graphData.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphData.nodes, selectedNodeId],
  );

  const selectedNodeDeletePlan = useMemo(
    () =>
      selectedNodeId
        ? getStructuralSubtreeFromIndexes(
            selectedNodeId,
            graphIndexes.childrenByParent,
            graphIndexes.incidentEdgesByNode,
          )
        : null,
    [graphIndexes, selectedNodeId],
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
    return (graphIndexes.incidentEdgesByNode.get(selectedNodeId) ?? [])
      .flatMap((edge) => {
        if (isEdgeHiddenInUi(edge.edge_type)) {
          return [];
        }

        if (edge.source_node_id !== selectedNodeId && edge.target_node_id !== selectedNodeId) {
          return [];
        }

        const linkedNodeId =
          edge.source_node_id === selectedNodeId ? edge.target_node_id : edge.source_node_id;
        const linkedNode = graphIndexes.nodesById.get(linkedNodeId);

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
  }, [graphIndexes, selectedNodeId]);

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

  // Graph fetch — keyed ONLY on the two things the query actually depends on
  // (user + workspace). Previously this also depended on the workspace NAME,
  // its bootstrap flag, and profileIntakeState, so the whole graph re-fetched
  // (and the force layout re-ran, freezing a half-settled tangle) every time
  // those resolved during bootstrap. The onboarding decision moved to its own
  // effect below, which reads the already-loaded graph. (Perf: #1)
  useEffect(() => {
    let active = true;

    setGraphLoading(true);
    setFreezeNudgeDismissed(false);

    void loadWorkspaceGraphData(
      authUser?.id ?? null,
      selectedWorkspaceId,
      // workspaceName is display-only inside loadWorkspaceGraphData (not part of
      // the query), so it's read here without being a dependency.
      selectedWorkspace?.name ?? null,
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
  }, [authUser?.id, selectedWorkspaceId]);

  // Onboarding decision — runs AFTER the graph has loaded (reads the loaded
  // node count) instead of re-fetching. For empty workspaces: show welcome for
  // brand-new users, or go straight to the wizard if welcome was already seen.
  // Held until the user-level intake is resolved so the two onboarding overlays
  // never stack. Also held until the workspace RECORD is loaded: the workspace
  // id is seeded from localStorage before the list arrives (parallel
  // bootstrap), and until then `bootstrap_completed_at` reads as missing — which
  // used to reopen the setup wizard on an empty, already-onboarded workspace.
  const selectedWorkspaceLoaded = selectedWorkspace !== null;
  useEffect(() => {
    if (graphLoading || !authUser || !selectedWorkspaceId || !selectedWorkspaceLoaded) return;
    if (graphData.nodes.length !== 0 || profileIntakeState !== "done") return;

    if (shouldShowWelcome(authUser.id)) {
      setShowWelcome(true);
    } else if (
      !selectedWorkspace?.bootstrap_completed_at &&
      !bootstrapSkippedThisSessionRef.current.has(selectedWorkspaceId)
    ) {
      setBootstrapWorkspaceId(selectedWorkspaceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graphLoading,
    graphData.nodes.length,
    authUser?.id,
    selectedWorkspaceId,
    selectedWorkspaceLoaded,
    selectedWorkspace?.bootstrap_completed_at,
    profileIntakeState,
  ]);

  // Resolve the user-level "about you" intake once we know who's signed in.
  // Runs before the workspace onboarding (which is gated on this). Fails soft
  // to "done" so a profile-endpoint error (e.g. table not migrated) never traps
  // the user behind the intake.
  useEffect(() => {
    if (!authUser?.id) return;
    let cancelled = false;
    setProfileIntakeState("loading");
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("profile fetch failed"))))
      .then((data: { intake_completed_at?: string | null }) => {
        if (cancelled) return;
        setProfileIntakeState(data?.intake_completed_at ? "done" : "open");
      })
      .catch(() => {
        if (!cancelled) setProfileIntakeState("done");
      });
    return () => {
      cancelled = true;
    };
  }, [authUser?.id]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active || error) {
        return;
      }

      const sessionUserId = data.session?.user?.id ?? null;
      setAuthUser(
        data.session?.user
          ? {
              email: data.session.user.email ?? null,
              id: data.session.user.id,
            }
          : null,
      );

      // Perf: seed the selected workspace from localStorage the moment auth
      // resolves so the graph fetch can start IN PARALLEL with loadWorkspaces,
      // instead of waiting a full round-trip for the workspace list first.
      // loadWorkspaces still validates/corrects this once it lands (it keeps a
      // valid current selection), so a stale stored id just self-heals.
      if (sessionUserId) {
        const storedWorkspaceId = readLocalSelectedWorkspaceId(sessionUserId);
        if (storedWorkspaceId) {
          setSelectedWorkspaceId((prev) => prev ?? storedWorkspaceId);
        }
      }
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
      // Fired → no longer pending (flushPendingChatSave keys off this ref).
      chatSaveTimerRef.current = null;
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
      chatSaveTimerRef.current = null;
    };
  }, [authUser?.id, selectedWorkspaceId, chatMessages, chatScope]);

  // Persist the current thread IMMEDIATELY if a debounced save is still
  // pending. Anything that switches threads (a dump starting a fresh thread,
  // "New chat", loading another session) used to just cancel the timer, which
  // silently dropped the last <800ms of messages. The session id is read
  // synchronously here, before callers null it for the new thread.
  const flushPendingChatSave = () => {
    const pending = chatSaveTimerRef.current;
    if (!pending) return;
    clearTimeout(pending);
    chatSaveTimerRef.current = null;
    if (!authUser?.id || !selectedWorkspaceId || chatMessages.length === 0) return;
    void upsertChatSession({
      id: chatSessionIdRef.current,
      workspaceId: selectedWorkspaceId,
      scope: chatScope,
      messages: chatMessages,
    }).then((saved) => {
      if (!saved) return;
      setChatSessions((prev) => [
        { ...(prev.find((s) => s.id === saved.id) ?? ({} as ChatSessionMeta)), ...saved },
        ...prev.filter((s) => s.id !== saved.id),
      ]);
    });
  };


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
    flushPendingChatSave();
    setChatMessages([]);
    setChatSessionId(null);
    chatSessionIdRef.current = null;
    setChatScope(createWorkspaceScope(workspaceName));
    setChatHistoryOpen(false);
  };

  const handleLoadChatSession = async (sessionId: string) => {
    const detail = await loadChatSession(sessionId);
    if (!detail) return;
    flushPendingChatSave();
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

  // After a priority change (already applied server-side): reload the graph so
  // node sizes follow the new scores, and pulse the nodes that moved.
  const refreshAfterPriorityChange = async (workspaceId: string, nodeIds: string[]) => {
    if (authUser?.id) {
      try {
        setGraphData(
          await loadWorkspaceGraphData(authUser.id, workspaceId, selectedWorkspace?.name ?? null),
        );
      } catch {
        // The card still shows the change; the next load resizes the nodes.
      }
    }
    if (priorityPulseTimerRef.current) clearTimeout(priorityPulseTimerRef.current);
    setPriorityPulseIds(new Set(nodeIds));
    priorityPulseTimerRef.current = setTimeout(() => setPriorityPulseIds(null), PRIORITY_PULSE_MS);
  };

  // Undo on an applied priority card: the server restores exactly the fields
  // the change touched (lib/ai/tools/priority-mutations undoPriorityChanges).
  const undoAppliedAction = async (messageId: string, slot?: "commitments") => {
    // A brain-dump turn card holds two applied changes: the priority changes
    // (the message's own) and the weekly commitments (slot "commitments").
    const message = chatMessages.find((m) => m.id === messageId);
    const action = slot === "commitments" ? message?.turn?.commitments : message?.appliedAction;
    const workspaceId = selectedWorkspaceId;
    if (!action || (action.status !== "applied" && action.status !== "error") || !workspaceId) return;

    const setStatus = (status: AppliedAction["status"], errorMessage?: string) =>
      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          if (slot === "commitments") {
            return m.turn?.commitments
              ? { ...m, turn: { ...m.turn, commitments: { ...m.turn.commitments, status, errorMessage } } }
              : m;
          }
          return m.appliedAction ? { ...m, appliedAction: { ...m.appliedAction, status, errorMessage } } : m;
        }),
      );

    setStatus("undoing");
    try {
      const res = await fetch(appliedUndoEndpoint(action), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, undo: action.undo, ...clientDayHints() }),
      });
      if (!res.ok) throw new Error("undo failed");
      setStatus("undone");
      if (isCommitmentAction(action)) clearFocusCache(workspaceId);
    } catch {
      setStatus("error", "Couldn't undo that — try again.");
    }
    void refreshAfterPriorityChange(
      workspaceId,
      action.items.map((item) => item.nodeId),
    );
  };

  // Undo on a brain-dump turn card's "Added": removes the nodes that dump
  // created (and teaches the auto-apply calibration, as the old toast did).
  // The Undo on one section of a turn card (Added / Marked done / Linked).
  // Cards from before 2026-10-02 carry no undo steps: their Added Undo goes
  // through the proposal ledger instead.
  const undoTurnSection = async (messageId: string, section: TurnSection) => {
    const turn = chatMessages.find((m) => m.id === messageId)?.turn;
    if (!turn) return;
    const statusKey = section === "added" ? "addedStatus" : section === "done" ? "doneStatus" : "linksStatus";
    const status = turn[statusKey] ?? "applied";
    if (status !== "applied" && status !== "error") return;
    const steps = turn.undo?.[section] ?? [];
    const proposalIds = section === "added" ? turn.added.flatMap((n) => (n.proposalId ? [n.proposalId] : [])) : [];
    if (steps.length === 0 && proposalIds.length === 0) return;
    const setStatus = (next: TurnAddedStatus) =>
      setChatMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.turn ? { ...m, turn: { ...m.turn, [statusKey]: next } } : m)),
      );
    setStatus("undoing");
    const ok =
      steps.length > 0 ? await undoChangeSteps(steps) : (await undoAutoApplied(proposalIds)).length > 0;
    setStatus(ok ? "undone" : "error");
    if (ok) await reloadGraphAfterUndo();
  };

  // The Undo on a card's accepted rows (a reorganization, a suggestion OK'd).
  const undoAcceptedCard = async (messageId: string) => {
    const action = chatMessages.find((m) => m.id === messageId)?.pendingAction;
    if (!action || action.status !== "accepted" || !action.undo?.length) return;
    if (action.undoStatus && action.undoStatus !== "error") return;
    const setStatus = (undoStatus: TurnAddedStatus) =>
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.pendingAction ? { ...m, pendingAction: { ...m.pendingAction, undoStatus } } : m,
        ),
      );
    setStatus("undoing");
    const ok = await undoChangeSteps(action.undo);
    setStatus(ok ? "undone" : "error");
    if (ok) await reloadGraphAfterUndo();
  };

  const undoChangeSteps = async (steps: unknown[]): Promise<boolean> => {
    if (!selectedWorkspaceId) return false;
    try {
      const res = await fetch("/api/changes/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: selectedWorkspaceId, steps }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { undone?: number };
      return (data.undone ?? 0) > 0;
    } catch {
      return false;
    }
  };

  const reloadGraphAfterUndo = async () => {
    if (!selectedWorkspaceId || !authUser?.id) return;
    try {
      setGraphData(await loadWorkspaceGraphData(authUser.id, selectedWorkspaceId, selectedWorkspace?.name ?? null));
    } catch {
      // The next load catches up.
    }
  };

  // A question on a brain-dump turn card, answered: the answer is an ordinary
  // chat message — the thread's note of the dump (turn-note.ts) tells the
  // model what was asked, so nothing synthetic is sent.
  const answerTurnQuestion = (messageId: string, questionIndex: number, answer: string) => {
    const turn = chatMessages.find((m) => m.id === messageId)?.turn;
    const question = turn?.questions[questionIndex];
    const text = answer.trim();
    if (!turn || !question || question.answer || !text || chatLoading || chatSendingRef.current) return;
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.turn
          ? {
              ...m,
              turn: {
                ...m.turn,
                questions: m.turn.questions.map((q, i) => (i === questionIndex ? { ...q, answer: text } : q)),
              },
            }
          : m,
      ),
    );
    // With several questions open, say which one this answers.
    const open = turn.questions.filter((q) => !q.answer).length;
    void submitMessage(open > 1 ? `About "${question.text}" — ${text}` : text);
  };

  // Focus's check-back card: "It's done" completes the waiting item; "Still
  // waiting" keeps it on hold and asks again in a week. Same engine as chat's
  // update_priorities, no model call.
  const handleCheckBack = async (nodeId: string, decision: "done" | "still_waiting") => {
    const workspaceId = selectedWorkspaceId;
    if (!workspaceId) return;
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
      body: JSON.stringify({ workspace_id: workspaceId, changes: [change], ...clientDayHints() }),
    });
    if (!res.ok) throw new Error("check-back failed");
    showToast(decision === "done" ? "Done ✓" : `OK — I'll ask again next week`);
    await refreshAfterPriorityChange(workspaceId, [nodeId]);
  };

  // Streams /api/assistant/chat (or /resume) into the assistant bubble.
  // Handles the <<BRAINDUMP_PAUSE>> marker: when seen, attaches a pending
  // action to the bubble so the user gets an inline Accept/Reject card.
  // Also runs the <recompute_scores/> post-
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
    // Chained after the pause parser: a change chat already applied
    // (update_priorities) arrives as its own marker → applied card + Undo;
    // a change / build_graph call's turn card (what applied now, with Undo);
    // the Undo for the rows a card's Accept just applied.
    const appliedParser = createAppliedMarkerParser();
    const turnParser = createTurnMarkerParser();
    const undoParser = createUndoMarkerParser();
    const turnAddedIds = new Set<string>();
    let turnChanged = false;
    let cleanText = "";
    let sawPause = false;
    const appliedNodeIds = new Set<string>();

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

    const attachApplied = (applied: Omit<AppliedAction, "status">) => {
      for (const item of applied.items) appliedNodeIds.add(item.nodeId);
      // Busy time changed — Focus's cached list no longer knows it.
      if (isCommitmentAction(applied) && selectedWorkspaceId) clearFocusCache(selectedWorkspaceId);
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, appliedAction: { ...applied, status: "applied" } } : m,
        ),
      );
    };

    const attachTurn = (card: TurnCardData) => {
      for (const node of card.added) turnAddedIds.add(node.id);
      turnChanged = true;
      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          if (!m.turn) return { ...m, turn: card };
          // A second change in the same reply: one card, sections joined.
          const undo = m.turn.undo ?? { added: [], done: [], links: [] };
          return {
            ...m,
            turn: {
              ...m.turn,
              added: [...m.turn.added, ...card.added],
              done: [...m.turn.done, ...card.done],
              links: [...m.turn.links, ...card.links],
              questions: [...m.turn.questions, ...card.questions],
              undo: {
                added: [...undo.added, ...(card.undo?.added ?? [])],
                done: [...undo.done, ...(card.undo?.done ?? [])],
                links: [...undo.links, ...(card.undo?.links ?? [])],
              },
            },
          };
        }),
      );
    };

    const attachUndo = (steps: unknown[]) => {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId && m.pendingAction ? { ...m, pendingAction: { ...m.pendingAction, undo: steps } } : m,
        ),
      );
    };

    const takeText = (text: string) => {
      const afterUndo = undoParser.push(text);
      if (afterUndo.marker) attachUndo(afterUndo.marker);
      const afterTurn = turnParser.push(afterUndo.text);
      if (afterTurn.marker) attachTurn(afterTurn.marker);
      const next = appliedParser.push(afterTurn.text);
      if (next.marker) attachApplied(next.marker);
      if (next.text.length > 0) {
        cleanText += next.text;
        writeBody(cleanText);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const parsed = parser.push(chunk);
      takeText(parsed.text);
      if (parsed.pause && !sawPause) {
        sawPause = true;
        attachPending({ ...parsed.pause, status: "awaiting" });
      }
    }
    takeText(parser.flush().text);
    // Drain the chained parsers in order (undo → turn → applied).
    let rest = undoParser.flush().text;
    rest = turnParser.push(rest).text + turnParser.flush().text;
    rest = appliedParser.push(rest).text + appliedParser.flush().text;
    if (rest.length > 0) {
      cleanText += rest;
      writeBody(cleanText);
    }

    // A chat change applied at once: show it on the graph now, and look for
    // links around the new nodes — the same follow-up a dump gets.
    if (turnChanged && targetWorkspaceId && authUser?.id) {
      void loadWorkspaceGraphData(authUser.id, targetWorkspaceId, selectedWorkspace?.name ?? null)
        .then((next) => setGraphData(next))
        .catch(() => {
          // The next load catches up.
        });
      if (turnAddedIds.size > 0) void analyzeNodes([...turnAddedIds], targetWorkspaceId, assistantMsgId);
    }

    // The graph already changed — resize the nodes now and pulse the ones
    // that moved, so the rerank is visible where the user is looking.
    if (appliedNodeIds.size > 0 && targetWorkspaceId) {
      void refreshAfterPriorityChange(targetWorkspaceId, [...appliedNodeIds]);
    }

    if (sawPause) return;

    // <recompute_scores/> — only when we reached end_turn (no pause).
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
  };

  const submitMessage = async (message: string, duplicateUserMessage = true) => {
    const trimmedMessage = message.trim();

    // chatLoading is async state; chatSendingRef is a synchronous lock so two
    // events in the same tick (e.g. Enter + click) can't fire two POSTs and
    // duplicate the message / double-bill (#11).
    if (trimmedMessage.length === 0 || chatLoading || chatSendingRef.current) {
      return;
    }
    chatSendingRef.current = true;
    // Everything after taking the lock runs inside try/finally, so no failure
    // path can leave chat permanently locked.
    const assistantMsgId = `chat-${Math.random().toString(36).slice(2, 10)}`;
    const abortCtrl = new AbortController();

    try {
      const nextScope = chatMessages.length === 0 ? defaultChatScope : chatScope;
      const targetWorkspaceId = selectedWorkspaceId;

      setRightPanelOpen(true);
      setActiveRailTab("chat");
      setChatScope(nextScope);
      setRailChatInput("");

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
      // An applied priority card has no text of its own — its note tells the
      // model what already changed (or that the user undid it).
      const historyNodeTitles = new Map(graphData.nodes.map((n) => [n.id, n.title]));
      const history = chatMessages
        .filter((m) => m.status !== "error")
        .map((m) => ({
          role: m.role,
          // A brain dump's card has no text either: its note lists what was
          // added, finished, linked, asked and what still waits (turn-note.ts).
          body: m.connections
            ? connectionsNote(m.connections)
            : m.turn
            ? `${m.body ?? ""}\n\n${turnNote(m, historyNodeTitles)}`.trim()
            : m.appliedAction
              ? `${m.body ?? ""}\n\n${appliedActionNote(m.appliedAction)}`.trim()
              : (m.body ?? ""),
        }))
        .filter((m) => m.body.trim().length > 0);

      chatAbortRef.current = abortCtrl;

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
      chatSendingRef.current = false;
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
    // A change-set card accepted in part: the rows the user kept.
    acceptedIndexes?: number[],
  ) => {
    // pendingActionBusy is async state; chatSendingRef is the synchronous lock
    // so a rapid double-click can't fire two resume POSTs (#11 credit-burn).
    if (pendingActionBusy || chatSendingRef.current) return;

    const target = chatMessages.find((m) => m.id === messageId);
    const action = target?.pendingAction;
    if (!action || action.status !== "awaiting") return;

    const targetWorkspaceId = selectedWorkspaceId;
    // When the server runs an accepted plan_day: a plan with no start time
    // starts then, and the Planner lands it there.
    const acceptedAt = Date.now();

    chatSendingRef.current = true;
    // As in submitMessage: everything after taking the lock is inside
    // try/finally so no failure path can leave chat locked.
    const abortCtrl = new AbortController();

    try {
      setPendingActionBusy(true);
      setChatLoading(true);
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.pendingAction
            ? {
                ...m,
                pendingAction: {
                  ...m.pendingAction,
                  // Accept shows "Applying…" until the server has done it.
                  status: decision === "reject" ? "rejected" : decision === "accept" ? "applying" : "accepted",
                  ...(decision === "accept" && acceptedIndexes ? { acceptedIndexes } : {}),
                },
              }
            : m,
        ),
      );

      chatAbortRef.current = abortCtrl;

      const res = await fetch("/api/assistant/chat/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: action.runId,
          decision,
          choice,
          ...(decision === "accept" && acceptedIndexes ? { accepted_indexes: acceptedIndexes } : {}),
        }),
        signal: abortCtrl.signal,
      });

      const markApplied = () =>
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.pendingAction?.status === "applying"
              ? { ...m, pendingAction: { ...m.pendingAction, status: "accepted" } }
              : m,
          ),
        );
      // The server applies the accepted action BEFORE it answers. When a
      // follow-up answer streams after it (seconds of text), show the change
      // now instead of after the last word — "mark X done" used to land on
      // the graph only once the reply to the rest of the message was over.
      // The graph is loaded again below: the follow-up can change more.
      let graphLoadedAfterReply = false;
      if (decision === "accept" && res.ok && res.headers.get("X-Resume-Model") !== "none") {
        markApplied();
        if (targetWorkspaceId && authUser?.id) {
          void loadWorkspaceGraphData(authUser.id, targetWorkspaceId, selectedWorkspace?.name ?? null)
            .then((next) => {
              if (!graphLoadedAfterReply) setGraphData(next);
            })
            .catch(() => {
              // The load after the reply catches up.
            });
        }
      }

      await consumeAssistantStream(res, messageId, targetWorkspaceId, true);
      if (decision === "accept") markApplied();

      // If the user accepted a graph-changing tool, refresh the graph.
      if (decision === "accept" && targetWorkspaceId && authUser?.id) {
        const prevNodeIds = new Set(graphData.nodes.map((n) => n.id));
        const nextGraphData = await loadWorkspaceGraphData(
          authUser.id,
          targetWorkspaceId,
          selectedWorkspace?.name ?? null,
        );
        graphLoadedAfterReply = true;
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
          void analyzeNodes(newNodeIds, targetWorkspaceId, messageId);
        }

        // If the accepted tool mutated calendar tasks, the planner's persisted
        // tasks are now stale — bump the refresh key so AssistantMode re-fetches.
        const PLANNER_TOOLS = ["add_task_to_calendar", "reschedule_task", "mark_task_done"];
        if (action.toolName && PLANNER_TOOLS.includes(action.toolName)) {
          setPlannerRefreshKey((v) => v + 1);
        }

        // A chat-generated plan (plan_day) is drafted server-side but invisible
        // until the planner loads it. Switch to the planner and pull the draft
        // into its review UI so the user actually sees what was generated (#6).
        if (action.toolName === "plan_day") {
          setAppMode("assistant");
          setDraftPlanHint({
            startTime: action.toolInput?.start_time,
            busy: action.toolInput?.busy,
            window: action.toolInput?.window,
            acceptedAt,
          });
          setDraftPlanRefreshKey((v) => v + 1);
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
      chatSendingRef.current = false;
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
      // Local date — plan_tasks.scheduled_date is the user's day, not UTC's.
      const today = localDateISO();
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
    // Set the timer UP but PAUSED — the user presses Start when they're ready.
    // Focus should never auto-run a countdown (testing journal #4).
    focusTimer.start({ nodeId, title: node.title, durationMinutes, paused: true });
  };

  // Complete a focus session: stop the timer, confirm via toast, and — if a
  // linked plan_task exists for today — mark it done and refresh the planner.
  const handleFocusDone = async () => {
    const active = focusTimer.timer;
    focusTimer.stop();
    showToast("Nice work — focus session done.");
    if (!active || !supabase || !selectedWorkspaceId || !authUser?.id) return;
    // Local date — plan_tasks.scheduled_date is the user's day, not UTC's.
    const today = localDateISO();
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
    // A new node hangs under the workspace root by default, like a chat- or
    // dump-made one; the sheet's "Under" changes it ("" = top level).
    const rootId = selectedWorkspace?.bootstrap_root_node_id ?? "";
    const rootLive = rootId !== "" && graphData.nodes.some((node) => node.id === rootId);
    setCreateNodeDraft({ ...defaultCreateNodeDraft, parent_id: rootLive ? rootId : "" });
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
    setHideCompleted(false);
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
          ? nodeColorByType.note
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
        userId: authUser.id,
        workspaceId: selectedWorkspaceId,
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
          ? nodeColorByType.note
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

  // A brain dump handled as ONE turn: the dump, then ONE assistant message —
  // the reply to its human part, and one card with everything it changed.
  // No review modal, no toast, no separate cards (docs/unified-turn.md).
  const applyDumpTurn = async (
    rawText: string,
    turn: DumpTurn,
    data: {
      priority_update?: (Omit<AppliedMarkerPayload, "tool_name"> & { unclear?: string[] }) | null;
      commitment_update?: Omit<AppliedMarkerPayload, "tool_name"> | null;
      pending_action?: {
        run_id: string;
        tool_use_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
      } | null;
    },
    workspaceId: string | null,
    continueThread: boolean,
  ) => {
    const priorityAction = data.priority_update
      ? appliedActionFromPayload({ ...data.priority_update, tool_name: "update_priorities" })
      : null;
    const commitmentAction = data.commitment_update
      ? appliedActionFromPayload({ ...data.commitment_update, tool_name: "set_commitments" })
      : null;
    if (commitmentAction && workspaceId) clearFocusCache(workspaceId);
    const waiting = data.pending_action ?? null;

    const card: TurnCardData = {
      ...(turnCardFromApplied(turn) ?? { added: [], addedStatus: "applied", done: [], links: [], questions: [] }),
      ...(commitmentAction ? { commitments: { ...commitmentAction, status: "applied" as const } } : {}),
    };
    const changedGraph = card.added.length > 0 || card.done.length > 0 || card.links.length > 0;
    const nothing =
      !changedGraph && card.questions.length === 0 && !priorityAction && !commitmentAction && !waiting;

    const nowIso = new Date().toISOString();
    const turnMessageId = `chat-turn-${Math.random().toString(36).slice(2, 10)}`;
    const turnMessage: ChatMessage = {
      id: turnMessageId,
      role: "assistant" as const,
      body: turn.reply ?? (nothing ? "I went through that and found nothing to add or change." : ""),
      createdAt: nowIso,
      status: "ready" as const,
      turn: card,
      ...(priorityAction ? { appliedAction: { ...priorityAction, status: "applied" as const } } : {}),
      ...(waiting
        ? {
            pendingAction: {
              runId: waiting.run_id,
              toolUseId: waiting.tool_use_id,
              toolName: waiting.tool_name,
              toolInput: waiting.tool_input,
              status: "awaiting" as const,
            },
          }
        : {}),
    };
    if (continueThread) {
      setChatMessages((prev) => [...prev, turnMessage]);
    } else {
      // #18: a dump from the Brain Dump box starts a FRESH chat thread (the
      // previous one is auto-saved).
      flushPendingChatSave();
      setChatSessionId(null);
      chatSessionIdRef.current = null;
      setChatScope(createWorkspaceScope(workspaceName));
      setChatMessages([
        {
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: rawText,
          createdAt: nowIso,
          status: "ready" as const,
        },
        turnMessage,
      ]);
    }
    dumpInChatRef.current = true;
    setRightPanelOpen(true);
    setActiveRailTab("chat");

    // The graph already changed on the server — show it.
    if (workspaceId && (changedGraph || priorityAction)) {
      if (priorityAction) {
        await refreshAfterPriorityChange(
          workspaceId,
          priorityAction.items.map((item) => item.nodeId),
        );
      } else if (authUser?.id) {
        try {
          setGraphData(
            await loadWorkspaceGraphData(authUser.id, workspaceId, selectedWorkspace?.name ?? null),
          );
        } catch {
          // The card still shows the change; the next load draws the nodes.
        }
      }
      if (card.added.length > 0) {
        setClusterRefreshKey((k) => k + 1);
        // Links it notices land in this thread, not in a modal.
        void analyzeNodes(
          card.added.map((n) => n.id),
          workspaceId,
          turnMessageId,
        );
      }
    }
  };

  // Shared tail for every dump (button, chat, bootstrap): mirror the dump +
  // a conversational summary into chat, then open the proposed-nodes review
  // modal. One implementation so all entry points behave identically.
  const applyDumpExtraction = async (
    rawText: string,
    data: {
      proposed_nodes?: ProposedNode[];
      clarifying_questions?: string[];
      completed_existing_node_titles?: string[];
      suggested_areas?: Array<{ title: string; area_type: string }>;
      auto_apply_proposal_ids?: string[];
      // What the dump changed about existing priorities (already applied).
      priority_update?: (Omit<AppliedMarkerPayload, "tool_name"> & { unclear?: string[] }) | null;
      // Fixed weekly commitments the dump named (already saved).
      commitment_update?: Omit<AppliedMarkerPayload, "tool_name"> | null;
      // The dump handled as ONE turn (docs/unified-turn.md): what it added,
      // finished and linked, the reply to its human part, open questions.
      turn?: DumpTurn;
      // Edits to existing nodes the dump asked for — one card to Accept
      // (same payload as chat's pause marker).
      pending_action?: {
        run_id: string;
        tool_use_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
      } | null;
    },
    workspaceId: string | null,
    // From the chat composer: the dump continues the current thread (its
    // message is already shown) instead of opening a fresh one.
    opts?: { continueThread?: boolean },
  ) => {
    if (data.turn) {
      await applyDumpTurn(rawText, data.turn, data, workspaceId, opts?.continueThread ?? false);
      return;
    }
    const nodes = data.proposed_nodes ?? [];
    const questions = data.clarifying_questions ?? [];
    const completedTitles = data.completed_existing_node_titles ?? [];
    const areas = data.suggested_areas ?? [];
    const autoIds = (data.auto_apply_proposal_ids ?? []).filter((id) =>
      nodes.some((n) => n.id === id),
    );
    // Dump → priorities: shown as the same applied card chat uses, with Undo.
    const priorityAction = data.priority_update
      ? appliedActionFromPayload({ ...data.priority_update, tool_name: "update_priorities" })
      : null;
    const unclear = data.priority_update?.unclear ?? [];
    // Dump → fixed commitments: their own card (a message can hold one).
    const commitmentAction = data.commitment_update
      ? appliedActionFromPayload({ ...data.commitment_update, tool_name: "set_commitments" })
      : null;
    if (commitmentAction && workspaceId) clearFocusCache(workspaceId);
    // Dump → a restructure of existing nodes: the same Accept card chat shows.
    const restructure = data.pending_action ?? null;

    const buildSummary = (appliedCount: number, reviewCount: number) =>
      [
        appliedCount > 0
          ? `I added ${appliedCount} item${appliedCount === 1 ? "" : "s"} to your graph${
              reviewCount > 0
                ? ` — ${reviewCount} ${reviewCount === 1 ? "needs" : "need"} a quick look in the panel that just opened.`
                : "."
            }`
          : reviewCount > 0
            ? `I analyzed your dump and proposed ${reviewCount} node${reviewCount === 1 ? "" : "s"} and their connections — review and accept them in the panel that just opened.`
            : priorityAction
              ? "Nothing new to add — I updated what matters instead:"
              : commitmentAction || restructure
                ? "Nothing new to add to the graph."
                : "I went through your dump but didn't find anything new worth proposing.",
        completedTitles.length > 0
          ? `I also marked ${completedTitles.length} existing item${completedTitles.length === 1 ? "" : "s"} done: ${completedTitles.slice(0, 3).join(", ")}${completedTitles.length > 3 ? "…" : ""}.`
          : null,
        questions.length > 0
          ? `I have ${questions.length} quick clarifying question${questions.length === 1 ? "" : "s"} — answer inline when ready.`
          : null,
        priorityAction && appliedCount + reviewCount > 0 ? "I also updated what matters:" : null,
        unclear.length > 0 ? `One thing I didn't change — ${unclear[0]} Tell me here and I'll update it.` : null,
      ]
        .filter(Boolean)
        .join(" ");

    const nowIso = new Date().toISOString();
    const summaryId = `chat-extract-${Math.random().toString(36).slice(2, 10)}`;
    // #18: a dump starts a FRESH chat thread — the previous conversation is
    // already auto-saved, so cut the session over and REPLACE the visible
    // messages instead of appending. #11: this echoes the dump text exactly
    // once, and dumpInChatRef=true tells the clarifying-question flow below not
    // to echo it a second time. (The old code appended here and relied on a
    // fragile mid-thread wipe, which dropped the summary and could double the
    // echo depending on timing.) The old thread is flushed first, so it's
    // genuinely saved before we cut over. Posted BEFORE auto-apply so the
    // roadmap prompt it may add lands after the summary, not wiped by it.
    flushPendingChatSave();
    setChatSessionId(null);
    chatSessionIdRef.current = null;
    setChatScope(createWorkspaceScope(workspaceName));
    setChatMessages([
      {
        id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
        role: "user" as const,
        body: rawText,
        createdAt: nowIso,
        status: "ready" as const,
      },
      {
        id: summaryId,
        role: "assistant" as const,
        body: buildSummary(autoIds.length, nodes.length - autoIds.length),
        createdAt: nowIso,
        status: "ready" as const,
        ...(priorityAction ? { appliedAction: { ...priorityAction, status: "applied" as const } } : {}),
      },
      ...(commitmentAction
        ? [
            {
              id: `chat-commit-${Math.random().toString(36).slice(2, 10)}`,
              role: "assistant" as const,
              body: "And your week:",
              createdAt: nowIso,
              status: "ready" as const,
              appliedAction: { ...commitmentAction, status: "applied" as const },
            },
          ]
        : []),
      ...(restructure
        ? [
            {
              id: `chat-restructure-${Math.random().toString(36).slice(2, 10)}`,
              role: "assistant" as const,
              body: "You also asked to reorganize what's already there — here's the change:",
              createdAt: nowIso,
              status: "ready" as const,
              pendingAction: {
                runId: restructure.run_id,
                toolUseId: restructure.tool_use_id,
                toolName: restructure.tool_name,
                toolInput: restructure.tool_input,
                status: "awaiting" as const,
              },
            },
          ]
        : []),
    ]);
    dumpInChatRef.current = true;
    setRightPanelOpen(true);
    setActiveRailTab("chat");

    // Calibrated auto-apply (src/lib/ai/auto-apply.ts): the proposals this user
    // reliably accepts go straight into the graph through the normal review
    // route, with a one-tap Undo — no modal. Only the rest need a look.
    let appliedIds = new Set<string>();
    if (autoIds.length > 0) {
      const batch = await acceptProposalsNow(autoIds);
      if (batch && batch.acceptedNodes.length > 0) {
        appliedIds = new Set(autoIds);
        setClusterRefreshKey((k) => k + 1);
        mergeAcceptedIntoGraph(batch.acceptedNodes, batch.acceptedEdges);
        const createdIds = batch.acceptedNodes.map((n) => n.id);
        if (workspaceId) void analyzeNodes(createdIds, workspaceId);
        setAutoApplyUndo({ proposalIds: autoIds, nodeIds: createdIds, count: createdIds.length });
      } else {
        // Couldn't apply — fall back to reviewing everything, and say so.
        setChatMessages((prev) =>
          prev.map((m) => (m.id === summaryId ? { ...m, body: buildSummary(0, nodes.length) } : m)),
        );
      }
    }

    if (priorityAction && workspaceId) {
      void refreshAfterPriorityChange(
        workspaceId,
        priorityAction.items.map((item) => item.nodeId),
      );
    }

    const remaining = nodes.filter((n) => !appliedIds.has(n.id));
    if (remaining.length > 0 || questions.length > 0) {
      setProposedNodes(remaining);
      setClarifyingQuestions(questions);
      setSuggestedAreas(areas);
      setLastDumpRawText(rawText);
      setProposedReviewOpen(true);
    }
  };

  // Stable so the notice's auto-dismiss timer isn't reset on every render.
  const dismissAutoApplyNotice = useCallback(() => setAutoApplyUndo(null), []);

  // One-tap Undo for auto-applied proposals: remove the nodes and teach the
  // calibration that this kind of proposal needs review for this user.
  const handleUndoAutoApply = async () => {
    const pending = autoApplyUndo;
    if (!pending) return;
    setAutoApplyUndo(null);
    const removedIds = new Set(await undoAutoApplied(pending.proposalIds));
    if (removedIds.size === 0) {
      showToast("Couldn't undo — those items may have changed.");
      return;
    }
    setGraphData((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => !removedIds.has(n.id)),
      edges: prev.edges.filter(
        (e) => !removedIds.has(e.source_node_id) && !removedIds.has(e.target_node_id),
      ),
    }));
    showToast(`Removed ${removedIds.size} item${removedIds.size === 1 ? "" : "s"}.`);
  };

  // A dump typed in the chat composer: the same turn as the Brain Dump box —
  // one reply and one card — but it continues THIS thread, and the reply sees
  // the conversation so far.
  const submitDumpFromChat = async (text: string) => {
    const trimmed = text.trim();
    const targetWorkspaceId = selectedWorkspaceId;
    if (!trimmed || !targetWorkspaceId || chatSendingRef.current) return;
    chatSendingRef.current = true;
    const history = chatMessages
      .filter((m) => m.status !== "error" && m.body.trim().length > 0)
      .slice(-6)
      .map((m) => ({ role: m.role, body: m.body.slice(0, 600) }));
    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatMessages((prev) => [...prev, createUserChatMessage(trimmed)]);
    setChatLoading(true);
    const fail = (body: string) =>
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-err-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body,
          createdAt: new Date().toISOString(),
          status: "error" as const,
        },
      ]);
    // The wait is counted from the send, not from the first line back.
    const startedAt = Date.now();
    setDumpProgress({ stage: "reading", startedAt });
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: trimmed,
          workspace_id: targetWorkspaceId,
          history,
          stream: true,
        }),
      });
      const { status, data } = await readDumpResponse<
        Parameters<typeof applyDumpExtraction>[1] & { error?: string; message?: string }
      >(res, (stage) => setDumpProgress({ stage, startedAt }));
      if (status >= 300 || status === 207) {
        fail(data.error ?? data.message ?? "I couldn't work through that just now. Try again or rephrase it.");
        return;
      }
      await applyDumpExtraction(trimmed, data as Parameters<typeof applyDumpExtraction>[1], targetWorkspaceId, {
        continueThread: true,
      });
    } catch {
      fail("Network error processing that. Try again.");
    } finally {
      chatSendingRef.current = false;
      setChatLoading(false);
      setDumpProgress(null);
    }
  };

  // A fresh dump, or (retryEntryId) the failed one again: the same one turn —
  // reply, card, progress. Until 2026-10-03 a retry opened the old review
  // modal and dropped any reorganization the dump asked for.
  const handleBrainDumpSubmit = async (retryEntryId?: string) => {
    const trimmed = brainDumpValue.trim();
    // Use the workspace captured at open time, not the current selection.
    const targetWorkspaceId = brainDumpWorkspaceId ?? selectedWorkspaceId;
    if ((!trimmed && !retryEntryId) || brainDumpSubmitting || !targetWorkspaceId) return;

    setBrainDumpSubmitting(true);
    if (retryEntryId) setBrainDumpRetrying(true);
    setBrainDumpError(null);
    setBrainDumpFailedEntryId(null);
    const startedAt = Date.now();
    setDumpProgress({ stage: "reading", startedAt });
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: trimmed,
          workspace_id: targetWorkspaceId,
          stream: true,
          ...(retryEntryId ? { retry_entry_id: retryEntryId } : {}),
        }),
      });
      const read = await readDumpResponse<{
        proposed_nodes?: ProposedNode[];
        clarifying_questions?: string[];
        raw_entry_id?: string;
        error?: string;
        message?: string;
      }>(res, (stage) => setDumpProgress({ stage, startedAt }));
      const data = read.data;
      if (read.status >= 300) {
        setBrainDumpError(data.error ?? data.message ?? "Could not process that brain dump.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? null);
        return;
      }
      if (read.status === 207) {
        setBrainDumpError(data.error ?? data.message ?? "Extraction failed. Retry when ready.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? null);
        return;
      }

      setBrainDumpValue("");
      setBrainDumpOpen(false);
      setBrainDumpError(null);
      setBrainDumpFailedEntryId(null);
      await applyDumpExtraction(trimmed, data, targetWorkspaceId);
    } catch (err) {
      setBrainDumpError(
        err instanceof Error ? err.message : "Could not process that brain dump.",
      );
    } finally {
      setBrainDumpSubmitting(false);
      setBrainDumpRetrying(false);
      setDumpProgress(null);
    }
  };

  const handleBrainDumpRetry = async () => {
    if (!brainDumpFailedEntryId || brainDumpRetrying) return;
    await handleBrainDumpSubmit(brainDumpFailedEntryId);
  };

  // Create the life-area branches the user selected in the review modal. Runs
  // BEFORE node acceptance (the modal awaits it first), so the areas exist +
  // are embedded when the accepted nodes get connection-analyzed and linked
  // under them. Best-effort — a failure here must never block accepting nodes.
  const handleAddAreas = async (areas: Array<{ title: string; area_type: string }>) => {
    if (!selectedWorkspaceId || areas.length === 0) return;
    try {
      await fetch(`/api/workspaces/${selectedWorkspaceId}/areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areas }),
      });
      // Reload so the new branch nodes + their root edges render. The node
      // acceptance that runs right after appends onto this fresh graph.
      const next = await loadWorkspaceGraphData(
        authUser?.id ?? null,
        selectedWorkspaceId,
        selectedWorkspace?.name ?? null,
      );
      setGraphData(next);
    } catch {
      // Best-effort — area creation failing shouldn't block node acceptance.
    }
  };

  // Merge freshly accepted nodes into the graph: position unattached ones near
  // the viewport centre, clear stale positions for attached ones, and softly
  // offer a roadmap for any project that landed with no steps. Shared by the
  // review modal and calibrated auto-apply so both behave identically.
  const mergeAcceptedIntoGraph = (nodes: Node[], acceptedEdges: Edge[]) => {
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
    // The review route runs the clustering pass server-side; re-poll so any new
    // grouping suggestions surface right after accepting a dump's nodes.
    setClusterRefreshKey((k) => k + 1);
    if (data.accepted_nodes && data.accepted_nodes.length > 0) {
      mergeAcceptedIntoGraph(data.accepted_nodes, data.accepted_edges ?? []);
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
    // The accepted nodes are in the graph now, so the answers given inline can
    // be acted on without duplicating anything still under review.
    sendInlineAnswersToChat();

    // First-dump shortcut: if these proposals came from the bootstrap
    // wizard, skip the suggest-steps modal — a first dump already produces
    // enough nodes and the user just spent time reviewing them; don't dogpile
    // them with another modal + a stack of Sonnet calls. Suggest-steps stays
    // available manually from any node's details panel. We DO still run
    // connection analysis, though: the wizard builds the initial graph and the
    // user expects edges between their nodes (and to the life-areas) to appear.
    if (proposalsFromBootstrap) {
      setProposalsFromBootstrap(false);
      if (data.accepted_nodes && data.accepted_nodes.length > 0 && selectedWorkspaceId) {
        const bootstrapNodeIds = (data.accepted_nodes as Node[]).map((n) => n.id);
        void analyzeNodes(bootstrapNodeIds, selectedWorkspaceId);
      }
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
          (n.node_type === "goal" ||
            n.node_type === "project" ||
            n.node_type === "big_task" ||
            n.node_type === "habit") &&
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
            selected: true,
          })),
        );
        setStepSuggestionOpen(true);
      } else {
        // No goals/projects — run connection analysis immediately
        void analyzeNodes(nodeIds);
      }
    }
  };

  // Generated steps land as ONE Suggested card in a fresh chat thread, the
  // way a dump's changes do (fix list #8): the step-writer makes one call per
  // item (api/nodes/suggest-steps), nothing changes until Apply. Until
  // 2026-10-03 its text went through a second extraction into the old review
  // modal.
  const requestSteps = async (
    nodes: Array<{ id: string }>,
    mode: "light" | "full",
    instructions: string | undefined,
    signal: AbortSignal,
  ) => {
    const workspaceId = selectedWorkspaceId;
    if (!workspaceId || nodes.length === 0) return;
    const res = await fetch("/api/nodes/suggest-steps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_ids: nodes.map((n) => n.id),
        workspace_id: workspaceId,
        mode,
        instructions,
      }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      label?: string;
      error?: string;
      pending_action?: { run_id: string; tool_use_id: string; tool_name: string; tool_input: Record<string, unknown> };
    };
    if (signal.aborted) return;
    const title = graphData.nodes.find((n) => n.id === nodes[0].id)?.title ?? "this";
    await applyDumpTurn(
      data.label ?? `Steps for “${title}”`,
      {
        reply: res.ok && data.pending_action ? null : (data.error ?? "Couldn't write steps right now — try again."),
        added: [],
        done: [],
        links: [],
        questions: [],
      },
      { pending_action: res.ok ? (data.pending_action ?? null) : null },
      workspaceId,
      false,
    );
  };

  // Quick steps / AI roadmap for one node from the details panel. Fires
  // regardless of node type or whether it already has children — a re-prompt
  // for a finer breakdown is intentional here.
  const handleSuggestStepsForNode = async (
    nodeId: string,
    mode: "light" | "full" = "full",
    instructions?: string,
  ) => {
    if (!selectedWorkspaceId || stepSuggestionLoading) return;
    if (!graphData.nodes.some((n) => n.id === nodeId)) return;

    const abort = new AbortController();
    stepSuggestAbortRef.current = abort;
    setStepSuggestionLoading(true);
    try {
      await requestSteps([{ id: nodeId }], mode, instructions, abort.signal);
    } catch {
      // Aborted or failed — silent (the user cancelled, or the network dropped).
    } finally {
      if (stepSuggestAbortRef.current === abort) stepSuggestAbortRef.current = null;
      setStepSuggestionLoading(false);
    }
  };

  // On-load nudge → open the SELECTIVE picker pre-loaded with the nodes that
  // look ready for a next step (capped so it never feels like a wall).
  const handleMapOutNeedsAction = () => {
    const candidates = needsActionNodes.slice(0, 8);
    if (candidates.length === 0) return;
    snoozeFreezeNudge(7);
    setStepSuggestionNodes(
      candidates.map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        node_type: n.node_type,
        selected: true,
      })),
    );
    setStepSuggestionOpen(true);
  };

  const handleToggleStepNode = (nodeId: string) => {
    setStepSuggestionNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, selected: !n.selected } : n)),
    );
  };

  const handleGenerateSteps = async () => {
    if (!selectedWorkspaceId) return;
    const selectedNodes = stepSuggestionNodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return;
    const abort = new AbortController();
    stepSuggestAbortRef.current = abort;
    setStepSuggestionLoading(true);
    setStepSuggestionOpen(false);

    try {
      // One request: the server writes every item's steps in parallel and
      // puts them on ONE card.
      await requestSteps(selectedNodes, "full", undefined, abort.signal);
    } catch {
      // Step generation failed silently
    } finally {
      if (stepSuggestAbortRef.current === abort) stepSuggestAbortRef.current = null;
      setStepSuggestionLoading(false);
      setStepSuggestionNodes([]);
      // Now run deferred connection analysis (skip if the user cancelled)
      const pending = pendingAnalysisRef.current;
      if (pending && !abort.signal.aborted) {
        pendingAnalysisRef.current = null;
        void analyzeNodes(pending.nodeIds);
      }
    }
  };

  // Cancel an in-flight roadmap/step generation (#5). Aborts the fetch, which
  // also cancels the upstream model call (the route forwards req.signal).
  const cancelStepSuggestion = () => {
    stepSuggestAbortRef.current?.abort();
    setStepSuggestionLoading(false);
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
    setSuggestedAreas([]);
    setLastDumpRawText("");

    if (questionsToAsk.length > 0) {
      openClarifyingQuestionsInChat(questionsToAsk, dumpToAsk);
    }
    sendInlineAnswersToChat();
  };

  const requestCloseProposedNodesReview = () => {
    // Warn before discarding the dump's payoff — only when there are still
    // un-actioned proposed nodes worth losing. A questions-only review
    // closing is cheap, so it skips the confirm.
    if (proposedNodes.length > 0) {
      const count = proposedNodes.length;
      const confirmed = window.confirm(
        `Discard ${count} suggested node${count === 1 ? "" : "s"}? They came from your brain dump and won't be saved.`,
      );
      if (!confirmed) {
        return;
      }
    }

    closeProposedNodesReview();
  };

  // Questions the user already answered inline while the modal was open;
  // these are excluded from the after-close auto-dispatch.
  const [answeredInlineQuestions, setAnsweredInlineQuestions] = useState<Set<string>>(
    () => new Set(),
  );
  // The inline answers themselves, in order — sent to the assistant as one
  // turn when the review closes (sendInlineAnswersToChat).
  const inlineAnswersRef = useRef<Array<{ question: string; answer: string }>>([]);

  useEffect(() => {
    if (proposedReviewOpen) {
      // NOTE: dumpInChatRef is intentionally NOT reset here. Each review-opening
      // path sets it explicitly (true when it already echoed the dump, false
      // when it didn't), so resetting it here would clobber that and let the
      // clarifying flow re-echo the dump (#11).
      setAnsweredInlineQuestions(new Set());
      inlineAnswersRef.current = [];
    }
  }, [proposedReviewOpen]);

  // Opens the right-rail chat with the prior dump + extractor questions as
  // an initial conversation. Crucially does NOT switch app mode — the user
  // stays on whatever view they were on (graph, list, etc.) and the chat
  // appears alongside as a side panel. Called automatically after the
  // proposed-nodes review closes when there are unanswered questions.
  // #18: a brain dump's follow-up conversation should start its OWN chat with
  // zero prior context, not pile onto whatever thread happens to be open. The
  // first time a given dump is injected into chat (dumpInChatRef still false),
  // cut over to a fresh session. The previous conversation is already
  // auto-saved, so it stays available in chat history.
  const startFreshDumpChatIfNeeded = () => {
    if (dumpInChatRef.current) return;
    flushPendingChatSave();
    setChatSessionId(null);
    chatSessionIdRef.current = null;
    setChatScope(createWorkspaceScope(workspaceName));
  };

  const openClarifyingQuestionsInChat = (questions: string[], dumpText: string) => {
    if (questions.length === 0) return;
    startFreshDumpChatIfNeeded();
    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatMessages((prev) => {
      // Never wipe prior messages here — keep the dump echo + summary that
      // applyDumpExtraction already placed. The ref guard below is the sole
      // thing preventing a second echo (#11).
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
    startFreshDumpChatIfNeeded();
    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatMessages((prev) => {
      // Never wipe prior messages here — keep the dump echo + summary that
      // applyDumpExtraction already placed. The ref guard below is the sole
      // thing preventing a second echo (#11).
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
    inlineAnswersRef.current.push({ question, answer });
  };

  // Answers typed inline in the review used to be shown in the chat rail and
  // go nowhere: no model ever read them, so "yeah" to "want me to restructure
  // this?" changed nothing (2026-09-30). When the review closes they go to the
  // assistant as ONE turn — after the accepted nodes are in the graph — and it
  // acts on them with the usual Accept cards. The Q → A bubbles are already in
  // the thread, so the turn itself adds no user bubble.
  const sendInlineAnswersToChat = () => {
    const answers = inlineAnswersRef.current;
    inlineAnswersRef.current = [];
    if (answers.length === 0) return;
    const lines = answers.map(({ question, answer }) => `- "${question}" → ${answer}`);
    void submitMessage(
      `My answers to your questions about my last brain dump — act on them now:\n${lines.join("\n")}`,
      false,
    );
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

  // threadMessageId: the chat message whose turn added these nodes — the links
  // go into that thread as a card instead of a modal (docs/unified-turn.md).
  const applyAnalysisResult = (result: AnalysisResponse, threadMessageId?: string) => {
    if (result.merge_candidates && result.merge_candidates.length > 0) {
      setMergeCandidates(result.merge_candidates);
    }
    const edges = result.proposed_edges ?? [];
    const inThread =
      !!threadMessageId && chatMessagesRef.current.some((m) => m.id === threadMessageId);
    if (edges.length > 0 && inThread) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-links-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: "",
          createdAt: new Date().toISOString(),
          status: "ready" as const,
          connections: {
            status: "awaiting" as const,
            edges: edges.map((edge) => ({
              id: edge.id,
              sourceTitle: edge.source_title,
              targetTitle: edge.target_title,
              edgeType: edge.edge_type,
              explanation: edge.explanation || null,
            })),
          },
        },
      ]);
    } else if (edges.length > 0) {
      setProposedEdges(edges);
      setEdgeReviewOpen(true);
    }

    // Track which nodes specifically failed so retry can target only those
    // instead of replaying the whole batch.
    setLastAnalysisFailedNodeIds(
      Array.isArray(result.failed_node_ids) ? result.failed_node_ids : [],
    );

    setAiNotice(buildAnalysisNotice(result));
  };

  const analyzeNodes = async (nodeIds: string[], workspaceIdOverride?: string, threadMessageId?: string) => {
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
      await handleEdgeReview(
        card.edges.map((edge) => ({ id: edge.id, action: kept.has(edge.id) ? ("accept" as const) : ("reject" as const) })),
      );
      setCard(acceptedIds ? { status: "added", acceptedIds: [...kept] } : { status: "dismissed" });
    } catch {
      setCard({ status: "error" });
    }
  };

  const handleStatusChange = async (nodeId: string, status: Node["status"]) => {
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

    // Client mirror of the server's belongs_to cascade so the whole subtree
    // completes/uncompletes on the SAME click instead of waiting for the
    // round-trip (which also recomputes scores, so it can lag a beat). Anything
    // the server doesn't confirm is rolled back when the response lands.
    const collectBelongsToDescendants = (predicate: (n: Node) => boolean): string[] => {
      const childrenByParent = new Map<string, string[]>();
      for (const edge of graphData.edges) {
        if (edge.edge_type !== "belongs_to") continue;
        if (edge.status === "orphaned" || edge.status === "user_rejected") continue;
        const arr = childrenByParent.get(edge.target_node_id) ?? [];
        arr.push(edge.source_node_id);
        childrenByParent.set(edge.target_node_id, arr);
      }
      const nodeById = new Map(graphData.nodes.map((n) => [n.id, n]));
      const out: string[] = [];
      const visited = new Set<string>();
      const stack = [...(childrenByParent.get(nodeId) ?? [])];
      while (stack.length > 0) {
        const id = stack.pop();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const node = nodeById.get(id);
        if (node && predicate(node)) out.push(id);
        for (const childId of childrenByParent.get(id) ?? []) {
          if (!visited.has(childId)) stack.push(childId);
        }
      }
      return out;
    };
    const cascadeStatus: Node["status"] | null =
      status === "completed"
        ? "completed"
        : status === "active" && previousNode.status === "completed"
          ? "active"
          : null;
    const cascadeIds =
      cascadeStatus === "completed"
        ? collectBelongsToDescendants((n) => n.status !== "completed" && n.status !== "archived")
        : cascadeStatus === "active"
          ? collectBelongsToDescendants((n) => n.status === "completed")
          : [];
    const cascadeIdSet = new Set(cascadeIds);
    const affectedSnapshot = new Map(
      graphData.nodes
        .filter((n) => n.id === nodeId || cascadeIdSet.has(n.id))
        .map((n) => [n.id, { status: n.status ?? null, completed_at: n.completed_at ?? null }] as const),
    );

    // Edges only change on archive / unarchive, by the server's own rules
    // (archive-edges.ts). Snapshot them so a failed request can put them back.
    const touchingEdges = graphData.edges.filter(
      (e) => e.source_node_id === nodeId || e.target_node_id === nodeId,
    );
    const edgeStatusChanges = new Map<string, Edge["status"]>();
    if (status === "archived") {
      for (const e of touchingEdges) if (isLiveEdge(e)) edgeStatusChanges.set(e.id, "orphaned");
    } else if (previousNode.status === "archived") {
      const restoreIds = pickEdgesToRestore({
        nodeId,
        edges: touchingEdges,
        statusByNodeId: new Map(graphData.nodes.map((n) => [n.id, n.status])),
        parentedNodeIds: new Set(
          graphData.edges
            .filter((e) => e.edge_type === "belongs_to" && isLiveEdge(e))
            .map((e) => e.source_node_id),
        ),
      });
      for (const id of restoreIds) edgeStatusChanges.set(id, "active");
    }
    const edgeStatusSnapshot = new Map(
      touchingEdges.filter((e) => edgeStatusChanges.has(e.id)).map((e) => [e.id, e.status ?? null]),
    );

    // Apply optimistic update immediately so the UI responds on first click.
    function applyStatusLocally(
      prev: GraphData,
      targetStatus: Node["status"],
      edgeStatuses: ReadonlyMap<string, Edge["status"]>,
    ): GraphData {
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
          edgeStatuses.size === 0
            ? prev.edges
            : prev.edges.map((e) =>
                edgeStatuses.has(e.id) ? { ...e, status: edgeStatuses.get(e.id) } : e,
              ),
      };
    }

    setGraphData((prev) => {
      const base = applyStatusLocally(prev, status, edgeStatusChanges);
      if (!cascadeStatus || cascadeIds.length === 0) return base;
      const cascadeCompletedAt = cascadeStatus === "completed" ? new Date().toISOString() : null;
      return {
        ...base,
        nodes: base.nodes.map((n) =>
          cascadeIdSet.has(n.id)
            ? { ...n, status: cascadeStatus, completed_at: cascadeCompletedAt }
            : n,
        ),
      };
    });

    const res = await fetch(`/api/nodes/${nodeId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      // Revert clicked node + edges, and restore every cascaded descendant.
      setGraphData((prev) => {
        const reverted = applyStatusLocally(prev, previousNode.status, edgeStatusSnapshot);
        if (affectedSnapshot.size === 0) return reverted;
        return {
          ...reverted,
          nodes: reverted.nodes.map((n) => {
            const snap = affectedSnapshot.get(n.id);
            return snap ? { ...n, status: snap.status, completed_at: snap.completed_at } : n;
          }),
        };
      });
      return;
    }

    const data = await res.json() as {
      updated_node?: Node | null;
      updated_nodes?: Node[];
      auto_completed_node_ids?: string[];
      auto_reopened_node_ids?: string[];
      recomputed_scores?: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }>;
      updated_task_ids?: string[];
    };
    const updatedNode = data.updated_node ?? null;
    const updatedNodeMap = new Map(
      (data.updated_nodes ?? []).map((updated) => [updated.id, updated]),
    );
    // Cascaded belongs_to descendants: completing a parent auto-completes its
    // whole subtree server-side. Apply their status explicitly so the children
    // vanish (hideCompleted) in the same frame — previously they lingered until
    // a manual reset layout because the update didn't always land client-side.
    const autoCompletedIds = new Set(data.auto_completed_node_ids ?? []);
    const autoReopenedIds = new Set(data.auto_reopened_node_ids ?? []);
    const nowIso = new Date().toISOString();

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
        const serverCascadeStatus: Node["status"] | null = autoCompletedIds.has(n.id)
          ? "completed"
          : autoReopenedIds.has(n.id)
            ? "active"
            : null;
        // We optimistically cascaded this node but the server didn't confirm it
        // (e.g. a child completed independently of this parent) — roll it back.
        const rollback =
          cascadeIdSet.has(n.id) &&
          !serverCascadeStatus &&
          !updatedNodeMap.has(n.id) &&
          n.id !== nodeId
            ? affectedSnapshot.get(n.id)
            : undefined;

        if (!nextNodeState && !scoreUpdate && !serverCascadeStatus && !rollback) {
          return n;
        }

        return {
          ...n,
          ...(nextNodeState ?? {}),
          ...(serverCascadeStatus && !nextNodeState
            ? {
                status: serverCascadeStatus,
                completed_at: serverCascadeStatus === "completed" ? nowIso : null,
              }
            : {}),
          ...(rollback ? { status: rollback.status, completed_at: rollback.completed_at } : {}),
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
    <div
      className="app-shell flex min-h-screen flex-col overflow-hidden bg-(--color-bg-base) text-(--color-text-primary)"
      data-app-mode={appMode}
      data-system-panel-open={systemPanelOpen ? "true" : undefined}
    >
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
          workspaceId={selectedWorkspaceId}
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
                historyGraphData={graphData}
                workProgressByNode={workProgressByNode}
                pulseNodeIds={priorityPulseIds}
                graphLoading={graphLoading}
                graphSearchValue={graphSearchValue}
                graphTypeFilter={nodeTypeFilter}
                graphTypeCounts={nodeTypeCounts}
                graphTypeTotalCount={nodeTypeTotalCount}
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
                onGraphSearchChange={setGraphSearchValue}
                onGraphSearchSubmit={handleGraphSearchSubmit}
                onChangeGraphTypeFilter={setNodeTypeFilter}
                onOpenCreateNode={handleOpenCreateNode}
                onResetEditManualWeight={handleResetManualWeight}
                onResetGraphFilters={handleResetFilters}
                hideCompleted={hideCompleted}
                completedNodes={completedNodes}
                onSelectCompletedNode={(nodeId) => {
                  setHideCompleted(false);
                  handleSelectNode(nodeId);
                }}
                onSelectArchivedNode={handleSelectNode}
                onRestoreArchivedNode={(nodeId) => {
                  void handleStatusChange(nodeId, "active");
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
                draftPlanRefreshKey={draftPlanRefreshKey}
                draftPlanHint={draftPlanHint}
                onAskInChat={(message) => {
                  void submitMessage(message);
                }}
                onLinkedNodeStatusChange={(nodeId, nextStatus) => {
                  // Mirror the planner toggle in the local graphData so the
                  // graph view shows the matching status without a refetch.
                  setGraphData((prev) => {
                    const target = prev.nodes.find((n) => n.id === nodeId);
                    // Habits recur — checking off a habit's planner task logs
                    // TODAY's completion server-side (the /status route's habit
                    // guard) but must NOT complete the node, or it vanishes from
                    // the graph (#13). Leave its status untouched.
                    if (target?.node_type === "habit") return prev;
                    return {
                      ...prev,
                      nodes: prev.nodes.map((n) =>
                        n.id === nodeId ? { ...n, status: nextStatus } : n,
                      ),
                    };
                  });
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
              <SectionBackdrop kind="todos" />
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
              <SectionBackdrop kind="habits" />
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
              <SectionBackdrop kind="roadmap" />
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
              <SectionBackdrop kind="pomodoro" />
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
          onResolvePendingAction={(messageId, decision, choice, acceptedIndexes) => {
            void resolvePendingAction(messageId, decision, choice, acceptedIndexes);
          }}
          onCancelChat={cancelChat}
          onUndoAppliedAction={(messageId, slot) => {
            void undoAppliedAction(messageId, slot);
          }}
          onUndoTurnSection={(messageId, section) => {
            void undoTurnSection(messageId, section);
          }}
          onUndoAcceptedCard={(messageId) => {
            void undoAcceptedCard(messageId);
          }}
          onAnswerTurnQuestion={answerTurnQuestion}
          onResolveConnections={(messageId, acceptedIds) => {
            void resolveConnections(messageId, acceptedIds);
          }}
          pendingActionBusy={pendingActionBusy}
          dumpProgress={dumpProgress}
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
          onSuggestSteps={(nodeId, mode, instructions) => {
            void handleSuggestStepsForNode(nodeId, mode, instructions);
          }}
          suggestStepsBusy={stepSuggestionLoading}
          onSelectLinkedNode={handleSelectNode}
          onSubmitChatInput={(message) => {
            const trimmed = message.trim();
            if (!trimmed) return;
            // A message that reads like a brain dump is ONE turn in this
            // thread — reply + card, the same as the Brain Dump box
            // (docs/unified-turn.md); there is no "dump or chat?" chooser any
            // more. The cheap regex gates; Haiku confirms (~$0.0004) so a
            // multi-clause question doesn't pay for a graph-builder call.
            if (!chatLoading && looksLikeBrainDump(trimmed)) {
              setRailChatInput("");
              void (async () => {
                let isDump = true; // fail-safe: a dump turn also answers questions
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
                  // Network error: keep the fail-safe.
                }
                if (isDump) void submitDumpFromChat(trimmed);
                else void submitMessage(trimmed);
              })();
              return;
            }
            void submitMessage(message);
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
              suggestedAreas={suggestedAreas}
              onAddAreas={handleAddAreas}
              onAccept={handleProposalReview}
              onClose={requestCloseProposedNodesReview}
              submitting={proposedNodesSubmitting}
              clarifyingQuestions={clarifyingQuestions}
              onAnswerInline={handleClarifyingAnswerInline}
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
                <p className="step-suggest-title">Break these into steps?</p>
                <p className="step-suggest-desc">
                  Pick which to map out — skip any you&rsquo;re not ready for.
                </p>
                <div className="step-suggest-checklist">
                  {stepSuggestionNodes.map((n) => (
                    <label className="step-suggest-check" key={n.id}>
                      <input
                        type="checkbox"
                        checked={n.selected}
                        onChange={() => handleToggleStepNode(n.id)}
                      />
                      <span>{n.title}</span>
                    </label>
                  ))}
                </div>
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
                  disabled={stepSuggestionNodes.every((n) => !n.selected)}
                  type="button"
                >
                  {(() => {
                    const c = stepSuggestionNodes.filter((n) => n.selected).length;
                    return c === stepSuggestionNodes.length || c === 0
                      ? "Generate steps"
                      : `Generate steps (${c})`;
                  })()}
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
        {autoApplyUndo ? (
          <AutoApplyNotice
            key="auto-apply"
            count={autoApplyUndo.count}
            onUndo={() => void handleUndoAutoApply()}
            onDismiss={dismissAutoApplyNotice}
          />
        ) : null}
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
              <button
                type="button"
                className="ai-status-cancel"
                onClick={cancelStepSuggestion}
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI status chip — shown during extraction and connection analysis.
          Not over the open Brain Dump box: it shows its own progress. */}
      <AnimatePresence>
        {!brainDumpOpen && (brainDumpSubmitting || analyzingConnections) && (
          <motion.div
            key="ai-status"
            className="ai-status-chip"
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <span className="ai-status-spinner" aria-hidden="true" />
            <span className="ai-status-text">
              {brainDumpSubmitting
                ? "Reading your dump & building your graph…"
                : "Finding connections…"}
            </span>
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

      {/* Auto-grouping: surface pending cluster suggestions for Accept/Dismiss */}
      {appMode === "graph" && (
        <ClusterSuggestionStack
          workspaceId={selectedWorkspaceId}
          refreshKey={clusterRefreshKey}
          onAccepted={() => {
            void loadWorkspaceGraphData(
              authUser?.id ?? null,
              selectedWorkspaceId,
              selectedWorkspace?.name ?? null,
            ).then(setGraphData);
          }}
        />
      )}

      {/* On-load anti-freeze nudge — proactively surface nodes ready for a
          next step, opening the SELECTIVE picker so it's never a wall. */}
      {appMode === "graph" &&
      freezeNudgeAllowed &&
      !freezeNudgeDismissed &&
      !stepSuggestionOpen &&
      !whatNowOpen &&
      !brainDumpOpen &&
      needsActionNodes.length > 0 ? (
        <div className="freeze-nudge" role="status">
          <span className="freeze-nudge-text">
            {needsActionNodes.length === 1
              ? "1 item looks ready for a next step."
              : `${needsActionNodes.length} items look ready for a next step.`}
          </span>
          <div className="freeze-nudge-actions">
            <button className="freeze-nudge-btn" type="button" onClick={handleMapOutNeedsAction}>
              Pick what to map out
            </button>
            <button
              className="freeze-nudge-dismiss"
              type="button"
              onClick={() => {
                setFreezeNudgeDismissed(true);
                snoozeFreezeNudge(14);
              }}
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}

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
            className="brain-dump-anchor fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
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
              progress={dumpProgress}
              value={brainDumpValue}
            />
          </motion.div>
        ) : (
          <motion.div
            key="dock"
            className="mode-dock-anchor fixed bottom-6 left-1/2 z-40 -translate-x-1/2"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <ModeDock
              mode={appMode}
              onSetMode={(mode) => {
                setAppMode(mode);
                // Phone: the panel is a sheet over the whole view — a tap on
                // the tab bar means "show me that view", so it steps aside.
                if (window.matchMedia("(max-width: 640px)").matches) {
                  setRightPanelOpen(false);
                }
              }}
              onOpenBrainDump={() => {
                setBrainDumpError(null);
                setBrainDumpFailedEntryId(null);
                setBrainDumpWorkspaceId(selectedWorkspaceId);
                setBrainDumpOpen(true);
              }}
              onOpenWhatNow={() => setWhatNowOpen((open) => !open)}
              onOpenWeeklyReflection={() => setWeeklyReflectionOpen(true)}
              onOpenHistory={() => setDumpHistoryOpen(true)}
              weeklyReflectionLocked={!isWeeklyReflectionAvailable()}
              focusGlow={appMode === "graph" && graphData.nodes.some((n) => n.status === "active")}
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
        {dumpHistoryOpen && selectedWorkspaceId ? (
          <DumpHistoryModal
            key="dump-history"
            workspaceId={selectedWorkspaceId}
            onClose={() => setDumpHistoryOpen(false)}
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
              graphSignature={graphContentSignature}
              onClose={() => setWhatNowOpen(false)}
              onFocusNode={(nodeId) => {
                setAppMode("graph");
                setWhatNowOpen(false);
                handleSelectNode(nodeId);
                // "Pick something to work on" is the focus intent — set up the
                // timer (paused) on the chosen node. We do NOT auto-break the
                // node into subtasks anymore (testing journal #4): pressing
                // Focus should never silently fire an AI breakdown. If the node
                // needs steps, the user breaks it down from the details panel
                // (which handleSelectNode just opened).
                void handleStartFocus(nodeId);
              }}
              onScheduledToPlanner={() => {
                setWhatNowOpen(false);
                setAppMode("assistant");
              }}
              onCheckBack={handleCheckBack}
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

      {/* User-level "about you" intake — the first-run sign-up moment. Shown
          once, before any workspace onboarding, and gated on profileIntakeState. */}
      {profileIntakeState === "open" && authUser && (
        <AboutYouIntake onDone={() => setProfileIntakeState("done")} />
      )}

      {/* Workspace bootstrap wizard — only shown for an in-progress creation flow */}
      {bootstrapWorkspaceId && bootstrapWorkspaceId === selectedWorkspaceId && (
        <WorkspaceBootstrapWizard
          workspaceId={selectedWorkspaceId}
          workspaceName={workspaceName}
          isOnboarding={!workspaceCreationFlowRef.current}
          onComplete={(handoff) => {
            if (workspaceCreationFlowRef.current?.workspaceId === selectedWorkspaceId) {
              workspaceCreationFlowRef.current = null;
            }
            setBootstrapWorkspaceId(null);

            // Mirror the first (bootstrap) dump into the chat thread, exactly
            // like every later brain dump does — so the user's most important
            // dump isn't the one missing from their history.
            // The user submitted a dump but extraction failed/was disabled and
            // produced nothing — surface it instead of silently dropping it.
            const extractionFailed = Boolean(handoff?.extraction_error);
            const bootstrapDumpText = handoff?.raw_text?.trim() ?? "";
            if (bootstrapDumpText) {
              const nodeCount = handoff?.proposed_nodes?.length ?? 0;
              const questionCount = handoff?.clarifying_questions?.length ?? 0;
              const bootstrapSummary = extractionFailed
                ? "I couldn't process that dump right now — your notes are saved. Try a Brain Dump again in a moment."
                : [
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
              // Onboarding dump is now echoed once — the clarifying flow must
              // not echo it again (#11).
              dumpInChatRef.current = true;
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
              // The wizard already created the user's life-areas, so don't
              // re-offer area branches in the first-dump review.
              setSuggestedAreas([]);
              setLastDumpRawText(handoff!.raw_text);
              setProposalsFromBootstrap(true);
              setProposedReviewOpen(true);
            } else if (extractionFailed) {
              showToast(
                "Couldn't process that dump right now — your notes are saved, try a Brain Dump again.",
              );
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
              // Run the tour after EVERY new-workspace wizard (not just first
              // onboarding), unless a review modal is already grabbing focus.
              if (!hasHandoff) {
                setShowTour(true);
              }
            });
          }}
          onSkip={() => {
            // "Skip for now" (onboarding): dismiss for this session without
            // writing bootstrap_completed_at, so the wizard can re-offer
            // itself on a later still-empty load. The session ref stops it
            // from immediately re-opening this same session.
            if (!workspaceCreationFlowRef.current) {
              if (selectedWorkspaceId) {
                bootstrapSkippedThisSessionRef.current.add(selectedWorkspaceId);
              }
              setBootstrapWorkspaceId(null);
              // Skipping setup must NOT dead-end onboarding — the user still
              // gets the guided tour of the UI (previously the tour only ran
              // after completing the wizard, so a skip left them staring at an
              // empty graph with no walkthrough).
              setShowTour(true);
              return;
            }
            // Non-onboarding ("created a workspace by mistake") still discards.
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
