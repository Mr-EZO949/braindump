"use client";

// The right rail (details · chat) wired to the shell: the selected node and
// its actions, the chat thread and its cards, sessions and starter nudges.

import { ContextRail } from "@/components/panel/context-rail";
import type { ChatNodeContext, Nudge } from "@/types/chat";
import type { Node } from "@/types/graph";

import type { BrainDump } from "./use-brain-dump";
import type { ChatActions } from "./use-chat-actions";
import type { ChatThread } from "./use-chat-thread";
import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { ShellPanels } from "./use-shell-ui";
import type { StepSuggestions } from "./use-step-suggestions";
import type { TurnCards } from "./use-turn-cards";
import type { WorkspaceGraph } from "./use-workspace-graph";

export function ShellRail({
  workspaceId,
  panels,
  graph,
  selectedNode,
  thread,
  chat,
  turns,
  connections,
  steps,
  dump,
  nudges,
  changeStatus,
  startFocus,
  selectNode,
}: {
  workspaceId: string | null;
  panels: ShellPanels;
  graph: Pick<WorkspaceGraph, "graphData">;
  selectedNode: ChatNodeContext | null;
  thread: ChatThread;
  chat: ChatActions;
  turns: TurnCards;
  connections: Pick<ConnectionAnalysis, "analyzeNodes" | "resolveConnections">;
  steps: Pick<StepSuggestions, "suggestStepsForNode" | "stepSuggestionLoading" | "pendingSizeBreakdown" | "resolveSizeBreakdown">;
  dump: Pick<BrainDump, "dumpProgress" | "submitChatInput">;
  nudges: Nudge[];
  changeStatus: (nodeId: string, status: Node["status"]) => Promise<void>;
  // "Start working" opens the Focus Zone on the node.
  startFocus: (nodeId: string) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
}) {
  return (
    <ContextRail
      activeTab={panels.activeRailTab}
      chatInputValue={thread.railChatInput}
      chatLoading={thread.chatLoading}
      chatMessages={thread.chatMessages}
      chatScope={thread.chatScope}
      graphData={graph.graphData}
      onChatInputChange={thread.setRailChatInput}
      onClearChatScope={thread.clearChatScope}
      onRetryChat={chat.retryLastMessage}
      onResolvePendingAction={(messageId, decision, choice, acceptedIndexes) => {
        void chat.resolvePendingAction(messageId, decision, choice, acceptedIndexes);
      }}
      onCancelChat={chat.cancelChat}
      onUndoAppliedAction={(messageId, slot) => {
        void turns.undoAppliedAction(messageId, slot);
      }}
      onUndoTurnSection={(messageId, section) => {
        void turns.undoTurnSection(messageId, section);
      }}
      onUndoAcceptedCard={(messageId) => {
        void turns.undoAcceptedCard(messageId);
      }}
      onAnswerTurnQuestion={turns.answerTurnQuestion}
      onResolveConnections={(messageId, acceptedIds) => {
        void connections.resolveConnections(messageId, acceptedIds);
      }}
      pendingActionBusy={thread.pendingActionBusy}
      dumpProgress={dump.dumpProgress}
      nudges={nudges}
      onSelectNudge={(nudge) => {
        void chat.submitMessage(nudge.starter);
      }}
      onSelectPrompt={(prompt) => {
        void chat.submitMessage(prompt);
      }}
      onSetActiveTab={panels.setActiveRailTab}
      onStatusChange={(nodeId, status) => {
        void changeStatus(nodeId, status);
      }}
      onStartFocusSession={(nodeId) => {
        void startFocus(nodeId);
      }}
      onFindConnections={(nodeId) => {
        if (!workspaceId) return;
        void connections.analyzeNodes([nodeId]);
      }}
      onSuggestSteps={(nodeId, mode, instructions) => {
        void steps.suggestStepsForNode(nodeId, mode, instructions);
      }}
      suggestStepsBusy={steps.stepSuggestionLoading}
      onSelectLinkedNode={selectNode}
      onSubmitChatInput={dump.submitChatInput}
      pendingSizeBreakdown={steps.pendingSizeBreakdown}
      onResolveSizeBreakdown={steps.resolveSizeBreakdown}
      onToggle={() => panels.setRightPanelOpen((open) => !open)}
      open={panels.rightPanelOpen}
      selectedNode={selectedNode}
      chatSessions={thread.chatSessions}
      activeChatSessionId={thread.chatSessionId}
      chatHistoryOpen={thread.chatHistoryOpen}
      onToggleChatHistory={() => thread.setChatHistoryOpen((v) => !v)}
      onStartNewChat={thread.startNewChat}
      onSelectChatSession={(id) => {
        void thread.openChatSession(id);
      }}
      onDeleteChatSession={(id) => {
        void thread.removeChatSession(id);
      }}
    />
  );
}
