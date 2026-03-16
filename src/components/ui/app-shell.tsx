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
import { getImportanceLabel } from "@/lib/graph/importance";
import { ContextRail } from "@/components/panel/context-rail";
import { SystemPanel } from "@/components/panel/system-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { TopCommandBar } from "@/components/ui/top-command-bar";
import type { RailTab, ChatMessage, ChatScope } from "@/types/chat";
import type { CreateNodeInput, GraphData, Node, Workspace } from "@/types/graph";

type AuthUserState = {
  email: string | null;
  id: string;
};

type AppShellProps = {
  initialUser: AuthUserState;
};

const defaultCreateNodeDraft: CreateNodeInput = {
  custom_type: "",
  importance_index: 58,
  node_type: "concept",
  raw_text: "",
  summary: "",
  title: "",
};

const nodeColorByType: Record<Exclude<CreateNodeInput["node_type"], "custom">, string> = {
  class: "#96784d",
  concept: "#677480",
  goal: "#d8d0c4",
  project: "#8c4a57",
  task: "#a35258",
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
  const [createNodeDraft, setCreateNodeDraft] = useState<CreateNodeInput | null>(null);
  const [createNodeError, setCreateNodeError] = useState<string | null>(null);
  const [createNodeSubmitting, setCreateNodeSubmitting] = useState(false);

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
    setCreateNodeDraft(null);
    setCreateNodeError(null);
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
    if (nodeId) {
      setCreateNodeDraft(null);
      setCreateNodeError(null);
    }

    setSelectedNodeId(nodeId);

    if (nodeId) {
      setRightPanelOpen(true);
    }
  };

  const handleGraphSearchSubmit = () => {
    const matchingNode = findFirstMatchingNode(graphData, graphSearchValue);

    if (!matchingNode) {
      return;
    }

    setSelectedNodeId(matchingNode.id);
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setRightPanelOpen(true);
  };

  const handleOpenCreateNode = () => {
    setSystemPanelOpen(false);
    setWorkspaceMenuOpen(false);
    setSelectedNodeId(null);
    setActiveRailTab("details");
    setRightPanelOpen(false);
    setCreateNodeError(null);
    setCreateNodeDraft({ ...defaultCreateNodeDraft });
  };

  const handleChangeCreateNodeField = <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => {
    setCreateNodeDraft((currentDraft) => ({
      ...(currentDraft ?? defaultCreateNodeDraft),
      [field]: value,
    }));
  };

  const handleCloseCreateNode = () => {
    setCreateNodeDraft(null);
    setCreateNodeError(null);
  };

  const handleSubmitCreateNode = async () => {
    if (!supabase || !authUser?.id || !selectedWorkspaceId || !createNodeDraft) {
      setCreateNodeError("Workspace or auth context is unavailable.");
      return;
    }

    const title = createNodeDraft.title.trim();
    const resolvedNodeType =
      createNodeDraft.node_type === "custom"
        ? createNodeDraft.custom_type.trim()
        : createNodeDraft.node_type;

    if (title.length === 0) {
      setCreateNodeError("Title is required.");
      return;
    }

    if (resolvedNodeType.length === 0) {
      setCreateNodeError("Choose a node type or enter a custom type.");
      return;
    }

    setCreateNodeSubmitting(true);
    setCreateNodeError(null);

    const payload = {
      color:
        createNodeDraft.node_type === "custom"
          ? nodeColorByType.concept
          : nodeColorByType[createNodeDraft.node_type],
      importance: getImportanceLabel(createNodeDraft.importance_index),
      importance_index: createNodeDraft.importance_index,
      node_type: resolvedNodeType as Node["node_type"],
      raw_text: createNodeDraft.raw_text.trim() || null,
      summary: createNodeDraft.summary.trim() || null,
      title,
      user_id: authUser.id,
      workspace_id: selectedWorkspaceId,
    };

    const { data, error } = await supabase
      .from("nodes")
      .insert(payload)
      .select("*")
      .single();

    setCreateNodeSubmitting(false);

    if (error || !data) {
      setCreateNodeError(error?.message ?? "Unable to create node.");
      return;
    }

    const createdNode = data as Node;

    setGraphData((currentGraphData) => ({
      ...currentGraphData,
      nodes: [...currentGraphData.nodes, createdNode],
    }));
    setCreateNodeDraft(null);
    setCreateNodeError(null);
    setSelectedNodeId(createdNode.id);
    setRightPanelOpen(true);
    setActiveRailTab("details");
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
          createNodeDraft={createNodeDraft}
          createNodeError={createNodeError}
          createNodeSubmitting={createNodeSubmitting}
          graphData={graphData}
          graphLoading={graphLoading}
          graphSearchValue={graphSearchValue}
          onChangeCreateNodeField={handleChangeCreateNodeField}
          onCloseCreateNode={handleCloseCreateNode}
          onComposerChange={setComposerValue}
          onComposerSubmit={() => {
            void submitMessage(composerValue);
          }}
          onGraphSearchChange={setGraphSearchValue}
          onGraphSearchSubmit={handleGraphSearchSubmit}
          onOpenCreateNode={handleOpenCreateNode}
          onSelectNode={handleSelectNode}
          onSubmitCreateNode={() => {
            void handleSubmitCreateNode();
          }}
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
          onSelectLinkedNode={handleSelectNode}
          onToggle={() => setRightPanelOpen((open) => !open)}
          open={rightPanelOpen}
          selectedNode={selectedNode}
        />
      </div>
    </div>
  );
}
