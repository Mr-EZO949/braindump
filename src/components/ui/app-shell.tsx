"use client";

// The app's orchestration layer (AGENTS.md "Shell / State Orchestration"):
// state that spans the graph, the rail, the sheets and the dialogs is wired
// together here. Each concern lives in its own hook or component under
// src/components/app-shell/; this file composes them.

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { useBrainDump } from "@/components/app-shell/use-brain-dump";
import { useChatActions } from "@/components/app-shell/use-chat-actions";
import { useChatNudges, useChatThread } from "@/components/app-shell/use-chat-thread";
import { useConnectionAnalysis } from "@/components/app-shell/use-connection-analysis";
import { useFocusSession } from "@/components/app-shell/use-focus-session";
import { useFreezeNudge } from "@/components/app-shell/use-freeze-nudge";
import { useGraphView } from "@/components/app-shell/use-graph-view";
import { useNodeEditor } from "@/components/app-shell/use-node-editor";
import { useNodeStatus } from "@/components/app-shell/use-node-status";
import { useOnboarding } from "@/components/app-shell/use-onboarding";
import { useProposalReview } from "@/components/app-shell/use-proposal-review";
import { useSession, type AuthUserState } from "@/components/app-shell/use-session";
import { useShellDialogs, useShellPanels, usePlannerSync, useShellToast } from "@/components/app-shell/use-shell-ui";
import { useStepSuggestions } from "@/components/app-shell/use-step-suggestions";
import { useTurnCards } from "@/components/app-shell/use-turn-cards";
import { useWorkspaceGraph } from "@/components/app-shell/use-workspace-graph";
import { ShellDialogs } from "@/components/app-shell/shell-dialogs";
import { DumpBoxOrDock } from "@/components/app-shell/shell-dock";
import { ShellGraphStage } from "@/components/app-shell/shell-graph-stage";
import { ShellOnboarding } from "@/components/app-shell/shell-onboarding";
import {
  AiNoticeBar,
  AiStatusChip,
  FindAllConfirmModal,
  FreezeNudgeBar,
  ProposalReviewModal,
  StepSuggestModal,
  WorkChips,
} from "@/components/app-shell/shell-overlays";
import { ShellRail } from "@/components/app-shell/shell-rail";
import { ShellViews } from "@/components/app-shell/shell-views";
import { ClusterSuggestionStack } from "@/components/clustering/cluster-suggestion-stack";
import { NudgeRibbon } from "@/components/nudges/nudge-ribbon";
import { SystemPanel } from "@/components/panel/system-panel";
import { FocusTimerPill } from "@/components/ui/focus-timer-pill";
import { isWeeklyReflectionAvailable } from "@/lib/time/weekly-unlock";
import { MergeAlert } from "@/components/ui/merge-alert";
import { ProposedEdgesReview } from "@/components/ui/proposed-edges-review";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import { parentContextTitle } from "@/lib/graph/visible-graph";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type AppShellProps = {
  initialUser: AuthUserState;
};

export function AppShell({ initialUser }: AppShellProps) {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  // The shell's own UI: view, rail, panels, dialogs, toast, planner keys.
  const panels = useShellPanels();
  const dialogs = useShellDialogs();
  const { toast, showToast } = useShellToast();
  const planner = usePlannerSync();

  // Who, which workspace, its graph, and how it is being looked at.
  const session = useSession({ initialUser, supabase, router, closeSystemPanel: () => panels.setSystemPanelOpen(false) });
  const { userId, selectedWorkspaceId: workspaceId, selectedWorkspace, workspaceName } = session;
  const graph = useWorkspaceGraph({ userId, workspaceId, workspaceRecordName: selectedWorkspace?.name ?? null });
  const view = useGraphView({ userId, workspaceId, graph, setRightPanelOpen: panels.setRightPanelOpen });

  // Chat: the thread, the links engine that posts into it, sending, cards.
  const thread = useChatThread({
    userId,
    workspaceId,
    workspaceName,
    selectedNode: view.selectedNode,
    graphData: graph.graphData,
    panels,
  });
  const nudges = useChatNudges(workspaceId);
  const connections = useConnectionAnalysis({ userId, workspaceId, graph, thread });
  const { analyzeNodes } = connections;
  const chat = useChatActions({ userId, workspaceId, thread, graph, analyzeNodes, panels, planner });
  const turns = useTurnCards({
    userId,
    workspaceId,
    thread,
    graph,
    analyzeNodes,
    submitMessage: chat.submitMessage,
    panels,
    planner,
  });

  // Brain dumps and what they hand on: steps, the proposals review.
  const steps = useStepSuggestions({ workspaceId, graph, postTurn: turns.postTurn, analyzeNodes, panels });
  const proposals = useProposalReview({
    userId,
    workspaceId,
    graph,
    view,
    thread,
    submitMessage: chat.submitMessage,
    analyzeNodes,
    steps,
    panels,
  });
  const dump = useBrainDump({
    workspaceId,
    thread,
    graph,
    postTurn: turns.postTurn,
    proposals,
    analyzeNodes,
    submitMessage: chat.submitMessage,
    panels,
    showToast,
  });

  // Working on the graph by hand, finishing things, focusing, first run.
  const editor = useNodeEditor({
    supabase,
    userId,
    workspaceId,
    selectedWorkspace,
    workspaceName,
    graph,
    view,
    panels,
    setChatScope: thread.setChatScope,
    steps,
    showToast,
  });
  const { changeStatus, mirrorPlannerStatus } = useNodeStatus({ graph, planner, showToast });
  const focus = useFocusSession({ supabase, userId, workspaceId, graph, planner, showToast });
  const freeze = useFreezeNudge({
    userId,
    workspaceId,
    appMode: panels.appMode,
    needsActionNodes: graph.needsActionNodes,
    steps,
    whatNowOpen: dialogs.whatNowOpen,
    brainDumpOpen: dump.brainDumpOpen,
  });
  const onboarding = useOnboarding({ session, graph, proposals, panels, showToast });

  const { appMode, systemPanelOpen, workspaceMenuOpen } = panels;
  const openNodeInGraph = (nodeId: string) => {
    panels.setAppMode("graph");
    editor.selectNode(nodeId);
  };

  return (
    <div
      className="app-shell flex min-h-screen flex-col overflow-hidden bg-(--color-bg-base) text-(--color-text-primary)"
      data-app-mode={appMode}
      data-system-panel-open={systemPanelOpen ? "true" : undefined}
    >
      <TopCommandBar
        onToggleSystemPanel={() => {
          panels.setWorkspaceMenuOpen(false);
          panels.setSystemPanelOpen((open) => !open);
        }}
        onToggleRightPanel={() => panels.setRightPanelOpen((open) => !open)}
        onToggleWorkspaceMenu={() => {
          panels.setSystemPanelOpen(false);
          panels.setWorkspaceMenuOpen((open) => !open);
        }}
        onSelectWorkspace={(nextWorkspaceId) => {
          session.setSelectedWorkspaceId(nextWorkspaceId);
          panels.setWorkspaceMenuOpen(false);
        }}
        onCreateWorkspace={onboarding.createWorkspace}
        onDeleteWorkspace={async (deletedWorkspaceId) => {
          await onboarding.deleteWorkspace(deletedWorkspaceId);
        }}
        selectedWorkspaceId={workspaceId}
        systemPanelOpen={systemPanelOpen}
        workspaces={session.workspaces}
        workspaceMenuOpen={workspaceMenuOpen}
        workspaceName={workspaceName}
        onOpenWeeklyReflection={() => dialogs.setWeeklyReflectionOpen(true)}
        onOpenHistory={() => dialogs.setDumpHistoryOpen(true)}
        weeklyReflectionLocked={!isWeeklyReflectionAvailable()}
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
            panels.setSystemPanelOpen(false);
            panels.setWorkspaceMenuOpen(false);
          }}
          tabIndex={systemPanelOpen || workspaceMenuOpen ? 0 : -1}
          type="button"
        />

        <SystemPanel
          onClose={() => panels.setSystemPanelOpen(false)}
          onSignOut={() => {
            void session.signOut();
          }}
          onDeleteAccount={() => {
            void session.deleteAccount();
          }}
          open={systemPanelOpen}
          signingOut={session.signingOut}
          deletingAccount={session.deletingAccount}
          userEmail={session.authUser?.email ?? null}
          workspaceId={workspaceId}
        />

        <ShellViews
          appMode={appMode}
          graphStage={
            <ShellGraphStage
              workspaceId={workspaceId}
              graph={graph}
              view={view}
              editor={editor}
              connections={connections}
              changeStatus={changeStatus}
            />
          }
          graphData={graph.graphData}
          selectedNodeId={view.selectedNodeId}
          workspaceId={workspaceId}
          planner={planner}
          onAskInChat={(message) => {
            void chat.submitMessage(message);
          }}
          onLinkedNodeStatusChange={mirrorPlannerStatus}
          onOpenNodeInGraph={openNodeInGraph}
          onToggleStatus={(nodeId, status) => {
            void changeStatus(nodeId, status);
          }}
        />

        <ShellRail
          workspaceId={workspaceId}
          panels={panels}
          graph={graph}
          selectedNode={view.selectedNode}
          thread={thread}
          chat={chat}
          turns={turns}
          connections={connections}
          steps={steps}
          dump={dump}
          nudges={nudges}
          changeStatus={changeStatus}
          startFocus={focus.startFocus}
          selectNode={editor.selectNode}
        />
      </div>

      <ProposalReviewModal proposals={proposals} existingNodeTitles={graph.existingNodeTitleMap} />
      <StepSuggestModal steps={steps} />
      <FindAllConfirmModal
        open={connections.findAllConfirmOpen}
        nodeCount={graph.graphData.nodes.length}
        onCancel={connections.closeFindAllConfirm}
        onConfirm={connections.confirmFindAll}
      />
      <WorkChips
        autoApplyCount={dump.autoApplyUndo ? dump.autoApplyUndo.count : null}
        onUndoAutoApply={() => void dump.undoAutoApply()}
        onDismissAutoApply={dump.dismissAutoApplyNotice}
        generatingSteps={steps.stepSuggestionLoading}
        onCancelSteps={steps.cancelStepSuggestion}
      />
      <AiStatusChip
        show={!dump.brainDumpOpen && (dump.brainDumpSubmitting || connections.analyzingConnections)}
        readingDump={dump.brainDumpSubmitting}
      />
      <AiNoticeBar
        notice={connections.aiNotice}
        canRetry={
          connections.lastAnalysisNodeIds.length > 0 &&
          connections.lastAnalysisWorkspaceId === workspaceId &&
          !connections.analyzingConnections
        }
        onRetry={connections.retryLastConnectionAnalysis}
        onDismiss={connections.dismissAiNotice}
      />

      {/* Auto-grouping: surface pending cluster suggestions for Accept/Dismiss */}
      {appMode === "graph" && (
        <ClusterSuggestionStack
          workspaceId={workspaceId}
          refreshKey={graph.clusterRefreshKey}
          onAccepted={() => {
            void graph.loadGraph(workspaceId).then(graph.setGraphData);
          }}
        />
      )}

      {freeze.showFreezeNudge ? (
        <FreezeNudgeBar
          count={freeze.readyCount}
          onMapOut={freeze.mapOutNeedsAction}
          onDismiss={freeze.dismissFreezeNudge}
        />
      ) : null}

      {/* AI reach-out ribbon — top-of-screen nudges */}
      <NudgeRibbon
        onOpenNode={(nodeId, nudgeWorkspaceId) => {
          if (nudgeWorkspaceId && nudgeWorkspaceId !== workspaceId) {
            session.setSelectedWorkspaceId(nudgeWorkspaceId);
          }
          editor.selectNode(nodeId);
        }}
      />

      {/* Merge duplicate alerts */}
      {connections.mergeCandidates.length > 0 && (
        <MergeAlert
          candidates={connections.mergeCandidates}
          onKeepBoth={connections.keepBoth}
          onNever={connections.neverMerge}
          onMerge={connections.mergeNodes}
        />
      )}

      {/* Proposed edges review — centered modal */}
      {connections.edgeReviewOpen && connections.proposedEdges.length > 0 && (
        <ProposedEdgesReview
          edges={connections.proposedEdges}
          onConfirm={(actions) => connections.reviewEdges(actions)}
          onDismiss={connections.requestCloseEdgeReview}
        />
      )}

      {/* Floating dock / brain dump overlay */}
      <DumpBoxOrDock
        dump={dump}
        appMode={appMode}
        onSetMode={(mode) => {
          panels.setAppMode(mode);
          // Phone: the panel is a sheet over the whole view — a tap on
          // the tab bar means "show me that view", so it steps aside.
          if (window.matchMedia("(max-width: 640px)").matches) {
            panels.setRightPanelOpen(false);
          }
        }}
        onOpenWhatNow={() => dialogs.setWhatNowOpen((open) => !open)}
        focusGlow={appMode === "graph" && graph.graphData.nodes.some((n) => n.status === "active")}
      />

      <ShellDialogs
        dialogs={dialogs}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        userId={userId}
        graphSignature={graph.graphContentSignature}
        contextFor={(nodeId) =>
          // The step's parent, unless that's the workspace root ("in Life" says nothing).
          parentContextTitle(graph.graphData, nodeId, selectedWorkspace?.bootstrap_root_node_id)
        }
        onFocusNode={(nodeId) => {
          panels.setAppMode("graph");
          dialogs.setWhatNowOpen(false);
          editor.selectNode(nodeId);
          // "Pick something to work on" is the focus intent — set up the
          // timer (paused) on the chosen node. We do NOT auto-break the
          // node into subtasks anymore (testing journal #4): pressing
          // Focus should never silently fire an AI breakdown. If the node
          // needs steps, the user breaks it down from the details panel
          // (which selectNode just opened).
          void focus.startFocus(nodeId);
        }}
        onScheduledToPlanner={() => {
          dialogs.setWhatNowOpen(false);
          panels.setAppMode("assistant");
        }}
        onCheckBack={focus.checkBack}
        onGraphChanged={() => void graph.reloadGraph()}
        onSelectNudge={(nudge) => {
          dialogs.setWhatNowOpen(false);
          // No app-mode swap — the chat fires in the right rail
          // regardless of which view you were on. Yanking to Planner
          // is a context shift the user didn't ask for.
          panels.setActiveRailTab("chat");
          panels.setRightPanelOpen(true);
          void chat.submitMessage(nudge.starter);
        }}
      />

      <ShellOnboarding
        onboarding={onboarding}
        signedIn={Boolean(session.authUser)}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
      />

      {/* Focus timer pill — persistent across every mode/view. */}
      {focus.focusTimer.timer && (
        <FocusTimerPill
          timer={focus.focusTimer.timer}
          remainingSeconds={focus.focusTimer.remainingSeconds}
          onPause={focus.focusTimer.pause}
          onResume={focus.focusTimer.resume}
          onStop={focus.focusTimer.stop}
          onDone={() => {
            void focus.finishFocus();
          }}
        />
      )}
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  );
}
