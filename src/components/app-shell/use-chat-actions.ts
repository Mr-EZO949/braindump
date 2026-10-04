"use client";

// Sending a chat message and answering a card: the request, the streamed
// reply with its markers (a card waiting for OK, a change applied at once, a
// turn card, the Undo for accepted rows), and the graph refresh after.

import { clearFocusCache } from "@/components/ui/what-now-dialog";
import { createUserChatMessage } from "@/lib/graph/chat";
import { createAppliedMarkerParser, isCommitmentAction } from "@/lib/chat/applied-marker";
import { createPauseMarkerParser } from "@/lib/chat/pause-marker";
import { chatHistoryForModel, mergeTurnCards } from "@/lib/chat/thread-history";
import { createTurnMarkerParser, createUndoMarkerParser } from "@/lib/chat/turn-marker";
import type { AppliedAction, PendingAction, TurnCardData } from "@/types/chat";

import type { ChatThread } from "./use-chat-thread";
import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { PlannerSync, ShellPanels } from "./use-shell-ui";
import type { WorkspaceGraph } from "./use-workspace-graph";

// Chat tools that change the Planner's tasks.
const PLANNER_TOOLS = ["add_task_to_calendar", "reschedule_task", "mark_task_done"];

export function useChatActions({
  userId,
  workspaceId,
  thread,
  graph,
  analyzeNodes,
  panels,
  planner,
}: {
  userId: string | null;
  workspaceId: string | null;
  thread: ChatThread;
  graph: Pick<WorkspaceGraph, "graphData" | "setGraphData" | "loadGraph" | "refreshAfterPriorityChange">;
  analyzeNodes: ConnectionAnalysis["analyzeNodes"];
  panels: Pick<ShellPanels, "setRightPanelOpen" | "setActiveRailTab" | "setAppMode">;
  planner: Pick<PlannerSync, "refreshPlanner" | "setDraftPlanHint" | "setDraftPlanRefreshKey">;
}) {
  const {
    chatMessages,
    setChatMessages,
    chatScope,
    setChatScope,
    defaultChatScope,
    chatLoading,
    setChatLoading,
    pendingActionBusy,
    setPendingActionBusy,
    setRailChatInput,
    chatAbortRef,
    chatSendingRef,
  } = thread;
  const { graphData, setGraphData, loadGraph, refreshAfterPriorityChange } = graph;

  // Streams /api/assistant/chat (or /resume) into the assistant bubble.
  // Handles the <<BRAINDUMP_PAUSE>> marker: when seen, attaches a pending
  // action to the bubble so the user gets an inline Accept/Reject card.
  // Also runs the <recompute_scores/> post-
  // processing on the marker-stripped final text.
  const consumeAssistantStream = async (
    res: Response,
    assistantMsgId: string,
    targetWorkspaceId: string | null,
    appendToExistingBody = false,
  ) => {
    if (!res.ok || !res.body) {
      throw new Error("Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createPauseMarkerParser();
    // Chained after the pause parser: a change chat already applied
    // (update_priorities) arrives as its own marker → applied card + Undo;
    // a change / build_graph call's turn card (what applied now, with Undo);
    // the Undo for the rows a card's Accept just applied.
    const appliedParser = createAppliedMarkerParser();
    const turnParser = createTurnMarkerParser();
    const undoParser = createUndoMarkerParser();
    const turnAddedIds = new Set<string>();
    let turnChanged = false;
    let cleanText = "";
    let sawPause = false;
    const appliedNodeIds = new Set<string>();

    // Snapshot the pre-stream body once so appends don't accumulate on top
    // of their own prior output. Each write then sets body = base + stream.
    const baseBody = appendToExistingBody
      ? (chatMessages.find((m) => m.id === assistantMsgId)?.body.trimEnd() ?? "")
      : "";

    const writeBody = (nextCleanText: string) => {
      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          if (appendToExistingBody) {
            const joiner = baseBody.length > 0 && nextCleanText.length > 0 ? "\n\n" : "";
            return { ...m, body: baseBody + joiner + nextCleanText };
          }
          return { ...m, body: nextCleanText };
        }),
      );
    };

    const attachPending = (action: PendingAction) => {
      setChatMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, pendingAction: action } : m)));
    };

    const attachApplied = (applied: Omit<AppliedAction, "status">) => {
      for (const item of applied.items) appliedNodeIds.add(item.nodeId);
      // Busy time changed — Focus's cached list no longer knows it.
      if (isCommitmentAction(applied) && workspaceId) clearFocusCache(workspaceId);
      setChatMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, appliedAction: { ...applied, status: "applied" } } : m)),
      );
    };

    const attachTurn = (card: TurnCardData) => {
      for (const node of card.added) turnAddedIds.add(node.id);
      turnChanged = true;
      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          if (!m.turn) return { ...m, turn: card };
          // A second change in the same reply: one card, sections joined.
          return { ...m, turn: mergeTurnCards(m.turn, card) };
        }),
      );
    };

    const attachUndo = (steps: unknown[]) => {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId && m.pendingAction ? { ...m, pendingAction: { ...m.pendingAction, undo: steps } } : m,
        ),
      );
    };

    const takeText = (text: string) => {
      const afterUndo = undoParser.push(text);
      if (afterUndo.marker) attachUndo(afterUndo.marker);
      const afterTurn = turnParser.push(afterUndo.text);
      if (afterTurn.marker) attachTurn(afterTurn.marker);
      const next = appliedParser.push(afterTurn.text);
      if (next.marker) attachApplied(next.marker);
      if (next.text.length > 0) {
        cleanText += next.text;
        writeBody(cleanText);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const parsed = parser.push(chunk);
      takeText(parsed.text);
      if (parsed.pause && !sawPause) {
        sawPause = true;
        attachPending({ ...parsed.pause, status: "awaiting" });
      }
    }
    takeText(parser.flush().text);
    // Drain the chained parsers in order (undo → turn → applied).
    let rest = undoParser.flush().text;
    rest = turnParser.push(rest).text + turnParser.flush().text;
    rest = appliedParser.push(rest).text + appliedParser.flush().text;
    if (rest.length > 0) {
      cleanText += rest;
      writeBody(cleanText);
    }

    // A chat change applied at once: show it on the graph now, and look for
    // links around the new nodes — the same follow-up a dump gets.
    if (turnChanged && targetWorkspaceId && userId) {
      void loadGraph(targetWorkspaceId)
        .then((next) => setGraphData(next))
        .catch(() => {
          // The next load catches up.
        });
      if (turnAddedIds.size > 0) void analyzeNodes([...turnAddedIds], targetWorkspaceId, assistantMsgId);
    }

    // The graph already changed — resize the nodes now and pulse the ones
    // that moved, so the rerank is visible where the user is looking.
    if (appliedNodeIds.size > 0 && targetWorkspaceId) {
      void refreshAfterPriorityChange(targetWorkspaceId, [...appliedNodeIds]);
    }

    if (sawPause) return;

    // <recompute_scores/> — only when we reached end_turn (no pause).
    if (/<recompute_scores\s*\/?>/.test(cleanText) && targetWorkspaceId) {
      cleanText = cleanText.replace(/<recompute_scores\s*\/?>/g, "").trimEnd();
      writeBody(cleanText);

      fetch("/api/nodes/scores/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: targetWorkspaceId }),
      })
        .then(async (scoreRes) => {
          if (scoreRes.ok) {
            const nextGraphData = await loadGraph(targetWorkspaceId);
            setGraphData(nextGraphData);
          }
        })
        .catch(() => {
          // Score recompute failed silently
        });
    }
  };

  const submitMessage = async (message: string, duplicateUserMessage = true) => {
    const trimmedMessage = message.trim();

    // chatLoading is async state; chatSendingRef is a synchronous lock so two
    // events in the same tick (e.g. Enter + click) can't fire two POSTs and
    // duplicate the message / double-bill (#11).
    if (trimmedMessage.length === 0 || chatLoading || chatSendingRef.current) {
      return;
    }
    chatSendingRef.current = true;
    // Everything after taking the lock runs inside try/finally, so no failure
    // path can leave chat permanently locked.
    const assistantMsgId = `chat-${Math.random().toString(36).slice(2, 10)}`;
    const abortCtrl = new AbortController();

    try {
      const nextScope = chatMessages.length === 0 ? defaultChatScope : chatScope;
      const targetWorkspaceId = workspaceId;

      panels.setRightPanelOpen(true);
      panels.setActiveRailTab("chat");
      setChatScope(nextScope);
      setRailChatInput("");

      setChatMessages((prev) => [
        ...prev,
        ...(duplicateUserMessage ? [createUserChatMessage(trimmedMessage)] : []),
        {
          id: assistantMsgId,
          role: "assistant" as const,
          body: "",
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        },
      ]);

      setChatLoading(true);

      // Prior turns in this thread — a card's note stands in for its text.
      const history = chatHistoryForModel(chatMessages, new Map(graphData.nodes.map((n) => [n.id, n.title])));

      chatAbortRef.current = abortCtrl;

      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage,
          workspace_id: targetWorkspaceId,
          selected_node_id: nextScope.kind === "node" ? nextScope.node.id : null,
          history,
        }),
        signal: abortCtrl.signal,
      });

      await consumeAssistantStream(res, assistantMsgId, targetWorkspaceId);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        setChatMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsgId) return m;
            const body = m.body.trim().length > 0 ? m.body : "Stopped.";
            return { ...m, body, status: "ready" as const };
          }),
        );
      } else {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, body: "Response unavailable. Try again.", status: "error" as const } : m,
          ),
        );
      }
    } finally {
      if (chatAbortRef.current === abortCtrl) chatAbortRef.current = null;
      chatSendingRef.current = false;
      setChatLoading(false);
    }
  };

  const cancelChat = () => {
    chatAbortRef.current?.abort();
  };

  const resolvePendingAction = async (
    messageId: string,
    decision: "accept" | "reject" | "choice",
    choice?: string,
    // A change-set card accepted in part: the rows the user kept.
    acceptedIndexes?: number[],
  ) => {
    // pendingActionBusy is async state; chatSendingRef is the synchronous lock
    // so a rapid double-click can't fire two resume POSTs (#11 credit-burn).
    if (pendingActionBusy || chatSendingRef.current) return;

    const target = chatMessages.find((m) => m.id === messageId);
    const action = target?.pendingAction;
    if (!action || action.status !== "awaiting") return;

    const targetWorkspaceId = workspaceId;
    // When the server runs an accepted plan_day: a plan with no start time
    // starts then, and the Planner lands it there.
    const acceptedAt = Date.now();

    chatSendingRef.current = true;
    // As in submitMessage: everything after taking the lock is inside
    // try/finally so no failure path can leave chat locked.
    const abortCtrl = new AbortController();

    try {
      setPendingActionBusy(true);
      setChatLoading(true);
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.pendingAction
            ? {
                ...m,
                pendingAction: {
                  ...m.pendingAction,
                  // Accept shows "Applying…" until the server has done it.
                  status: decision === "reject" ? "rejected" : decision === "accept" ? "applying" : "accepted",
                  ...(decision === "accept" && acceptedIndexes ? { acceptedIndexes } : {}),
                },
              }
            : m,
        ),
      );

      chatAbortRef.current = abortCtrl;

      const res = await fetch("/api/assistant/chat/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: action.runId,
          decision,
          choice,
          ...(decision === "accept" && acceptedIndexes ? { accepted_indexes: acceptedIndexes } : {}),
        }),
        signal: abortCtrl.signal,
      });

      const markApplied = () =>
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.pendingAction?.status === "applying"
              ? { ...m, pendingAction: { ...m.pendingAction, status: "accepted" } }
              : m,
          ),
        );
      // The server applies the accepted action BEFORE it answers. When a
      // follow-up answer streams after it (seconds of text), show the change
      // now instead of after the last word — "mark X done" used to land on
      // the graph only once the reply to the rest of the message was over.
      // The graph is loaded again below: the follow-up can change more.
      let graphLoadedAfterReply = false;
      if (decision === "accept" && res.ok && res.headers.get("X-Resume-Model") !== "none") {
        markApplied();
        if (targetWorkspaceId && userId) {
          void loadGraph(targetWorkspaceId)
            .then((next) => {
              if (!graphLoadedAfterReply) setGraphData(next);
            })
            .catch(() => {
              // The load after the reply catches up.
            });
        }
      }

      await consumeAssistantStream(res, messageId, targetWorkspaceId, true);
      if (decision === "accept") markApplied();

      // If the user accepted a graph-changing tool, refresh the graph.
      if (decision === "accept" && targetWorkspaceId && userId) {
        const prevNodeIds = new Set(graphData.nodes.map((n) => n.id));
        const nextGraphData = await loadGraph(targetWorkspaceId);
        graphLoadedAfterReply = true;
        setGraphData(nextGraphData);

        // Parity with the braindump pipeline: any node the assistant just
        // created is run through connection inference so it links to the
        // nodes that logically make sense (surfaced in the edge-review
        // modal), instead of floating disconnected. No new nodes (e.g. an
        // accepted complete_node / propose_edge) → analyzeNodes no-ops.
        const newNodeIds = nextGraphData.nodes.filter((n) => !prevNodeIds.has(n.id)).map((n) => n.id);
        if (newNodeIds.length > 0) {
          void analyzeNodes(newNodeIds, targetWorkspaceId, messageId);
        }

        // If the accepted tool mutated calendar tasks, the planner's persisted
        // tasks are now stale — bump the refresh key so AssistantMode re-fetches.
        if (action.toolName && PLANNER_TOOLS.includes(action.toolName)) {
          planner.refreshPlanner();
        }

        // A chat-generated plan (plan_day) is drafted server-side but invisible
        // until the planner loads it. Switch to the planner and pull the draft
        // into its review UI so the user actually sees what was generated (#6).
        if (action.toolName === "plan_day") {
          panels.setAppMode("assistant");
          planner.setDraftPlanHint({
            startTime: action.toolInput?.start_time,
            busy: action.toolInput?.busy,
            window: action.toolInput?.window,
            acceptedAt,
          });
          planner.setDraftPlanRefreshKey((v) => v + 1);
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        // Abort mid-resume — leave the card state as-is (already accepted/rejected)
        // and just stop the follow-up text.
      } else {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.pendingAction
              ? {
                  ...m,
                  pendingAction: {
                    ...m.pendingAction,
                    status: "error",
                    errorMessage: "Could not complete the action. Try again.",
                  },
                }
              : m,
          ),
        );
      }
    } finally {
      if (chatAbortRef.current === abortCtrl) chatAbortRef.current = null;
      chatSendingRef.current = false;
      setPendingActionBusy(false);
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

  return { submitMessage, cancelChat, resolvePendingAction, retryLastMessage };
}

export type ChatActions = ReturnType<typeof useChatActions>;
