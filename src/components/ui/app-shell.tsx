"use client";

import { useEffect, useMemo, useState } from "react";

import { MainStage } from "@/components/graph/main-stage";
import {
  createAssistantReply,
  createNodeScope,
  createUserChatMessage,
  createWorkspaceScope,
  getChatComposerPlaceholder,
} from "@/lib/graph/chat";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import type { RailTab, ChatMessage, ChatNodeContext, ChatScope } from "@/types/chat";

const workspaceName = "Personal";

export function AppShell() {
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [systemPanelOpen, setSystemPanelOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>("details");
  const [composerValue, setComposerValue] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatScope, setChatScope] = useState<ChatScope>(createWorkspaceScope(workspaceName));
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const selectedNode: ChatNodeContext | null = null;
  const defaultChatScope = useMemo(
    () =>
      selectedNode
        ? createNodeScope(workspaceName, selectedNode)
        : createWorkspaceScope(workspaceName),
    [selectedNode],
  );

  useEffect(() => {
    if (chatMessages.length === 0) {
      setChatScope(defaultChatScope);
    }
  }, [chatMessages.length, defaultChatScope]);

  const submitMessage = async (message: string, duplicateUserMessage = true) => {
    const trimmedMessage = message.trim();

    if (trimmedMessage.length === 0 || chatLoading) {
      return;
    }

    const nextScope = chatMessages.length === 0 ? defaultChatScope : chatScope;

    setRightPanelOpen(true);
    setActiveRailTab("chat");
    setChatScope(nextScope);
    setChatError(null);
    setComposerValue("");

    if (duplicateUserMessage) {
      setChatMessages((currentMessages) => [
        ...currentMessages,
        createUserChatMessage(trimmedMessage),
      ]);
    }

    setChatLoading(true);

    try {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 420);
      });

      setChatMessages((currentMessages) => [
        ...currentMessages,
        createAssistantReply(trimmedMessage, nextScope),
      ]);
    } catch {
      setChatError("Response unavailable. Try again.");
    } finally {
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

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
      <TopCommandBar
        onToggleSystemPanel={() => {
          setWorkspaceMenuOpen(false);
          setSystemPanelOpen((open) => !open);
        }}
        onToggleWorkspaceMenu={() => {
          setSystemPanelOpen(false);
          setWorkspaceMenuOpen((open) => !open);
        }}
        systemPanelOpen={systemPanelOpen}
        workspaceMenuOpen={workspaceMenuOpen}
      />

      <div className="relative flex h-[calc(100vh-64px)] min-h-0">
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

        <SystemPanel onClose={() => setSystemPanelOpen(false)} open={systemPanelOpen} />
        <MainStage
          composerPlaceholder={
            activeRailTab === "chat"
              ? getChatComposerPlaceholder(chatScope)
              : "Add a thought or ask the graph..."
          }
          composerValue={composerValue}
          onComposerChange={setComposerValue}
          onComposerSubmit={() => {
            void submitMessage(composerValue);
          }}
          submitting={chatLoading}
        />
        <ContextRail
          activeTab={activeRailTab}
          chatError={chatError}
          chatLoading={chatLoading}
          chatMessages={chatMessages}
          chatScope={chatScope}
          onClearChatScope={() => setChatScope(createWorkspaceScope(workspaceName))}
          onRetryChat={retryLastMessage}
          onSelectPrompt={(prompt) => {
            void submitMessage(prompt);
          }}
          onSetActiveTab={setActiveRailTab}
          onToggle={() => setRightPanelOpen((open) => !open)}
          open={rightPanelOpen}
          selectedNode={selectedNode}
        />
      </div>
    </div>
  );
}
