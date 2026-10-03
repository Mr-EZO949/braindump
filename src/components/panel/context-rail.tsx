import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import {
  getChatComposerCue,
  getChatScopeMeta,
  getChatScopeTitle,
  getSuggestedPrompts,
} from "@/lib/graph/chat";
import { getLinkedNodePerspectives, type LinkedNodePerspective } from "@/lib/graph/insights";
import { ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon, MicIcon, NetworkIcon, RoadmapIcon } from "@/components/ui/icons";
import { ChatRichText } from "@/components/ui/chat-rich-text";
import { PendingActionCard } from "@/components/panel/pending-action-card";
import { AppliedActionCard } from "@/components/panel/applied-action-card";
import { TurnCard, turnHasCard } from "@/components/panel/turn-card";
import { ConnectionsCard } from "@/components/panel/connections-card";
import { DumpProgressLabel, type DumpProgressState } from "@/components/ui/dump-progress";
import { CHANGE_SET_TOOLS, isChangeList } from "@/lib/chat/change-describe";

// A change set's card (change, build_graph, write_steps) shows inside the
// turn card; any other card of the same turn (a question, a suggestion) shows
// under it.
function isChangeSetCard(action: PendingAction | undefined): action is PendingAction {
  return !!action && CHANGE_SET_TOOLS.has(action.toolName) && isChangeList(action.toolInput.changes);
}
import { HabitStreak } from "@/components/panel/habit-streak";
import { NodeSchedule } from "@/components/panel/node-schedule";
import { useVoiceInput } from "@/components/voice/use-voice-input";
import { classifyTaskSize } from "@/lib/ai/sizing";
import type { ChatMessage, ChatNodeContext, ChatScope, Nudge, PendingAction, RailTab, TurnSection } from "@/types/chat";
import type { GraphData, NodeStatus } from "@/types/graph";
import type { ChatSessionMeta } from "@/lib/chat/sessions";
import { NODE_TYPE_INFO, normalizeNodeType } from "@/lib/graph/node-types";
import { formatShortDate } from "@/lib/graph/short-date";
import { todayIsoDate } from "@/lib/planner/auto-schedule";

type LinkCategory =
  | "parent"
  | "depends_on"
  | "required_for"
  | "children"
  | "supports"
  | "related";

const CATEGORY_DISPLAY: Record<LinkCategory, string> = {
  parent: "Parent",
  // What this node needs done first (its blockers/prerequisites).
  depends_on: "Depends on",
  // What is waiting on this node (its dependents).
  required_for: "Required for",
  children: "Children",
  supports: "Supports",
  related: "Related",
};

const CATEGORY_ORDER: LinkCategory[] = [
  "parent",
  "depends_on",
  "required_for",
  "children",
  "supports",
  "related",
];

function getLinkCategory(labels: string[]): LinkCategory {
  for (const label of labels) {
    if (label === "belongs to") return "parent";
    if (label === "contains") return "children";
    // Directionality matters: "depends on" = this node is blocked by the other;
    // "required for" = the other is blocked by this node. Keep them separate.
    if (label === "depends on") return "depends_on";
    if (label === "required for") return "required_for";
    if (label === "supports" || label === "supported by") return "supports";
  }
  return "related";
}

function groupLinkedNodes(
  linkedNodes: LinkedNodePerspective[],
): Array<{ category: LinkCategory; label: string; nodes: LinkedNodePerspective[] }> {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_DISPLAY[category],
    nodes: linkedNodes.filter((p) => getLinkCategory(p.labels) === category),
  })).filter((g) => g.nodes.length > 0);
}

type ContextRailProps = {
  activeTab: RailTab;
  chatInputValue: string;
  chatLoading: boolean;
  chatMessages: ChatMessage[];
  chatScope: ChatScope;
  graphData: GraphData;
  onChatInputChange: (value: string) => void;
  onClearChatScope: () => void;
  onRetryChat: () => void;
  onResolvePendingAction: (
    messageId: string,
    decision: "accept" | "reject" | "choice",
    choice?: string,
    // A change-set card accepted in part: the rows the user kept.
    acceptedIndexes?: number[],
  ) => void;
  onCancelChat: () => void;
  // slot: which applied change of the message — its own, or (brain-dump turn
  // card) the weekly commitments.
  onUndoAppliedAction: (messageId: string, slot?: "commitments") => void;
  // A turn card: undo one applied section, or the rows accepted on a card;
  // answer a question it asked.
  onUndoTurnSection: (messageId: string, section: TurnSection) => void;
  onUndoAcceptedCard: (messageId: string) => void;
  onAnswerTurnQuestion: (messageId: string, questionIndex: number, answer: string) => void;
  // A links card: the links kept (null → dismiss all).
  onResolveConnections: (messageId: string, acceptedIds: string[] | null) => void;
  pendingActionBusy: boolean;
  // A dump typed in chat: its stage while the builder works (else "Reasoning").
  dumpProgress?: DumpProgressState | null;
  nudges: Nudge[];
  onSelectNudge: (nudge: Nudge) => void;
  onSelectPrompt: (prompt: string) => void;
  onFindConnections: (nodeId: string) => void;
  onSuggestSteps?: (nodeId: string, mode: "light" | "full", instructions?: string) => void;
  suggestStepsBusy?: boolean;
  onStatusChange: (nodeId: string, status: NodeStatus) => void;
  onStartFocusSession?: (nodeId: string) => void;
  onSelectLinkedNode: (nodeId: string) => void;
  onSetActiveTab: (tab: RailTab) => void;
  onSubmitChatInput: (message: string) => void;
  pendingSizeBreakdown?: { title: string } | null;
  onResolveSizeBreakdown?: (choice: "light" | "full" | "keep") => void;
  onToggle: () => void;
  open: boolean;
  selectedNode: ChatNodeContext | null;
  chatSessions: ChatSessionMeta[];
  activeChatSessionId: string | null;
  chatHistoryOpen: boolean;
  onToggleChatHistory: () => void;
  onStartNewChat: () => void;
  onSelectChatSession: (sessionId: string) => void;
  onDeleteChatSession: (sessionId: string) => void;
};

function getScoreTier(score: number): string {
  if (score >= 90) return "Critical";
  if (score >= 74) return "High priority";
  if (score >= 40) return "Normal";
  return "Low priority";
}

// User-facing category label (node types v2). Goals and projects keep the
// Round-1 "Objective" group name in front of their type.
function nodeCategoryLabel(nodeType: string): string {
  const type = normalizeNodeType(nodeType);
  const label = NODE_TYPE_INFO[type].label;
  return type === "goal" || type === "project" ? `Objective · ${label}` : label;
}

// Human labels for the raw signal names persisted by computeWorkspaceScores.
// Anything not in the map renders the raw snake_case name as a fallback.
const SIGNAL_LABELS: Record<string, string> = {
  urgency: "Urgency",
  deadline: "Deadline",
  goal_alignment: "Goal alignment",
  ai_judgment: "AI judgment",
  node_type: "Node type",
  centrality: "Graph centrality",
  freshness: "New",
  user_confirmation: "User confirmation",
  blocker_resolved_bonus: "Just unblocked",
  steering: "You prioritized",
  deprioritized: "You said it can wait",
  stakes: "High stakes",
  on_hold: "On hold",
};

export function ContextRail({
  activeTab,
  chatInputValue,
  chatLoading,
  chatMessages,
  chatScope,
  graphData,
  onChatInputChange,
  onClearChatScope,
  onFindConnections,
  onSuggestSteps,
  suggestStepsBusy,
  onStatusChange,
  onStartFocusSession,
  onRetryChat,
  onResolvePendingAction,
  onCancelChat,
  onUndoAppliedAction,
  onUndoTurnSection,
  onUndoAcceptedCard,
  dumpProgress = null,
  onAnswerTurnQuestion,
  onResolveConnections,
  pendingActionBusy,
  nudges,
  onSelectNudge,
  onSelectPrompt,
  onSelectLinkedNode,
  onSetActiveTab,
  onSubmitChatInput,
  pendingSizeBreakdown,
  onResolveSizeBreakdown,
  onToggle,
  open,
  selectedNode,
  chatSessions,
  activeChatSessionId,
  chatHistoryOpen,
  onToggleChatHistory,
  onStartNewChat,
  onSelectChatSession,
  onDeleteChatSession,
}: ContextRailProps) {
  const promptSuggestions = getSuggestedPrompts(chatScope);
  // Breakdown UI: pressing Quick/Full sets pendingMode → reveals the directions box.
  const [pendingMode, setPendingMode] = useState<"light" | "full" | null>(null);
  const [directions, setDirections] = useState("");
  useEffect(() => {
    setPendingMode(null);
    setDirections("");
  }, [selectedNode?.id]);
  const linkedNodes = getLinkedNodePerspectives(graphData, selectedNode?.id ?? null);
  // Chat's Accept cards name nodes by title instead of showing ids.
  const nodeTitles = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node.title])),
    [graphData.nodes],
  );
  const isHabitNode = selectedNode?.node_type === "habit";
  const linkedGroups = groupLinkedNodes(linkedNodes);

  // Voice input for the chat composer. Hidden in Firefox (unsupported).
  const voice = useVoiceInput({
    currentValue: chatInputValue,
    onChange: onChatInputChange,
  });

  // Drag-to-resize the panel width (desktop). Persisted so it sticks between
  // sessions. On tablet/mobile the responsive CSS forces 100% width with
  // !important, which overrides the inline width below — so this is a no-op there.
  const RAIL_MIN = 320;
  const RAIL_MAX = 760;
  const [railWidth, setRailWidth] = useState(396);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("braindump:rail-width"));
      if (Number.isFinite(saved) && saved >= RAIL_MIN && saved <= RAIL_MAX) {
        setRailWidth(saved);
      }
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);

  const handleResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startWidth: railWidth };
    setResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };
  const handleResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Panel is on the right, so dragging its left edge leftward widens it.
    const next = Math.min(
      RAIL_MAX,
      Math.max(RAIL_MIN, drag.startWidth + (drag.startX - event.clientX)),
    );
    setRailWidth(next);
  };
  const handleResizeUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    try {
      localStorage.setItem("braindump:rail-width", String(railWidth));
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`context-rail-responsive relative shrink-0 overflow-visible border-l border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface-elevated)] ${
        resizing ? "" : "transition-[width] duration-200 ease-out"
      }`}
      style={{ width: open ? railWidth : 28 }}
      data-open={open ? "true" : "false"}
      data-tab={activeTab}
      data-tour="context-rail"
    >
      <button
        aria-label={open ? "Close context panel" : "Open context panel"}
        className="panel-edge-handle"
        onClick={onToggle}
        type="button"
      >
        {open ? (
          <ChevronRightIcon className="h-[14px] w-[14px]" />
        ) : (
          <ChevronLeftIcon className="h-[14px] w-[14px]" />
        )}
      </button>

      <aside
        aria-hidden={!open}
        className={`absolute inset-y-0 right-0 bg-[var(--color-bg-surface-elevated)] transition-[transform,opacity] duration-200 ease-out ${
          open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-6 opacity-0"
        }`}
        style={{ width: railWidth }}
      >
        {/* Drag the left edge to resize the panel. */}
        <div
          className="rail-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
        />
        <div className="flex h-full flex-col">
          {/* Tab strip + header */}
          <div className="border-b border-[color:var(--color-border-faint)] px-5 py-5">
            <div className="mb-3 flex items-center justify-between md-up-hidden">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Panel</span>
              <button
                aria-label="Close panel"
                className="sp-close"
                onClick={onToggle}
                type="button"
              >
                ×
              </button>
            </div>
            <div aria-label="Context rail mode" className="rail-tab-strip" role="tablist">
              <button
                aria-selected={activeTab === "details"}
                className="rail-tab-button"
                data-active={activeTab === "details"}
                data-tour="rail-details"
                onClick={() => onSetActiveTab("details")}
                role="tab"
                type="button"
              >
                Details
              </button>
              <button
                aria-selected={activeTab === "chat"}
                className="rail-tab-button"
                data-active={activeTab === "chat"}
                data-tour="rail-chat"
                onClick={() => onSetActiveTab("chat")}
                role="tab"
                type="button"
              >
                Chat
              </button>
            </div>

            {activeTab === "chat" ? (
              <div className="mt-5 space-y-3">
                <div className="chat-history-bar">
                  <button
                    className="chat-history-bar-btn"
                    onClick={onStartNewChat}
                    type="button"
                  >
                    New chat
                  </button>
                  <button
                    className="chat-history-bar-btn"
                    data-active={chatHistoryOpen}
                    onClick={onToggleChatHistory}
                    type="button"
                  >
                    History
                    {chatSessions.length > 0 ? (
                      <span className="chat-history-bar-count">{chatSessions.length}</span>
                    ) : null}
                  </button>
                </div>

                {chatHistoryOpen && chatSessions.length === 0 ? (
                  <div className="chat-history-empty">
                    No past chats yet — they appear here once you&apos;ve had a conversation.
                  </div>
                ) : null}

                {chatHistoryOpen && chatSessions.length > 0 ? (
                  <ul className="chat-history-list">
                    {chatSessions.map((session) => (
                      <li
                        key={session.id}
                        className="chat-history-row"
                        data-active={session.id === activeChatSessionId}
                      >
                        <button
                          className="chat-history-select"
                          onClick={() => onSelectChatSession(session.id)}
                          type="button"
                        >
                          <span className="chat-history-title">
                            {session.title || "New conversation"}
                          </span>
                          <span className="chat-history-meta">
                            {session.message_count} msg
                            {session.last_message_at
                              ? ` · ${new Date(session.last_message_at).toLocaleDateString()}`
                              : ""}
                          </span>
                        </button>
                        <button
                          aria-label="Delete conversation"
                          className="chat-history-delete"
                          onClick={() => onDeleteChatSession(session.id)}
                          type="button"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Scope
                    </p>
                    <h2 className="mt-3 text-[18px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
                      {getChatScopeTitle(chatScope)}
                    </h2>
                    <p className="mt-2 text-[12px] font-medium tracking-[-0.01em] text-[var(--color-text-secondary)]">
                      {getChatScopeMeta(chatScope)}
                    </p>
                  </div>

                  {chatScope.kind === "node" ? (
                    <button className="rail-scope-action" onClick={onClearChatScope} type="button">
                      Use workspace
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mt-5">
                {selectedNode ? (
                  <h2 className="text-[17px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)] leading-snug">
                    {selectedNode.title}
                  </h2>
                ) : (
                  <h2 className="text-[15px] font-medium tracking-[-0.02em] text-[var(--color-text-muted)]">
                    Details
                  </h2>
                )}
              </div>
            )}
          </div>

          {/* Tab body */}
          {activeTab === "chat" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shell-scrollbar flex-1 overflow-y-auto px-5 py-5">
                {chatMessages.length === 0 ? (
                  <div className="space-y-6">
                    {!selectedNode ? (
                      <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
                        Select a node to ask scoped questions about it, or chat across the whole
                        workspace.
                      </p>
                    ) : null}

                    {nudges.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
                          Worth a look
                        </p>
                        <div className="chat-nudge-list">
                          {nudges.map((nudge) => (
                            <button
                              className="chat-nudge-chip"
                              key={nudge.id}
                              onClick={() => onSelectNudge(nudge)}
                              type="button"
                            >
                              {nudge.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-1">
                      <p className="text-[12px] font-medium tracking-[-0.01em] text-[var(--color-text-secondary)]">
                        Start with a scoped question.
                      </p>
                      <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
                        Chat stays attached to the selected node or workspace.
                      </p>
                    </div>

                    <div className="chat-prompt-list">
                      {promptSuggestions.map((prompt) => (
                        <button
                          className="chat-prompt-chip"
                          key={prompt}
                          onClick={() => onSelectPrompt(prompt)}
                          type="button"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="chat-messages">
                    {chatMessages.map((message) =>
                      message.role === "user" ? (
                        <div className="chat-msg-user" key={message.id}>
                          <p>{message.body}</p>
                        </div>
                      ) : message.body.trim().length === 0 &&
                        message.status !== "error" &&
                        !message.pendingAction &&
                        !message.appliedAction &&
                        !message.turn &&
                        !message.connections ? null : (
                        <div className="chat-msg-assistant" key={message.id}>
                          <div className="chat-msg-assistant-card">
                            {message.body.length > 0 ? <ChatRichText body={message.body} /> : null}

                            {message.connections ? (
                              <ConnectionsCard
                                connections={message.connections}
                                disabled={pendingActionBusy}
                                onResolve={(acceptedIds) => onResolveConnections(message.id, acceptedIds)}
                              />
                            ) : null}

                            {message.turn ? (
                              // A brain dump or a chat change: everything it
                              // changed on ONE card.
                              <>
                              {turnHasCard(
                                message.turn,
                                message.appliedAction,
                                isChangeSetCard(message.pendingAction) ? message.pendingAction : undefined,
                              ) ? (
                                <TurnCard
                                  disabled={pendingActionBusy || chatLoading}
                                  nodeTitles={nodeTitles}
                                  onAnswer={(index, answer) => onAnswerTurnQuestion(message.id, index, answer)}
                                  onResolve={(decision, acceptedIndexes) =>
                                    onResolvePendingAction(message.id, decision, undefined, acceptedIndexes)
                                  }
                                  onUndoAccepted={() => onUndoAcceptedCard(message.id)}
                                  onUndoSection={(section) => onUndoTurnSection(message.id, section)}
                                  onUndoCommitments={() => onUndoAppliedAction(message.id, "commitments")}
                                  onUndoPriorities={() => onUndoAppliedAction(message.id)}
                                  pending={isChangeSetCard(message.pendingAction) ? message.pendingAction : undefined}
                                  priorities={message.appliedAction}
                                  turn={message.turn}
                                />
                              ) : null}
                              {/* A card of another kind in the same turn (a question, a suggestion). */}
                              {message.pendingAction && !isChangeSetCard(message.pendingAction) ? (
                                <PendingActionCard
                                  action={message.pendingAction}
                                  disabled={pendingActionBusy}
                                  nodeTitles={nodeTitles}
                                  onResolve={(decision, choice, acceptedIndexes) =>
                                    onResolvePendingAction(message.id, decision, choice, acceptedIndexes)
                                  }
                                  onUndo={() => onUndoAcceptedCard(message.id)}
                                />
                              ) : null}
                              </>
                            ) : (
                              <>
                                {message.appliedAction ? (
                                  <AppliedActionCard
                                    action={message.appliedAction}
                                    onUndo={() => onUndoAppliedAction(message.id)}
                                  />
                                ) : null}

                                {message.pendingAction ? (
                                  <PendingActionCard
                                    action={message.pendingAction}
                                    nodeTitles={nodeTitles}
                                    disabled={pendingActionBusy}
                                    onResolve={(decision, choice, acceptedIndexes) =>
                                      onResolvePendingAction(message.id, decision, choice, acceptedIndexes)
                                    }
                                    onUndo={() => onUndoAcceptedCard(message.id)}
                                  />
                                ) : null}
                              </>
                            )}

                            {message.sections && message.sections.length > 0 ? (
                              <div className="chat-section-list">
                                {message.sections.map((section) => (
                                  <div
                                    className="chat-section-row"
                                    key={`${message.id}-${section.label}`}
                                  >
                                    <span className="chat-section-label">{section.label}</span>
                                    <p className="chat-section-value">{section.value}</p>
                                  </div>
                                ))}
                              </div>
                            ) : null}

                            {message.status === "error" ? (
                              <div className="chat-answer-actions">
                                <button
                                  className="chat-answer-action-btn"
                                  onClick={onRetryChat}
                                  type="button"
                                >
                                  Retry
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ),
                    )}

                    {chatLoading ? (
                      <div className="chat-msg-assistant">
                        <div className="chat-msg-assistant-card">
                          <div className="chat-loading-indicator" aria-live="polite">
                            {dumpProgress ? (
                              <DumpProgressLabel
                                className="text-[12px] font-medium text-[var(--color-text-secondary)]"
                                progress={dumpProgress}
                              />
                            ) : (
                              <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">
                                Reasoning
                              </span>
                            )}
                            <span className="chat-loading-dot" />
                            <span className="chat-loading-dot" />
                            <span className="chat-loading-dot" />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Chat input — replaced by the "break it down?" chooser after a
                  big task was created. */}
              <div className="border-t border-[color:var(--color-border-faint)] px-4 py-3">
                {pendingSizeBreakdown ? (
                  <div className="flex flex-col gap-2.5">
                    <p className="text-[12.5px] leading-snug text-(--color-text-secondary)">
                      This looks like a big task — more than one sitting. Have AI break it down?
                    </p>
                    <p className="line-clamp-2 rounded-md border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.025)] px-3 py-2 text-[12px] italic text-(--color-text-muted)">
                      {pendingSizeBreakdown.title}
                    </p>
                    <div className="detail-assist-grid">
                      <button
                        type="button"
                        onClick={() => onResolveSizeBreakdown?.("light")}
                        className="da-suggest-card"
                        title="Just the 1–3 immediate next tasks to get unstuck — quick, cheap"
                      >
                        <ListIcon className="da-suggest-icon" />
                        <span><strong>Quick steps</strong><small>Next 1–3 actions</small></span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onResolveSizeBreakdown?.("full")}
                        className="da-suggest-card da-suggest-card--roadmap"
                        title="AI builds a full roadmap: phases with concrete steps under each. Uses more tokens."
                      >
                        <RoadmapIcon className="da-suggest-icon" />
                        <span><strong>AI roadmap</strong><small>Phases + steps</small></span>
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => onResolveSizeBreakdown?.("keep")}
                      className="self-start text-[11.5px] font-medium text-(--color-text-muted) underline-offset-2 hover:underline"
                    >
                      Keep as one task
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-end gap-2">
                      <div className="relative flex-1">
                        <textarea
                          className="rail-chat-input"
                          onChange={(e) => onChatInputChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              if (voice.recording) voice.stop();
                              onSubmitChatInput(chatInputValue);
                            }
                          }}
                          placeholder={
                            voice.recording
                              ? "Listening…"
                              : getChatComposerCue(chatScope)
                          }
                          rows={1}
                          value={chatInputValue}
                        />
                        {voice.recording && voice.interimText ? (
                          <span className="rail-chat-interim">
                            {voice.interimText}
                          </span>
                        ) : null}
                      </div>
                      {voice.supported ? (
                        <button
                          aria-label={
                            voice.recording ? "Stop recording" : "Voice input"
                          }
                          className="composer-mic-button"
                          data-recording={voice.recording}
                          onClick={voice.toggle}
                          type="button"
                        >
                          <MicIcon className="h-[14px] w-[14px]" />
                        </button>
                      ) : null}
                      {chatLoading ? (
                        <button
                          aria-label="Stop"
                          className="composer-send-button composer-send-button--stop"
                          onClick={onCancelChat}
                          type="button"
                        >
                          <span
                            className="composer-stop-square"
                            aria-hidden="true"
                          />
                        </button>
                      ) : (
                        <button
                          aria-label="Send"
                          className="composer-send-button"
                          disabled={chatInputValue.trim().length === 0}
                          onClick={() => {
                            if (voice.recording) voice.stop();
                            onSubmitChatInput(chatInputValue);
                          }}
                          type="button"
                        >
                          <ArrowUpIcon className="h-[15px] w-[15px]" />
                        </button>
                      )}
                    </div>
                    {voice.error ? (
                      <p className="rail-chat-mic-error">{voice.error}</p>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Details tab */
            <div className="detail-tab">
              {selectedNode ? (
                <div className="detail-panel">
                  <div className="detail-scroll shell-scrollbar">
                  {/* Summary — "what is this" */}
                  <p className="detail-summary">
                    {selectedNode.summary ?? "No summary yet."}
                  </p>

                  {/* Body — "so what / why it matters / next step". Only
                      shown when present; falls back silently if the
                      extractor / user didn't fill it. */}
                  {selectedNode.body ? (
                    <p className="detail-body">{selectedNode.body}</p>
                  ) : null}

                  {/* Meta tags row */}
                  <div className="detail-meta-row">
                    <span className="detail-tag">{nodeCategoryLabel(selectedNode.node_type)}</span>
                    <span className="detail-tag">{selectedNode.importance}</span>
                    {selectedNode.status && selectedNode.status !== "active" && (
                      <span className={`detail-tag detail-tag--${selectedNode.status}`}>
                        {selectedNode.status === "paused" && selectedNode.waitingFor
                          ? "waiting"
                          : selectedNode.status}
                      </span>
                    )}
                    {selectedNode.stakes === 1 ? (
                      <span className="detail-tag detail-tag--stakes">high stakes</span>
                    ) : selectedNode.stakes === -1 ? (
                      <span className="detail-tag">low stakes</span>
                    ) : null}
                  </div>

                  {/* On hold — what it's waiting on and when to check back
                      (ranking v2). Its open steps are out of Focus meanwhile. */}
                  {selectedNode.status === "paused" ? (() => {
                    const resumeOn = selectedNode.resumeOn ?? null;
                    const due = resumeOn !== null && resumeOn <= todayIsoDate();
                    return (
                      <div className={`detail-waiting${due ? " detail-waiting--due" : ""}`}>
                        <span className="detail-waiting-icon" aria-hidden="true">
                          ⏸
                        </span>
                        <div className="detail-waiting-text">
                          <span className="detail-waiting-title">
                            {selectedNode.waitingFor ? `Waiting for ${selectedNode.waitingFor}` : "On hold"}
                          </span>
                          <span className="detail-waiting-sub">
                            {due
                              ? "Time to check back — any news?"
                              : resumeOn
                                ? `Check back ${formatShortDate(resumeOn)} · its steps are out of Focus till then`
                                : "Its steps are out of Focus until you pick it back up"}
                          </span>
                        </div>
                      </div>
                    );
                  })() : null}

                  {/* Fixed weekly times linked to this node (a class, a job). */}
                  <NodeSchedule nodeId={selectedNode.id} />

                  {/* Score — compact inline + why */}
                  {(() => {
                    const displayScore = selectedNode.currentImportanceScore ?? selectedNode.importanceIndex;
                    const paused = selectedNode.status === "paused";
                    // The tags and the waiting callout already say "high
                    // stakes" / "on hold" — the chips keep what they don't.
                    const signals = (selectedNode.importanceTopSignals ?? []).filter(
                      (sig) =>
                        !(sig === "stakes" && selectedNode.stakes === 1) &&
                        !(sig === "on_hold" && paused),
                    );
                    const reason = paused ? null : selectedNode.importanceReason;
                    const hasExplainer = reason || signals.length > 0;
                    return (
                      <div className="detail-score">
                        <div className="detail-score-header">
                          <span className="detail-score-value">{Math.round(displayScore)}</span>
                          <span className="detail-score-tier">{getScoreTier(displayScore)}</span>
                        </div>
                        <div className="detail-score-bar">
                          <div
                            className="detail-score-bar-fill"
                            style={{ width: `${Math.round(displayScore)}%` }}
                          />
                        </div>
                        {hasExplainer ? (
                          <div className="detail-score-explainer">
                            {signals.length > 0 ? (
                              <div className="detail-score-signals">
                                {signals.map((sig) => (
                                  <span
                                    key={sig}
                                    className="detail-score-signal-chip"
                                  >
                                    {SIGNAL_LABELS[sig] ?? sig}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {reason ? (
                              <p className="detail-score-reason">{reason}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}

                  {/* Habit streak — only for habit-typed nodes */}
                  {isHabitNode ? (
                    <>
                      <div className="detail-divider" />
                      <HabitStreak nodeId={selectedNode.id} />
                    </>
                  ) : null}

                  {/* Connections — end of the scroll, clearly legible */}
                  <div className="detail-divider" />
                  <div className="detail-section-label">Connections</div>
                  <div className="detail-connections">
                    {linkedGroups.length > 0 ? (
                      linkedGroups.map(({ category, label, nodes }) => (
                        <div className="detail-connection-group" key={category}>
                          <span className="detail-connection-group-label">{label}</span>
                          <div className="detail-connection-items">
                            {nodes.map(({ node }) => (
                              <button
                                className="detail-connection-item"
                                key={`${selectedNode.id}-${node.id}`}
                                onClick={() => onSelectLinkedNode(node.id)}
                                type="button"
                              >
                                {node.title}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="detail-empty-text">No connections yet.</p>
                    )}
                  </div>
                  </div>
                  {/* /.detail-scroll */}

                  {/* Pinned footer — actions always live at the bottom. */}
                  <div className="detail-footer">
                    {onSuggestSteps && pendingMode ? (
                      <div className="detail-directions">
                        <textarea
                          className="detail-directions-input"
                          value={directions}
                          onChange={(e) => setDirections(e.target.value)}
                          placeholder="Optional directions — e.g. 'focus on the first week' or 'I already have a draft'"
                          rows={2}
                          maxLength={500}
                          autoFocus
                        />
                        <div className="detail-action-row">
                          <button className="da-text" onClick={() => setPendingMode(null)} type="button">
                            Cancel
                          </button>
                          <button
                            className="da-complete da-complete--done"
                            onClick={() => {
                              onSuggestSteps(
                                selectedNode.id,
                                pendingMode,
                                directions.trim() || undefined,
                              );
                              setPendingMode(null);
                            }}
                            type="button"
                            disabled={suggestStepsBusy}
                          >
                            {suggestStepsBusy ? "Suggesting…" : "Generate steps →"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Primary — "Start working" is the do-this button; Mark
                            complete sits beside it, monochrome until hover/done. */}
                        <div className="detail-primary-row">
                          {selectedNode.status === "archived" ? (
                            <button
                              className="da-start"
                              onClick={() => onStatusChange(selectedNode.id, "active")}
                              type="button"
                            >
                              Unarchive
                            </button>
                          ) : selectedNode.status === "completed" ? (
                            <>
                              <button className="da-start da-start--off" type="button" disabled>
                                Start working
                              </button>
                              <button
                                className="da-complete da-complete--done"
                                onClick={() => onStatusChange(selectedNode.id, "active")}
                                type="button"
                                title="Completed — click to reopen"
                              >
                                Completed ✓
                              </button>
                            </>
                          ) : selectedNode.status === "paused" ? (
                            <>
                              <button
                                className="da-start"
                                onClick={() => onStatusChange(selectedNode.id, "active")}
                                type="button"
                              >
                                Resume
                              </button>
                              <button
                                className="da-complete"
                                onClick={() => onStatusChange(selectedNode.id, "completed")}
                                type="button"
                              >
                                Mark complete
                              </button>
                            </>
                          ) : isHabitNode ? (
                            onStartFocusSession ? (
                              <button
                                className="da-start"
                                onClick={() => onStartFocusSession(selectedNode.id)}
                                type="button"
                              >
                                Start working
                              </button>
                            ) : null
                          ) : (
                            <>
                              {onStartFocusSession ? (
                                <button
                                  className="da-start"
                                  onClick={() => onStartFocusSession(selectedNode.id)}
                                  type="button"
                                >
                                  Start working
                                </button>
                              ) : null}
                              <button
                                className="da-complete"
                                onClick={() => onStatusChange(selectedNode.id, "completed")}
                                type="button"
                              >
                                Mark complete
                              </button>
                            </>
                          )}
                        </div>

                        {onSuggestSteps &&
                          (selectedNode.node_type === "project" ||
                            selectedNode.node_type === "goal" ||
                            selectedNode.node_type === "big_task" ||
                            classifyTaskSize(selectedNode.title) !== "task") ? (
                            <div className="detail-assist-grid">
                              <button
                                className="da-suggest-card"
                                onClick={() => setPendingMode("light")}
                                type="button"
                                disabled={suggestStepsBusy}
                                title="Just the 1–3 immediate next tasks to get unstuck — quick, cheap"
                              >
                                <ListIcon className="da-suggest-icon" />
                                <span><strong>Quick steps</strong><small>Next 1–3 actions</small></span>
                              </button>
                              <button
                                className="da-suggest-card da-suggest-card--roadmap"
                                onClick={() => setPendingMode("full")}
                                type="button"
                                disabled={suggestStepsBusy}
                                title="AI generates a full multi-phase roadmap (a deep tree of sub-tasks). Uses more tokens."
                              >
                                <RoadmapIcon className="da-suggest-icon" />
                                <span><strong>AI roadmap</strong><small>Phases + steps</small></span>
                              </button>
                            </div>
                          ) : null}

                        <div className="detail-utility-row">
                          <button
                            className="da-utility"
                            onClick={() => onFindConnections(selectedNode.id)}
                            type="button"
                            title="Find hidden links to other nodes"
                          >
                            <NetworkIcon className="h-[14px] w-[14px]" />
                            <span>Find links</span>
                          </button>
                          <Link
                            className="da-utility"
                            href={`/n/${selectedNode.id}`}
                            title="Read full view"
                          >
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H10a2 2 0 0 1 2 2v14a1.5 1.5 0 0 0-1.5-1.5H4.5A2.5 2.5 0 0 1 2 15V5.5Z" />
                              <path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H14a2 2 0 0 0-2 2v14a1.5 1.5 0 0 1 1.5-1.5h6A2.5 2.5 0 0 0 22 15V5.5Z" />
                            </svg>
                            <span>Read</span>
                          </Link>
                          <span className="detail-utility-spacer" />
                          {selectedNode.status !== "archived" ? (
                            <button
                              className="da-utility da-utility--archive"
                              onClick={() => onStatusChange(selectedNode.id, "archived")}
                              type="button"
                            >
                              Archive
                            </button>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="detail-panel detail-panel--empty">
                  <div className="detail-empty-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4M12 16h.01" />
                    </svg>
                  </div>
                  <p className="detail-empty-title">No node selected</p>
                  <p className="detail-empty-hint">
                    Click a node on the graph to inspect its details, connections, and actions.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
