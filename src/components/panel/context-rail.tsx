import {
  getChatComposerCue,
  getChatScopeMeta,
  getChatScopeTitle,
  getSuggestedPrompts,
} from "@/lib/graph/chat";
import { getLinkedNodePerspectives, type LinkedNodePerspective } from "@/lib/graph/insights";
import { ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, MicIcon } from "@/components/ui/icons";
import { ChatRichText } from "@/components/ui/chat-rich-text";
import { PendingActionCard } from "@/components/panel/pending-action-card";
import { HabitStreak } from "@/components/panel/habit-streak";
import { useVoiceInput } from "@/components/voice/use-voice-input";
import type { ChatMessage, ChatNodeContext, ChatScope, Nudge, RailTab } from "@/types/chat";
import type { GraphData, NodeStatus } from "@/types/graph";
import type { ChatSessionMeta } from "@/lib/chat/sessions";

type LinkCategory = "parent" | "children" | "dependencies" | "supports" | "related";

const CATEGORY_DISPLAY: Record<LinkCategory, string> = {
  parent: "Parent",
  children: "Children",
  dependencies: "Dependencies",
  supports: "Supports",
  related: "Related",
};

const CATEGORY_ORDER: LinkCategory[] = ["parent", "children", "dependencies", "supports", "related"];

function getLinkCategory(labels: string[]): LinkCategory {
  for (const label of labels) {
    if (label === "belongs to") return "parent";
    if (label === "contains") return "children";
    if (label === "required for" || label === "depends on") return "dependencies";
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
  onResolvePendingAction: (messageId: string, decision: "accept" | "reject") => void;
  onCancelChat: () => void;
  pendingActionBusy: boolean;
  nudges: Nudge[];
  onSelectNudge: (nudge: Nudge) => void;
  onSelectPrompt: (prompt: string) => void;
  onFindConnections: (nodeId: string) => void;
  onSuggestSteps?: (nodeId: string) => void;
  suggestStepsBusy?: boolean;
  onStatusChange: (nodeId: string, status: NodeStatus) => void;
  onSelectLinkedNode: (nodeId: string) => void;
  onSetActiveTab: (tab: RailTab) => void;
  onSubmitChatInput: (message: string) => void;
  pendingDumpText?: string | null;
  onResolveDumpChoice?: (choice: "dump" | "chat") => void;
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

// Human labels for the raw signal names persisted by computeWorkspaceScores.
// Anything not in the map renders the raw snake_case name as a fallback.
const SIGNAL_LABELS: Record<string, string> = {
  urgency: "Urgency",
  goal_alignment: "Goal alignment",
  ai_judgment: "AI judgment",
  centrality: "Graph centrality",
  user_confirmation: "User confirmation",
  blocker_resolved_bonus: "Just unblocked",
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
  onRetryChat,
  onResolvePendingAction,
  onCancelChat,
  pendingActionBusy,
  nudges,
  onSelectNudge,
  onSelectPrompt,
  onSelectLinkedNode,
  onSetActiveTab,
  onSubmitChatInput,
  pendingDumpText,
  onResolveDumpChoice,
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
  const linkedNodes = getLinkedNodePerspectives(graphData, selectedNode?.id ?? null);
  const isHabitNode = selectedNode?.node_type === "habit";
  const linkedGroups = groupLinkedNodes(linkedNodes);

  // Voice input for the chat composer. Hidden in Firefox (unsupported).
  const voice = useVoiceInput({
    currentValue: chatInputValue,
    onChange: onChatInputChange,
  });

  return (
    <div
      className={`context-rail-responsive relative shrink-0 overflow-visible border-l border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface-elevated)] transition-[width] duration-200 ease-out ${
        open ? "w-[396px]" : "w-[28px]"
      }`}
      data-open={open ? "true" : "false"}
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
        className={`absolute inset-y-0 right-0 w-[396px] bg-[var(--color-bg-surface-elevated)] transition-[transform,opacity] duration-200 ease-out ${
          open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-6 opacity-0"
        }`}
      >
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
                        !message.pendingAction ? null : (
                        <div className="chat-msg-assistant" key={message.id}>
                          <div className="chat-msg-assistant-card">
                            {message.body.length > 0 ? <ChatRichText body={message.body} /> : null}

                            {message.pendingAction ? (
                              <PendingActionCard
                                action={message.pendingAction}
                                disabled={pendingActionBusy}
                                onResolve={(decision) =>
                                  onResolvePendingAction(message.id, decision)
                                }
                              />
                            ) : null}

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
                            <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">
                              Reasoning
                            </span>
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

              {/* Chat input — replaced by the dump chooser when a typed
                  message reads as a brain dump. */}
              <div className="border-t border-[color:var(--color-border-faint)] px-4 py-3">
                {pendingDumpText ? (
                  <div className="flex flex-col gap-2.5">
                    <p className="text-[12.5px] leading-snug text-(--color-text-secondary)">
                      That reads like a brain dump. How should I take it?
                    </p>
                    <p className="line-clamp-2 rounded-md border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.025)] px-3 py-2 text-[12px] italic text-(--color-text-muted)">
                      {pendingDumpText}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => onResolveDumpChoice?.("dump")}
                        className="flex-1 rounded-full border border-[rgba(213,58,71,0.55)] bg-[rgba(213,58,71,0.95)] px-4 py-2 text-[12.5px] font-semibold text-white"
                      >
                        Brain dump
                      </button>
                      <button
                        type="button"
                        onClick={() => onResolveDumpChoice?.("chat")}
                        className="flex-1 rounded-full border border-[rgba(255,255,255,0.12)] bg-transparent px-4 py-2 text-[12.5px] font-semibold text-(--color-text-secondary)"
                      >
                        Just chatting
                      </button>
                    </div>
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
            <div className="shell-scrollbar flex-1 overflow-y-auto">
              {selectedNode ? (
                <div className="detail-panel">
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
                    <span className="detail-tag">{selectedNode.node_type}</span>
                    <span className="detail-tag">{selectedNode.importance}</span>
                    {selectedNode.status && selectedNode.status !== "active" && (
                      <span className={`detail-tag detail-tag--${selectedNode.status}`}>
                        {selectedNode.status}
                      </span>
                    )}
                  </div>

                  {/* Score — compact inline + why */}
                  {(() => {
                    const displayScore = selectedNode.currentImportanceScore ?? selectedNode.importanceIndex;
                    const signals = selectedNode.importanceTopSignals ?? [];
                    const reason = selectedNode.importanceReason;
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

                  {/* Divider */}
                  <div className="detail-divider" />

                  {/* Connections */}
                  <div className="detail-connections">
                    {linkedGroups.length > 0 ? (
                      linkedGroups.map(({ category, label, nodes }) => (
                        <div className="detail-connection-group" key={category}>
                          <span className="detail-connection-group-label">{label}</span>
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
                      ))
                    ) : (
                      <p className="detail-empty-text">No connections yet.</p>
                    )}
                  </div>

                  {/* Actions — compact row */}
                  <div className="detail-divider" />
                  <div className="detail-actions">
                    {/* Primary row — the headline action for the current
                        state. Full-width, filled, scarlet. Only one shows
                        at a time, so the user always knows the "do this"
                        button by its position. */}
                    {(!selectedNode.status || selectedNode.status === "active") && (
                      <button
                        className="detail-action-primary detail-action-primary--complete"
                        onClick={() => onStatusChange(selectedNode.id, "completed")}
                        type="button"
                      >
                        Mark complete
                      </button>
                    )}
                    {(selectedNode.status === "completed" || selectedNode.status === "paused") && (
                      <button
                        className="detail-action-primary detail-action-primary--reopen"
                        onClick={() => onStatusChange(selectedNode.id, "active")}
                        type="button"
                      >
                        Reopen
                      </button>
                    )}
                    {selectedNode.status === "archived" && (
                      <button
                        className="detail-action-primary detail-action-primary--reopen"
                        onClick={() => onStatusChange(selectedNode.id, "active")}
                        type="button"
                      >
                        Unarchive
                      </button>
                    )}

                    {/* Secondary row — AI tools. Compact neutral pills. */}
                    <div className="detail-actions-secondary">
                      <button
                        className="detail-action-pill"
                        onClick={() => onFindConnections(selectedNode.id)}
                        type="button"
                      >
                        Find links
                      </button>
                      {onSuggestSteps ? (
                        <button
                          className="detail-action-pill"
                          onClick={() => onSuggestSteps(selectedNode.id)}
                          type="button"
                          disabled={suggestStepsBusy}
                          title="Generate a roadmap of concrete sub-tasks for this node"
                        >
                          {suggestStepsBusy ? "Suggesting…" : "Suggest steps"}
                        </button>
                      ) : null}
                    </div>

                    {/* Destructive row — separated and de-emphasized. */}
                    {selectedNode.status !== "archived" ? (
                      <button
                        className="detail-action-destructive"
                        onClick={() => onStatusChange(selectedNode.id, "archived")}
                        type="button"
                      >
                        Archive
                      </button>
                    ) : null}
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
