"use client";

import { useMemo } from "react";
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
import { useStepSuggestions } from "@/components/app-shell/use-step-suggestions";
import { useProposalReview } from "@/components/app-shell/use-proposal-review";
import { useBrainDump } from "@/components/app-shell/use-brain-dump";
import { useNodeEditor } from "@/components/app-shell/use-node-editor";
import { useNodeStatus } from "@/components/app-shell/use-node-status";
import { useFocusSession } from "@/components/app-shell/use-focus-session";
import { useFreezeNudge } from "@/components/app-shell/use-freeze-nudge";
import { useOnboarding } from "@/components/app-shell/use-onboarding";
import { ShellOnboarding } from "@/components/app-shell/shell-onboarding";
import { AssistantMode as AssistantModeView } from "@/components/assistant/assistant-mode";
import { TodosView } from "@/components/ui/todos-view";
import { HabitsView } from "@/components/ui/habits-view";
import { RoadmapView } from "@/components/ui/roadmap-view";
import { PomodoroView } from "@/components/ui/pomodoro-view";
import { SectionBackdrop } from "@/components/ui/section-backdrop";
import { ModeDock } from "@/components/ui/mode-dock";
import { BrainDumpOverlay } from "@/components/ui/brain-dump-overlay";
import { WhatNowDialog } from "@/components/ui/what-now-dialog";
import { WeeklyReflectionModal } from "@/components/ui/weekly-reflection-modal";
import { DumpHistoryModal } from "@/components/ui/dump-history-modal";
import { ProposedNodesReview } from "@/components/ui/proposed-nodes-review";
import { ProposedEdgesReview } from "@/components/ui/proposed-edges-review";
import { MergeAlert } from "@/components/ui/merge-alert";
import { NudgeRibbon } from "@/components/nudges/nudge-ribbon";
import { ClusterSuggestionStack } from "@/components/clustering/cluster-suggestion-stack";
import { FocusTimerPill } from "@/components/ui/focus-timer-pill";
import {
  loadWorkspaceGraphData,
} from "@/lib/graph/data";

import {
  visibleEdgeRelationOptions,
} from "@/lib/graph/relationships";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import {
  parentContextTitle,
} from "@/lib/graph/visible-graph";
import { isWeeklyReflectionAvailable } from "@/lib/time/weekly-unlock";
import { AutoApplyNotice } from "@/components/ui/auto-apply-notice";

type AppShellProps = {
  initialUser: AuthUserState;
};

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
    focusRequestKey,
    nodeTypeFilter,
    setNodeTypeFilter,
    hideCompleted,
    setHideCompleted,
    setCameraView,
    suppressInitialFocusAnimation,
    completedNodes,
    filteredGraphData,
    selectedNode,
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
    chatScope,
    setChatScope,
    chatLoading,
    pendingActionBusy,
    railChatInput,
    setRailChatInput,
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
  const steps = useStepSuggestions({
    workspaceId: selectedWorkspaceId,
    graph,
    postTurn: turns.postTurn,
    analyzeNodes,
    panels,
  });
  const {
    stepSuggestionNodes,
    stepSuggestionOpen,
    stepSuggestionLoading,
    pendingSizeBreakdown,
    suggestStepsForNode: handleSuggestStepsForNode,
    resolveSizeBreakdown: handleResolveSizeBreakdown,
    toggleStepNode: handleToggleStepNode,
    generateSteps: handleGenerateSteps,
    cancelStepSuggestion,
    dismissStepSuggestion,
  } = steps;
  const proposals = useProposalReview({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    graph,
    view,
    thread,
    submitMessage,
    analyzeNodes,
    steps,
    panels,
  });
  const {
    proposedNodes,
    proposedReviewOpen,
    proposedNodesSubmitting,
    suggestedAreas,
    clarifyingQuestions,
    addAreas: handleAddAreas,
    acceptProposals: handleProposalReview,
    requestCloseReview: requestCloseProposedNodesReview,
    answerInline: handleClarifyingAnswerInline,
  } = proposals;
  const dump = useBrainDump({
    workspaceId: selectedWorkspaceId,
    thread,
    graph,
    postTurn: turns.postTurn,
    proposals,
    analyzeNodes,
    submitMessage,
    panels,
    showToast,
  });
  const {
    brainDumpOpen,
    brainDumpValue,
    setBrainDumpValue,
    brainDumpSubmitting,
    brainDumpRetrying,
    brainDumpError,
    brainDumpFailedEntryId,
    dumpProgress,
    autoApplyUndo,
    dismissAutoApplyNotice,
    undoAutoApply: handleUndoAutoApply,
    submitBrainDump: handleBrainDumpSubmit,
    retryBrainDump: handleBrainDumpRetry,
  } = dump;

  const editor = useNodeEditor({
    supabase,
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    selectedWorkspace,
    workspaceName,
    graph,
    view,
    panels,
    setChatScope,
    steps,
    showToast,
  });
  const {
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
    selectNode: handleSelectNode,
    submitGraphSearch: handleGraphSearchSubmit,
    openCreateNode: handleOpenCreateNode,
    changeCreateField: handleChangeCreateNodeField,
    closeCreateNode: handleCloseCreateNode,
    changeEditField: handleChangeEditNodeField,
    resetManualWeight: handleResetManualWeight,
    closeEditNode: handleCloseEditNode,
    toggleEditMode: handleToggleEditMode,
    submitCreateNode: handleSubmitCreateNode,
    submitEditNode: handleSubmitEditNode,
    deleteNode: handleDeleteNode,
    createEdge: handleSubmitCreateEdge,
    updateEdge: handleUpdateEdge,
    deleteEdge: handleDeleteEdge,
    commitNodePosition: handleCommitNodePosition,
  } = editor;
  const { changeStatus: handleStatusChange, mirrorPlannerStatus } = useNodeStatus({ graph, planner, showToast });
  const focus = useFocusSession({
    supabase,
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    graph,
    planner,
    showToast,
  });
  const { focusTimer, startFocus: handleStartFocus, finishFocus: handleFocusDone, checkBack: handleCheckBack } = focus;
  const freeze = useFreezeNudge({
    userId: authUser?.id ?? null,
    workspaceId: selectedWorkspaceId,
    appMode,
    needsActionNodes,
    steps,
    whatNowOpen,
    brainDumpOpen,
  });
  const onboarding = useOnboarding({ session, graph, proposals, panels, showToast });

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
        onCreateWorkspace={onboarding.createWorkspace}
        onDeleteWorkspace={async (workspaceId) => {
          await onboarding.deleteWorkspace(workspaceId);
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
                onLinkedNodeStatusChange={mirrorPlannerStatus}
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
          onSubmitChatInput={dump.submitChatInput}
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
      {freeze.showFreezeNudge ? (
        <div className="freeze-nudge" role="status">
          <span className="freeze-nudge-text">
            {needsActionNodes.length === 1
              ? "1 item looks ready for a next step."
              : `${needsActionNodes.length} items look ready for a next step.`}
          </span>
          <div className="freeze-nudge-actions">
            <button className="freeze-nudge-btn" type="button" onClick={freeze.mapOutNeedsAction}>
              Pick what to map out
            </button>
            <button
              className="freeze-nudge-dismiss"
              type="button"
              onClick={freeze.dismissFreezeNudge}
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
              onClose={dump.closeBrainDump}
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
              onOpenBrainDump={dump.openBrainDump}
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

      <ShellOnboarding
        onboarding={onboarding}
        signedIn={Boolean(authUser)}
        workspaceId={selectedWorkspaceId}
        workspaceName={workspaceName}
      />

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
