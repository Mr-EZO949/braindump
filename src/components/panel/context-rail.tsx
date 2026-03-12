import {
  getChatComposerCue,
  getChatScopeMeta,
  getChatScopeTitle,
  getSuggestedPrompts,
} from "@/lib/graph/chat";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import type { ChatMessage, ChatNodeContext, ChatScope, RailTab } from "@/types/chat";
import type { GraphData } from "@/types/graph";

type ContextRailProps = {
  activeTab: RailTab;
  chatError: string | null;
  chatLoading: boolean;
  chatMessages: ChatMessage[];
  chatScope: ChatScope;
  graphData: GraphData;
  onClearChatScope: () => void;
  onRetryChat: () => void;
  onSelectPrompt: (prompt: string) => void;
  onSelectLinkedNode: (nodeId: string) => void;
  onSetActiveTab: (tab: RailTab) => void;
  onToggle: () => void;
  open: boolean;
  selectedNode: ChatNodeContext | null;
};

export function ContextRail({
  activeTab,
  chatError,
  chatLoading,
  chatMessages,
  chatScope,
  graphData,
  onClearChatScope,
  onRetryChat,
  onSelectPrompt,
  onSelectLinkedNode,
  onSetActiveTab,
  onToggle,
  open,
  selectedNode,
}: ContextRailProps) {
  const promptSuggestions = getSuggestedPrompts(chatScope);
  const linkedNodes = selectedNode
    ? Array.from(
        graphData.edges
          .filter(
            (edge) =>
              edge.source_node_id === selectedNode.id || edge.target_node_id === selectedNode.id,
          )
          .reduce((accumulator, edge) => {
            const linkedNodeId =
              edge.source_node_id === selectedNode.id
                ? edge.target_node_id
                : edge.source_node_id;
            const linkedNode =
              graphData.nodes.find((node) => node.id === linkedNodeId) ?? null;

            if (!linkedNode) {
              return accumulator;
            }

            const existing = accumulator.get(linkedNodeId);

            if (existing) {
              existing.edgeTypes.add(edge.edge_type);
              return accumulator;
            }

            accumulator.set(linkedNodeId, {
              edgeTypes: new Set([edge.edge_type]),
              node: linkedNode,
            });

            return accumulator;
          }, new Map<
            string,
            {
              edgeTypes: Set<GraphData["edges"][number]["edge_type"]>;
              node: GraphData["nodes"][number];
            }
          >())
          .values(),
      ).map(({ edgeTypes, node }) => ({
        edgeTypes: Array.from(edgeTypes),
        node,
      }))
    : [];

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
                  Context
                </p>
                <h2 className="mt-3 text-[18px] font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
                  {selectedNode ? selectedNode.title : "No selection"}
                </h2>
                <p className="mt-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                  {selectedNode
                    ? selectedNode.summary ?? "Node details will appear here."
                    : "Select a node to inspect it."}
                </p>
              </div>
            )}
          </div>

          {activeTab === "chat" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shell-scrollbar flex-1 overflow-y-auto px-5 py-5">
                {chatMessages.length === 0 ? (
                  <div className="space-y-6">
                    <div className="space-y-1">
                      <p className="text-[12px] font-medium tracking-[-0.01em] text-[var(--color-text-secondary)]">
                        Start with a scoped question.
                      </p>
                      <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
                        The conversation stays attached to the current workspace or selected node.
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
                                <div className="chat-section-row" key={`${message.id}-${section.label}`}>
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

              <div className="border-t border-[color:var(--color-border-faint)] px-5 py-4">
                <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
                  {getChatComposerCue(chatScope)}
                </p>
              </div>
            </div>
          ) : (
            <div className="shell-scrollbar flex-1 overflow-y-auto px-6 py-6">
              {selectedNode ? (
                <div className="space-y-6">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
                      Node
                    </p>
                    <div className="mt-4 grid gap-4">
                      <div className="context-detail-row">
                        <span className="context-detail-label">Type</span>
                        <span className="context-detail-value">{selectedNode.node_type}</span>
                      </div>
                      <div className="context-detail-row">
                        <span className="context-detail-label">Importance</span>
                        <span className="context-detail-value">{selectedNode.importance}</span>
                      </div>
                    </div>
                  </div>

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
                      Linked nodes
                    </p>
                    <div className="mt-4 space-y-3">
                      {linkedNodes.length > 0 ? (
                        linkedNodes.map(({ edgeTypes, node }) => (
                          <button
                            className="context-linked-node"
                            key={`${selectedNode.id}-${node.id}`}
                            onClick={() => onSelectLinkedNode(node.id)}
                            type="button"
                          >
                            <span className="context-linked-node-title">{node.title}</span>
                            <span className="context-linked-node-meta">
                              {edgeTypes.map((edgeType) => edgeType.replaceAll("_", " ")).join(" • ")}
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="text-[12px] leading-5 text-[var(--color-text-muted)]">
                          No linked nodes yet.
                        </p>
                      )}
                    </div>
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
