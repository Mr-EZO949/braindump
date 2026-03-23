import {
  getChatComposerCue,
  getChatScopeMeta,
  getChatScopeTitle,
  getSuggestedPrompts,
} from "@/lib/graph/chat";
import { getLinkedNodePerspectives, type LinkedNodePerspective } from "@/lib/graph/insights";
import { ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import type { ChatMessage, ChatNodeContext, ChatScope, RailTab } from "@/types/chat";
import type { GraphData } from "@/types/graph";

type LinkCategory = "parent" | "children" | "dependencies" | "blocking" | "supports" | "related";

const CATEGORY_DISPLAY: Record<LinkCategory, string> = {
  parent: "Parent",
  children: "Children",
  dependencies: "Dependencies",
  blocking: "Blocking",
  supports: "Supports",
  related: "Related",
};

const CATEGORY_ORDER: LinkCategory[] = [
  "parent",
  "children",
  "dependencies",
  "blocking",
  "supports",
  "related",
];

function getLinkCategory(labels: string[]): LinkCategory {
  for (const label of labels) {
    if (label === "belongs to") return "parent";
    if (label === "contains") return "children";
    if (label === "required for" || label === "requires") return "dependencies";
    if (label === "blocks" || label === "blocked by") return "blocking";
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
  chatError: string | null;
  chatInputValue: string;
  chatLoading: boolean;
  chatMessages: ChatMessage[];
  chatScope: ChatScope;
  graphData: GraphData;
  onChatInputChange: (value: string) => void;
  onClearChatScope: () => void;
  onRetryChat: () => void;
  onSelectPrompt: (prompt: string) => void;
  onSelectLinkedNode: (nodeId: string) => void;
  onSetActiveTab: (tab: RailTab) => void;
  onSubmitChatInput: (message: string) => void;
  onToggle: () => void;
  open: boolean;
  selectedNode: ChatNodeContext | null;
};

export function ContextRail({
  activeTab,
  chatError,
  chatInputValue,
  chatLoading,
  chatMessages,
  chatScope,
  graphData,
  onChatInputChange,
  onClearChatScope,
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
      className={`relative shrink-0 overflow-visible border-l border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface-elevated)] transition-[width] duration-200 ease-out ${
        open ? "w-[396px]" : "w-[28px]"
      }`}
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
              <div className="mt-5 flex items-start justify-between gap-4">
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
            ) : (
              <div className="mt-5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                  Inspector
                </p>
                <h2 className="mt-3 text-[18px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
                  {selectedNode ? selectedNode.title : "No selection"}
                </h2>
                {selectedNode ? (
                  <p className="mt-2 text-[12px] font-medium tracking-[-0.01em] text-[var(--color-text-secondary)]">
                    {selectedNode.node_type}
                    {" · "}
                    {selectedNode.importance}
                  </p>
                ) : (
                  <p className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                    Select a node to inspect it.
                  </p>
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
                  <div className="space-y-4">
                    {chatMessages.map((message) =>
                      message.role === "user" ? (
                        <div className="flex justify-end" key={message.id}>
                          <div className="chat-message-user">
                            <p>{message.body}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="chat-message-assistant" key={message.id}>
                          <p className="chat-message-body">{message.body}</p>

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
                        </div>
                      ),
                    )}

                    {chatLoading ? (
                      <div className="chat-loading-indicator" aria-live="polite">
                        <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">
                          Reasoning
                        </span>
                        <span className="chat-loading-dot" />
                        <span className="chat-loading-dot" />
                        <span className="chat-loading-dot" />
                      </div>
                    ) : null}

                    {chatError ? (
                      <div className="chat-error-state" role="status">
                        <p className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
                          {chatError}
                        </p>
                        <button className="rail-scope-action" onClick={onRetryChat} type="button">
                          Retry
                        </button>
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
            <div className="shell-scrollbar flex-1 overflow-y-auto px-6 py-6">
              {selectedNode ? (
                <div className="space-y-6">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Summary
                    </p>
                    <p className="mt-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                      {selectedNode.summary ?? "No summary yet."}
                    </p>
                  </div>

                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Node
                    </p>
                    <div className="mt-4 grid gap-3">
                      <div className="context-detail-row">
                        <span className="context-detail-label">Type</span>
                        <span className="context-detail-value">{selectedNode.node_type}</span>
                      </div>
                      <div className="context-detail-row">
                        <span className="context-detail-label">Importance</span>
                        <span className="context-detail-value">
                          {selectedNode.importance} · {selectedNode.importanceIndex}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Connections
                    </p>
                    {linkedGroups.length > 0 ? (
                      <div className="mt-4 space-y-5">
                        {linkedGroups.map(({ category, label, nodes }) => (
                          <div key={category}>
                            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--color-text-muted)]">
                              {label}
                            </p>
                            <div className="space-y-1">
                              {nodes.map(({ node, labels: nodeLabels }) => (
                                <button
                                  className="context-linked-node"
                                  key={`${selectedNode.id}-${node.id}`}
                                  onClick={() => onSelectLinkedNode(node.id)}
                                  type="button"
                                >
                                  <span className="context-linked-node-title">{node.title}</span>
                                  <span className="context-linked-node-meta">
                                    {nodeLabels.join(" • ")}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-4 text-[12px] leading-5 text-[var(--color-text-muted)]">
                        No connections yet.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Node
                    </p>
                    <div className="mt-4 space-y-0">
                      <div className="context-stub-row">
                        <span className="context-stub-label">Type</span>
                        <span className="context-stub-line" />
                      </div>
                      <div className="context-stub-row">
                        <span className="context-stub-label">Links</span>
                        <span className="context-stub-line" />
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Actions
                    </p>
                    <div className="mt-4 space-y-0">
                      <div className="context-stub-row">
                        <span className="context-stub-label">Open</span>
                        <span className="context-stub-line context-stub-line-short" />
                      </div>
                      <div className="context-stub-row">
                        <span className="context-stub-label">Notes</span>
                        <span className="context-stub-line context-stub-line-short" />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
