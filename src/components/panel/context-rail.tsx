import {
  getChatComposerCue,
  getChatScopeMeta,
  getChatScopeTitle,
  getSuggestedPrompts,
} from "@/lib/graph/chat";
import { getLinkedNodePerspectives, type LinkedNodePerspective } from "@/lib/graph/insights";
import { ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { ChatRichText } from "@/components/ui/chat-rich-text";
import type { ChatMessage, ChatNodeContext, ChatScope, RailTab } from "@/types/chat";
import type { GraphData, NodeStatus } from "@/types/graph";

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
    if (label === "required for" || label === "requires") return "dependencies";
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
  onSelectPrompt: (prompt: string) => void;
  onFindConnections: (nodeId: string) => void;
  onSaveAnswerAsNode: (text: string) => void;
  onStatusChange: (nodeId: string, status: NodeStatus) => void;
  onSelectLinkedNode: (nodeId: string) => void;
  onSetActiveTab: (tab: RailTab) => void;
  onSubmitChatInput: (message: string) => void;
  onToggle: () => void;
  open: boolean;
  selectedNode: ChatNodeContext | null;
};

function getScoreTier(score: number): string {
  if (score >= 90) return "Critical";
  if (score >= 74) return "High priority";
  if (score >= 40) return "Normal";
  return "Low priority";
}

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
  onSaveAnswerAsNode,
  onStatusChange,
  onRetryChat,
  onSelectPrompt,
  onSelectLinkedNode,
  onSetActiveTab,
  onSubmitChatInput,
  onToggle,
  open,
  selectedNode,
}: ContextRailProps) {
  const promptSuggestions = getSuggestedPrompts(chatScope);
  const linkedNodes = getLinkedNodePerspectives(graphData, selectedNode?.id ?? null);
  const linkedGroups = groupLinkedNodes(linkedNodes);

  return (
    <div
      className={`context-rail-responsive relative shrink-0 overflow-visible border-l border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface-elevated)] transition-[width] duration-200 ease-out ${
        open ? "w-[396px]" : "w-[28px]"
      }`}
      data-open={open ? "true" : "false"}
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
                      ) : message.body.trim().length === 0 && message.status !== "error" ? null : (
                        <div className="chat-msg-assistant" key={message.id}>
                          <div className="chat-msg-assistant-card">
                            <ChatRichText body={message.body} />

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
                            ) : message.body.length > 0 ? (
                              <div className="chat-answer-actions">
                                <button
                                  className="chat-answer-action-btn"
                                  onClick={() => onSaveAnswerAsNode(message.body)}
                                  type="button"
                                  title="Save as node"
                                >
                                  Save as node
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

              {/* Chat input */}
              <div className="border-t border-[color:var(--color-border-faint)] px-4 py-3">
                <div className="flex items-end gap-2">
                  <textarea
                    className="rail-chat-input"
                    onChange={(e) => onChatInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onSubmitChatInput(chatInputValue);
                      }
                    }}
                    placeholder={getChatComposerCue(chatScope)}
                    rows={1}
                    value={chatInputValue}
                  />
                  <button
                    aria-label="Send"
                    className="composer-send-button"
                    disabled={chatLoading || chatInputValue.trim().length === 0}
                    onClick={() => onSubmitChatInput(chatInputValue)}
                    type="button"
                  >
                    <ArrowUpIcon className="h-[15px] w-[15px]" />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Details tab */
            <div className="shell-scrollbar flex-1 overflow-y-auto">
              {selectedNode ? (
                <div className="detail-panel">
                  {/* Summary */}
                  <p className="detail-summary">
                    {selectedNode.summary ?? "No summary yet."}
                  </p>

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

                  {/* Score — compact inline */}
                  {(() => {
                    const displayScore = selectedNode.currentImportanceScore ?? selectedNode.importanceIndex;
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
                      </div>
                    );
                  })()}

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
                    <button
                      className="detail-action-pill"
                      onClick={() => onFindConnections(selectedNode.id)}
                      type="button"
                    >
                      Find links
                    </button>

                    {(!selectedNode.status || selectedNode.status === "active") && (
                      <button
                        className="detail-action-pill detail-action-pill--complete"
                        onClick={() => onStatusChange(selectedNode.id, "completed")}
                        type="button"
                      >
                        Complete
                      </button>
                    )}

                    {(selectedNode.status === "completed" || selectedNode.status === "paused") && (
                      <button
                        className="detail-action-pill detail-action-pill--reopen"
                        onClick={() => onStatusChange(selectedNode.id, "active")}
                        type="button"
                      >
                        Reopen
                      </button>
                    )}

                    {selectedNode.status !== "archived" ? (
                      <button
                        className="detail-action-pill detail-action-pill--danger"
                        onClick={() => onStatusChange(selectedNode.id, "archived")}
                        type="button"
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        className="detail-action-pill detail-action-pill--reopen"
                        onClick={() => onStatusChange(selectedNode.id, "active")}
                        type="button"
                      >
                        Unarchive
                      </button>
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
