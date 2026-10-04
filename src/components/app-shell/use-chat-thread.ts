"use client";

// The chat thread in the rail: its messages and scope, kept per workspace in
// localStorage and saved as a session (debounced), the list of past sessions,
// and the in-flight flags every chat path shares.

import { useEffect, useMemo, useRef, useState } from "react";

import { createNodeScope, createWorkspaceScope } from "@/lib/graph/chat";
import { buildChatNodeContext } from "@/lib/graph/data";
import {
  deleteChatSession,
  listChatSessions,
  loadChatSession,
  upsertChatSession,
  type ChatSessionMeta,
} from "@/lib/chat/sessions";
import { readChatHistory, readChatSessionId, writeChatHistory, writeChatSessionId } from "@/lib/chat/thread-storage";
import type { ChatMessage, ChatNodeContext, ChatScope, Nudge } from "@/types/chat";
import type { GraphData } from "@/types/graph";

import type { ShellPanels } from "./use-shell-ui";

export function useChatThread({
  userId,
  workspaceId,
  workspaceName,
  selectedNode,
  graphData,
  panels,
}: {
  userId: string | null;
  workspaceId: string | null;
  workspaceName: string;
  selectedNode: ChatNodeContext | null;
  graphData: GraphData;
  panels: Pick<ShellPanels, "setActiveRailTab" | "setRightPanelOpen">;
}) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // The thread as of the last render — for async work that finishes later
  // (connection analysis) and must know whether its message is still shown.
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);
  const [chatScope, setChatScope] = useState<ChatScope>(createWorkspaceScope("General"));
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingActionBusy, setPendingActionBusy] = useState(false);
  const [railChatInput, setRailChatInput] = useState("");
  const chatAbortRef = useRef<AbortController | null>(null);

  // Chat history (persistent sessions)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSessionMeta[]>([]);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const chatSessionIdRef = useRef<string | null>(null);
  const chatSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous re-entry lock for the chat send + resume paths. State flags
  // (chatLoading / pendingActionBusy) update async, so two events in the same
  // tick could both pass the check and fire two API calls (#11 credit-burn).
  const chatSendingRef = useRef(false);
  // Whether the current brain-dump's text has already been echoed into chat.
  // applyDumpExtraction / the onboarding handoff set it true after echoing the
  // dump once; the clarifying-question flow reads it so it never re-echoes the
  // same dump (#11 duplication). Category-B openers (retry, legacy <nodes>)
  // that DON'T echo reset it to false so the clarifying flow echoes once.
  const dumpInChatRef = useRef(false);

  const defaultChatScope = useMemo(
    () => (selectedNode ? createNodeScope(workspaceName, selectedNode) : createWorkspaceScope(workspaceName)),
    [selectedNode, workspaceName],
  );

  // Keep chat scope in sync with node selection — when the user selects a
  // different node (or deselects), update the scope so the assistant always
  // has the right context.  This also covers the empty-messages case.
  useEffect(() => {
    setChatScope(defaultChatScope);
  }, [defaultChatScope]);

  useEffect(() => {
    // Workspace-switch reset. Keyed on the workspace id (stable across a
    // workspace's lifetime) rather than workspaceName — the latter briefly
    // resolves from "General" → the actual name during bootstrap, which would
    // re-run this effect mid-flow and wipe any in-flight chat messages (e.g.
    // inline answers from the proposed-nodes review) that hadn't been flushed
    // to localStorage yet. Must run before the two storage writers below.
    setRailChatInput("");
    setChatMessages(readChatHistory(userId, workspaceId));
    const storedSessionId = readChatSessionId(userId, workspaceId);
    setChatSessionId(storedSessionId);
    chatSessionIdRef.current = storedSessionId;
    setChatScope(createWorkspaceScope(workspaceName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    writeChatHistory(userId, workspaceId, chatMessages);
  }, [userId, workspaceId, chatMessages]);

  // Keep the ref + localStorage in sync so the debounced save reads the current
  // session id and reloads restore it across page refreshes.
  useEffect(() => {
    chatSessionIdRef.current = chatSessionId;
    writeChatSessionId(userId, workspaceId, chatSessionId);
  }, [chatSessionId, userId, workspaceId]);

  // Debounced persistence to Supabase — fires 800ms after the last change.
  useEffect(() => {
    if (!userId || !workspaceId) return;
    if (chatMessages.length === 0) return;

    if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
    chatSaveTimerRef.current = setTimeout(() => {
      // Fired → no longer pending (flushPendingChatSave keys off this ref).
      chatSaveTimerRef.current = null;
      void (async () => {
        const saved = await upsertChatSession({
          id: chatSessionIdRef.current,
          workspaceId,
          scope: chatScope,
          messages: chatMessages,
        });
        if (saved) {
          if (!chatSessionIdRef.current) {
            chatSessionIdRef.current = saved.id;
            setChatSessionId(saved.id);
          }
          setChatSessions((prev) => {
            const filtered = prev.filter((s) => s.id !== saved.id);
            return [{ ...(prev.find((s) => s.id === saved.id) ?? ({} as ChatSessionMeta)), ...saved }, ...filtered];
          });
        }
      })();
    }, 800);

    return () => {
      if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
      chatSaveTimerRef.current = null;
    };
  }, [userId, workspaceId, chatMessages, chatScope]);

  // Persist the current thread IMMEDIATELY if a debounced save is still
  // pending. Anything that switches threads (a dump starting a fresh thread,
  // "New chat", loading another session) used to just cancel the timer, which
  // silently dropped the last <800ms of messages. The session id is read
  // synchronously here, before callers null it for the new thread.
  const flushPendingChatSave = () => {
    const pending = chatSaveTimerRef.current;
    if (!pending) return;
    clearTimeout(pending);
    chatSaveTimerRef.current = null;
    if (!userId || !workspaceId || chatMessages.length === 0) return;
    void upsertChatSession({
      id: chatSessionIdRef.current,
      workspaceId,
      scope: chatScope,
      messages: chatMessages,
    }).then((saved) => {
      if (!saved) return;
      setChatSessions((prev) => [
        { ...(prev.find((s) => s.id === saved.id) ?? ({} as ChatSessionMeta)), ...saved },
        ...prev.filter((s) => s.id !== saved.id),
      ]);
    });
  };

  /**
   * Cut over to a new thread (the old one is saved first): no session yet,
   * workspace scope. The caller sets the new thread's messages.
   */
  const startFreshThread = () => {
    flushPendingChatSave();
    setChatSessionId(null);
    chatSessionIdRef.current = null;
    setChatScope(createWorkspaceScope(workspaceName));
  };

  // Load the list of past sessions when workspace changes. The workspace-switch
  // effect above already sets chatSessionId from localStorage, so we only
  // refresh the list here.
  useEffect(() => {
    if (!workspaceId) {
      setChatSessions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await listChatSessions(workspaceId);
      if (!cancelled) setChatSessions(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const startNewChat = () => {
    flushPendingChatSave();
    setChatMessages([]);
    setChatSessionId(null);
    chatSessionIdRef.current = null;
    setChatScope(createWorkspaceScope(workspaceName));
    setChatHistoryOpen(false);
  };

  const openChatSession = async (sessionId: string) => {
    const detail = await loadChatSession(sessionId);
    if (!detail) return;
    flushPendingChatSave();
    setChatSessionId(detail.id);
    chatSessionIdRef.current = detail.id;
    setChatMessages(detail.messages ?? []);
    if (detail.scope_kind === "node" && detail.scope_node_id) {
      const node = buildChatNodeContext(graphData, detail.scope_node_id);
      if (node) {
        setChatScope(createNodeScope(workspaceName, node));
      } else {
        setChatScope(createWorkspaceScope(workspaceName));
      }
    } else {
      setChatScope(createWorkspaceScope(workspaceName));
    }
    panels.setActiveRailTab("chat");
    panels.setRightPanelOpen(true);
    setChatHistoryOpen(false);
  };

  const removeChatSession = async (sessionId: string) => {
    const ok = await deleteChatSession(sessionId);
    if (!ok) return;
    setChatSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (sessionId === chatSessionIdRef.current) {
      setChatMessages([]);
      setChatSessionId(null);
      chatSessionIdRef.current = null;
    }
  };

  const clearChatScope = () => setChatScope(createWorkspaceScope(workspaceName));

  return {
    chatMessages,
    setChatMessages,
    chatMessagesRef,
    chatScope,
    setChatScope,
    defaultChatScope,
    chatLoading,
    setChatLoading,
    pendingActionBusy,
    setPendingActionBusy,
    railChatInput,
    setRailChatInput,
    chatAbortRef,
    chatSendingRef,
    dumpInChatRef,
    chatSessionId,
    chatSessions,
    chatHistoryOpen,
    setChatHistoryOpen,
    flushPendingChatSave,
    startFreshThread,
    startNewChat,
    openChatSession,
    removeChatSession,
    clearChatScope,
  };
}

export type ChatThread = ReturnType<typeof useChatThread>;

/** The empty chat's starter chips for this workspace (GET /api/assistant/nudges). */
export function useChatNudges(workspaceId: string | null) {
  const [nudges, setNudges] = useState<Nudge[]>([]);
  useEffect(() => {
    if (!workspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no workspace, no nudges
      setNudges([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/assistant/nudges?workspace_id=${encodeURIComponent(workspaceId)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { nudges?: Nudge[] };
        if (!cancelled) setNudges(data.nudges ?? []);
      } catch {
        // Nudges are optional — failing silently keeps the empty-state clean.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return nudges;
}
