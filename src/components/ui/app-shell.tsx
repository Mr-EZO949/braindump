"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { MainStage } from "@/components/graph/main-stage";
import {
  createAssistantReply,
  createNodeScope,
  createUserChatMessage,
  createWorkspaceScope,
  getChatComposerPlaceholder,
} from "@/lib/graph/chat";
import {
  buildChatNodeContext,
  findFirstMatchingNode,
  loadWorkspaceGraphData,
  loadWorkspaces,
} from "@/lib/graph/data";
import { demoGraphData } from "@/lib/graph/demo-data";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import type { RailTab, ChatMessage, ChatScope } from "@/types/chat";
import type { GraphData, Workspace } from "@/types/graph";

type AuthUserState = {
  email: string | null;
  id: string;
};

type AppShellProps = {
  initialUser: AuthUserState;
};

export function AppShell({ initialUser }: AppShellProps) {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [systemPanelOpen, setSystemPanelOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>("details");
  const [composerValue, setComposerValue] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatScope, setChatScope] = useState<ChatScope>(createWorkspaceScope("General"));
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<GraphData>(demoGraphData);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphSearchValue, setGraphSearchValue] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUserState | null>(initialUser);
  const [signingOut, setSigningOut] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const workspaceName = selectedWorkspace?.name ?? "General";

  const selectedNode = useMemo(
    () => buildChatNodeContext(graphData, selectedNodeId),
    [graphData, selectedNodeId],
  );

  const defaultChatScope = useMemo(
    () =>
      selectedNode
        ? createNodeScope(workspaceName, selectedNode)
        : createWorkspaceScope(workspaceName),
    [selectedNode, workspaceName],
  );

  useEffect(() => {
    let active = true;

    void loadWorkspaces(authUser?.id ?? null).then((nextWorkspaces) => {
      if (!active) {
        return;
      }

      setWorkspaces(nextWorkspaces);
      setSelectedWorkspaceId((currentWorkspaceId) => {
        if (
          currentWorkspaceId &&
          nextWorkspaces.some((workspace) => workspace.id === currentWorkspaceId)
        ) {
          return currentWorkspaceId;
        }

        return (
          nextWorkspaces.find((workspace) => workspace.name === "Personal")?.id ??
          nextWorkspaces.find((workspace) => workspace.name === "General")?.id ??
          nextWorkspaces[0]?.id ??
          null
        );
      });
    });

    return () => {
      active = false;
    };
  }, [authUser?.id]);

  useEffect(() => {
    let active = true;

    setGraphLoading(true);

    void loadWorkspaceGraphData(
      authUser?.id ?? null,
      selectedWorkspaceId,
      selectedWorkspace?.name ?? null,
    ).then((nextGraphData) => {
      if (!active) {
        return;
      }

      setGraphData(nextGraphData);
      setGraphLoading(false);
    });

    return () => {
      active = false;
    };
  }, [authUser?.id, selectedWorkspace?.name, selectedWorkspaceId]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active || error) {
        return;
      }

      setAuthUser(
        data.session?.user
          ? {
              email: data.session.user.email ?? null,
              id: data.session.user.id,
            }
          : null,
      );
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(
        session?.user
          ? {
              email: session.user.email ?? null,
              id: session.user.id,
            }
          : null,
      );
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (chatMessages.length === 0) {
      setChatScope(defaultChatScope);
    }
  }, [chatMessages.length, defaultChatScope]);

  useEffect(() => {
    setSelectedNodeId(null);
    setGraphSearchValue("");
    setComposerValue("");
    setChatMessages([]);
    setChatError(null);
    setChatScope(createWorkspaceScope(workspaceName));
  }, [workspaceName]);

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

  const handleSelectNode = (nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    setRightPanelOpen(true);
  };

  const handleGraphSearchSubmit = () => {
    const matchingNode = findFirstMatchingNode(graphData, graphSearchValue);

    if (!matchingNode) {
      return;
    }

    setSelectedNodeId(matchingNode.id);
    setRightPanelOpen(true);
  };

  const handleSignOut = async () => {
    if (!supabase || signingOut) {
      return;
    }

    setSigningOut(true);

    const { error } = await supabase.auth.signOut();

    setSigningOut(false);

    if (error) {
      return;
    }

    setSystemPanelOpen(false);
    router.replace("/login");
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
        onSelectWorkspace={(workspaceId) => {
          setSelectedWorkspaceId(workspaceId);
          setWorkspaceMenuOpen(false);
        }}
        selectedWorkspaceId={selectedWorkspaceId}
        systemPanelOpen={systemPanelOpen}
        workspaces={workspaces}
        workspaceMenuOpen={workspaceMenuOpen}
        workspaceName={workspaceName}
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

        <SystemPanel
          onClose={() => setSystemPanelOpen(false)}
          onSignOut={() => {
            void handleSignOut();
          }}
          open={systemPanelOpen}
          signingOut={signingOut}
          userEmail={authUser?.email ?? null}
        />
        <MainStage
          composerPlaceholder={
            activeRailTab === "chat"
              ? getChatComposerPlaceholder(chatScope)
              : "Add a thought or ask the graph..."
          }
          composerValue={composerValue}
          graphData={graphData}
          graphLoading={graphLoading}
          graphSearchValue={graphSearchValue}
          onComposerChange={setComposerValue}
          onComposerSubmit={() => {
            void submitMessage(composerValue);
          }}
          onGraphSearchChange={setGraphSearchValue}
          onGraphSearchSubmit={handleGraphSearchSubmit}
          onSelectNode={handleSelectNode}
          selectedNodeId={selectedNodeId}
          submitting={chatLoading}
        />
        <ContextRail
          activeTab={activeRailTab}
          chatError={chatError}
          chatLoading={chatLoading}
          chatMessages={chatMessages}
          chatScope={chatScope}
          graphData={graphData}
          onClearChatScope={() => setChatScope(createWorkspaceScope(workspaceName))}
          onRetryChat={retryLastMessage}
          onSelectPrompt={(prompt) => {
            void submitMessage(prompt);
          }}
          onSetActiveTab={setActiveRailTab}
          onSelectLinkedNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            setRightPanelOpen(true);
          }}
          onToggle={() => setRightPanelOpen((open) => !open)}
          open={rightPanelOpen}
          selectedNode={selectedNode}
        />
      </div>
    </div>
  );
}
