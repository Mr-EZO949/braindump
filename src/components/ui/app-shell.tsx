"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { MainStage } from "@/components/graph/main-stage";
import { useSession, type AuthUserState } from "@/components/app-shell/use-session";
import { usePlannerSync, useShellDialogs, useShellPanels, useShellToast } from "@/components/app-shell/use-shell-ui";
import { useGraphView } from "@/components/app-shell/use-graph-view";
import { useWorkspaceGraph } from "@/components/app-shell/use-workspace-graph";
import { useChatNudges, useChatThread } from "@/components/app-shell/use-chat-thread";
import { useConnectionAnalysis } from "@/components/app-shell/use-connection-analysis";
import { useChatActions } from "@/components/app-shell/use-chat-actions";
import { useTurnCards } from "@/components/app-shell/use-turn-cards";
import { AssistantMode as AssistantModeView } from "@/components/assistant/assistant-mode";
import { TodosView } from "@/components/ui/todos-view";
import { HabitsView } from "@/components/ui/habits-view";
import { RoadmapView } from "@/components/ui/roadmap-view";
import { PomodoroView } from "@/components/ui/pomodoro-view";
import { SectionBackdrop } from "@/components/ui/section-backdrop";
import { ModeDock } from "@/components/ui/mode-dock";
import { BrainDumpOverlay } from "@/components/ui/brain-dump-overlay";
import { clearFocusCache, WhatNowDialog } from "@/components/ui/what-now-dialog";
import { WeeklyReflectionModal } from "@/components/ui/weekly-reflection-modal";
import { DumpHistoryModal } from "@/components/ui/dump-history-modal";
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
import {
  createUserChatMessage,
  createWorkspaceScope,
} from "@/lib/graph/chat";
import {
  findFirstMatchingNode,
  loadWorkspaceGraphData,
  persistLocalNodePosition,
  removeLocalNodePosition,
} from "@/lib/graph/data";

import {
  findChildlessProjects,
  looksLikeBrainDump,
} from "@/lib/graph/dump-heuristic";
import {
  buildEdgePayloadFromSelection,
  visibleEdgeRelationOptions,
  type EdgeRelationOptionId,
} from "@/lib/graph/relationships";
import { setNodeParent } from "@/lib/graph/hierarchy";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import {
  appliedActionFromPayload,
  type AppliedMarkerPayload,
} from "@/lib/chat/applied-marker";
import { dumpHistoryForEntries } from "@/lib/chat/thread-history";
import { bootstrapSummaryText, dumpSummaryText, roadmapOfferText } from "@/lib/chat/dump-summary";
import { readDumpResponse } from "@/lib/chat/dump-stream";
import type { DumpProgressState } from "@/components/ui/dump-progress";
import { classifyTaskSize } from "@/lib/ai/sizing";
import {
  parentContextTitle,
} from "@/lib/graph/visible-graph";
import {
  checkNodeDraft,
  createDraftFromNode,
  defaultCreateNodeDraft,
  editedNodeFields,
  newNodeRow,
} from "@/lib/graph/node-draft";
import {
  placeAcceptedNodes,
  stepCandidates,
  withoutNodes,
} from "@/lib/graph/graph-patches";
import {
  applyOptimisticStatus,
  mergeServerStatus,
  planStatusChange,
  revertOptimisticStatus,
  type StatusResponse,
} from "@/lib/graph/status-optimistic";
import { isWeeklyReflectionAvailable } from "@/lib/time/weekly-unlock";
import type { CreateNodeInput, Edge, GraphData, Node, Workspace } from "@/types/graph";
import { addDaysISO, localDateISO } from "@/lib/time/local-date";
import { todayIsoDate } from "@/lib/planner/auto-schedule";
import { clientDayHints } from "@/lib/habits/streak";
import { acceptProposalsNow, undoAutoApplied } from "@/lib/graph/auto-apply-client";
import { AutoApplyNotice } from "@/components/ui/auto-apply-notice";
import type { DumpTurn, ProposedNode } from "@/types/ai";

type AppShellProps = {
  initialUser: AuthUserState;
};

// How far "Still waiting" on a Focus check-back pushes the next check (ranking v2).
const CHECK_BACK_SNOOZE_DAYS = 7;

export function AppShell({ initialUser }: AppShellProps) {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const panels = useShellPanels();
  const {
    appMode,
    setAppMode,
    rightPanelOpen,
    setRightPanelOpen,
    systemPanelOpen,
    setSystemPanelOpen,
    workspaceMenuOpen,
    setWorkspaceMenuOpen,
    activeRailTab,
    setActiveRailTab,
  } = panels;
  const { whatNowOpen, setWhatNowOpen, weeklyReflectionOpen, setWeeklyReflectionOpen, dumpHistoryOpen, setDumpHistoryOpen } =
    useShellDialogs();
  const { toast, showToast } = useShellToast();
  const planner = usePlannerSync();
  const { plannerRefreshKey, draftPlanRefreshKey, draftPlanHint } = planner;
  const session = useSession({ initialUser, supabase, router, closeSystemPanel: () => setSystemPanelOpen(false) });
  const {
    authUser,
    workspaces,
    setWorkspaces,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedWorkspace,
    workspaceName,
    signingOut,
    deletingAccount,
  } = session;
  const graph = useWorkspaceGraph({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    workspaceRecordName: selectedWorkspace?.name ?? null,
  });
  const {
    graphData,
    setGraphData,
    graphLoading,
    nodeTypeCounts,
    nodeTypeTotalCount,
    graphContentSignature,
    needsActionNodes,
    workProgressByNode,
    existingNodeTitleMap,
    priorityPulseIds,
    refreshAfterPriorityChange,
    clusterRefreshKey,
  } = graph;
  const view = useGraphView({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    graph,
    setRightPanelOpen,
  });
  const {
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
  } = view;
  const thread = useChatThread({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    workspaceName,
    selectedNode,
    graphData,
    panels,
  });
  const {
    chatMessages,
    setChatMessages,
    chatScope,
    setChatScope,
    chatLoading,
    setChatLoading,
    pendingActionBusy,
    railChatInput,
    setRailChatInput,
    chatSendingRef,
    dumpInChatRef,
    chatSessionId,
    chatSessions,
    chatHistoryOpen,
    setChatHistoryOpen,
  } = thread;
  const nudges = useChatNudges(selectedWorkspaceId);
  const connections = useConnectionAnalysis({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    graph,
    thread,
  });
  const {
    analyzeNodes,
    analyzingConnections,
    aiNotice,
    lastAnalysisNodeIds,
    lastAnalysisWorkspaceId,
    mergeCandidates,
    edgeReviewOpen,
    proposedEdges,
    findAllConfirmOpen,
  } = connections;
  const chat = useChatActions({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    thread,
    graph,
    analyzeNodes,
    panels,
    planner,
  });
  const { submitMessage, cancelChat, resolvePendingAction, retryLastMessage } = chat;
  const turns = useTurnCards({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    thread,
    graph,
    analyzeNodes,
    submitMessage,
    panels,
  });
  const { undoAppliedAction, undoTurnSection, undoAcceptedCard, answerTurnQuestion } = turns;

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

  const [editMode, setEditMode] = useState(false);
  // Focus timer — one persistent Pomodoro per workspace, backed by localStorage
  // so it survives mode/view switches and reloads. Lives at the shell so the
  // pill renders above every view.
  const focusTimer = useFocusTimer(selectedWorkspaceId);
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

  // A newly loaded workspace may show the anti-freeze nudge again.
  useEffect(() => {
    setFreezeNudgeDismissed(false);
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
    // Workspace-switch reset: no sheet, draft, edit mode or connection form
    // carries over (the thread resets in useChatThread).
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
  }, [selectedWorkspaceId]);

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
    // The setters come from the shell's hooks (stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredGraphData.nodes, selectedNodeId]);

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
      planner.refreshPlanner();
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

  const handleSubmitCreateNode = async () => {
    if (!supabase || !authUser?.id || !selectedWorkspaceId || !createNodeDraft) {
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
      .insert(newNodeRow(createNodeDraft, checked, { userId: authUser.id, workspaceId: selectedWorkspaceId }))
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
    if (checked.nodeType === "task") {
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
      await turns.postTurn(rawText, data.turn, data, workspaceId, opts?.continueThread ?? false);
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
      dumpSummaryText({
        appliedCount,
        reviewCount,
        completedTitles,
        questionCount: questions.length,
        priorityChanged: Boolean(priorityAction),
        otherChange: Boolean(commitmentAction || restructure),
        unclear,
      });

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
    thread.startFreshThread();
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
        graph.refreshClusters();
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
    setGraphData((prev) => withoutNodes(prev, removedIds));
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
    const history = dumpHistoryForEntries(chatMessages);
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
    // Cluster new nodes near the viewport center instead of scattering them.
    const { positioned, stored } = placeAcceptedNodes(nodes, acceptedEdges, cameraView);
    if (authUser?.id && selectedWorkspaceId) {
      for (const { nodeId, position } of stored) {
        if (position) persistLocalNodePosition(authUser.id, selectedWorkspaceId, nodeId, position);
        else removeLocalNodePosition(authUser.id, selectedWorkspaceId, nodeId);
      }
    }

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
      const body = roadmapOfferText(childless);
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
    graph.refreshClusters();
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
      const goalOrProjectNodes = stepCandidates(
        acceptedNodes,
        graphData.edges,
        (data.accepted_edges as Edge[]) ?? [],
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
    await turns.postTurn(
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
    thread.startFreshThread();
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
            void session.signOut();
          }}
          onDeleteAccount={() => {
            void session.deleteAccount();
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
                onResetGraphFilters={view.resetFilters}
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
                onFindAllConnections={connections.requestFindAll}
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
                  planner.refreshPlanner();
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
          onClearChatScope={thread.clearChatScope}
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
            void connections.resolveConnections(messageId, acceptedIds);
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
          onStartNewChat={thread.startNewChat}
          onSelectChatSession={(id) => {
            void thread.openChatSession(id);
          }}
          onDeleteChatSession={(id) => {
            void thread.removeChatSession(id);
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
            onClick={connections.closeFindAllConfirm}
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
                  onClick={connections.closeFindAllConfirm}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="per-btn-primary"
                  onClick={connections.confirmFindAll}
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
                  onClick={connections.retryLastConnectionAnalysis}
                  type="button"
                >
                  Find connections
                </button>
              ) : null}
              <button
                className="ai-notice-dismiss"
                onClick={connections.dismissAiNotice}
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
          onKeepBoth={connections.keepBoth}
          onNever={connections.neverMerge}
          onMerge={connections.mergeNodes}
        />
      )}

      {/* Proposed edges review — centered modal */}
      {edgeReviewOpen && proposedEdges.length > 0 && (
        <ProposedEdgesReview
          edges={proposedEdges}
          onConfirm={(actions) => connections.reviewEdges(actions)}
          onDismiss={connections.requestCloseEdgeReview}
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
              contextFor={(nodeId) =>
                // The step's parent, unless that's the workspace root ("in
                // Life" says nothing).
                parentContextTitle(graphData, nodeId, selectedWorkspace?.bootstrap_root_node_id)
              }
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
              onGraphChanged={() => void graph.reloadGraph()}
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
              const bootstrapSummary = bootstrapSummaryText({
                extractionFailed,
                nodeCount: handoff?.proposed_nodes?.length ?? 0,
                questionCount: handoff?.clarifying_questions?.length ?? 0,
              });
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
