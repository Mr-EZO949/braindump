"use client";

// A turn's card in the thread (docs/unified-turn.md): posting one for a brain
// dump (or generated steps), and what its buttons do — Undo per section, Undo
// on applied priorities / the week, Undo on accepted rows, and answering a
// question the card asks.

import { clearFocusCache } from "@/components/ui/what-now-dialog";
import {
  appliedActionFromPayload,
  appliedUndoEndpoint,
  isCommitmentAction,
  isPlanAction,
  type AppliedMarkerPayload,
} from "@/lib/chat/applied-marker";
import { turnCardFromApplied } from "@/lib/chat/turn-marker";
import { undoAutoApplied } from "@/lib/graph/auto-apply-client";
import { clientDayHints } from "@/lib/habits/streak";
import type { AppliedAction, ChatMessage, TurnAddedStatus, TurnCardData, TurnSection } from "@/types/chat";
import type { DumpTurn } from "@/types/ai";

import type { ChatActions } from "./use-chat-actions";
import type { ChatThread } from "./use-chat-thread";
import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { PlannerSync, ShellPanels } from "./use-shell-ui";
import type { WorkspaceGraph } from "./use-workspace-graph";

/** What a dump's answer carries besides its turn: changes applied, and one waiting on a card. */
export interface DumpTurnExtras {
  priority_update?: (Omit<AppliedMarkerPayload, "tool_name"> & { unclear?: string[] }) | null;
  commitment_update?: Omit<AppliedMarkerPayload, "tool_name"> | null;
  pending_action?: {
    run_id: string;
    tool_use_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
  } | null;
}

export function useTurnCards({
  userId,
  workspaceId,
  thread,
  graph,
  analyzeNodes,
  submitMessage,
  panels,
  planner,
}: {
  userId: string | null;
  workspaceId: string | null;
  thread: Pick<
    ChatThread,
    "chatMessages" | "setChatMessages" | "startFreshThread" | "dumpInChatRef" | "chatLoading" | "chatSendingRef"
  >;
  graph: Pick<WorkspaceGraph, "setGraphData" | "loadGraph" | "refreshAfterPriorityChange" | "refreshClusters" | "reloadGraph">;
  analyzeNodes: ConnectionAnalysis["analyzeNodes"];
  submitMessage: ChatActions["submitMessage"];
  panels: Pick<ShellPanels, "openChatRail">;
  planner?: Pick<PlannerSync, "refreshPlanner">;
}) {
  const { chatMessages, setChatMessages, chatLoading, chatSendingRef } = thread;
  const { setGraphData, loadGraph, refreshAfterPriorityChange } = graph;

  // A brain dump handled as ONE turn: the dump, then ONE assistant message —
  // the reply to its human part, and one card with everything it changed.
  // No review modal, no toast, no separate cards (docs/unified-turn.md).
  const postTurn = async (
    rawText: string,
    turn: DumpTurn,
    data: DumpTurnExtras,
    targetWorkspaceId: string | null,
    continueThread: boolean,
  ) => {
    const priorityAction = data.priority_update
      ? appliedActionFromPayload({ ...data.priority_update, tool_name: "update_priorities" })
      : null;
    const commitmentAction = data.commitment_update
      ? appliedActionFromPayload({ ...data.commitment_update, tool_name: "set_commitments" })
      : null;
    if (commitmentAction && targetWorkspaceId) clearFocusCache(targetWorkspaceId);
    const waiting = data.pending_action ?? null;

    const card: TurnCardData = {
      ...(turnCardFromApplied(turn) ?? { added: [], addedStatus: "applied", done: [], links: [], questions: [] }),
      ...(commitmentAction ? { commitments: { ...commitmentAction, status: "applied" as const } } : {}),
    };
    const changedGraph = card.added.length > 0 || card.done.length > 0 || card.links.length > 0;
    const nothing = !changedGraph && card.questions.length === 0 && !priorityAction && !commitmentAction && !waiting;

    const nowIso = new Date().toISOString();
    const turnMessageId = `chat-turn-${Math.random().toString(36).slice(2, 10)}`;
    const turnMessage: ChatMessage = {
      id: turnMessageId,
      role: "assistant" as const,
      body: turn.reply ?? (nothing ? "I went through that and found nothing to add or change." : ""),
      createdAt: nowIso,
      status: "ready" as const,
      turn: card,
      ...(priorityAction ? { appliedAction: { ...priorityAction, status: "applied" as const } } : {}),
      ...(waiting
        ? {
            pendingAction: {
              runId: waiting.run_id,
              toolUseId: waiting.tool_use_id,
              toolName: waiting.tool_name,
              toolInput: waiting.tool_input,
              status: "awaiting" as const,
            },
          }
        : {}),
    };
    if (continueThread) {
      setChatMessages((prev) => [...prev, turnMessage]);
    } else {
      // #18: a dump from the Brain Dump box starts a FRESH chat thread (the
      // previous one is auto-saved).
      thread.startFreshThread();
      setChatMessages([
        {
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: rawText,
          createdAt: nowIso,
          status: "ready" as const,
        },
        turnMessage,
      ]);
    }
    thread.dumpInChatRef.current = true;
    panels.openChatRail();

    // The graph already changed on the server — show it.
    if (targetWorkspaceId && (changedGraph || priorityAction)) {
      if (priorityAction) {
        await refreshAfterPriorityChange(
          targetWorkspaceId,
          priorityAction.items.map((item) => item.nodeId),
        );
      } else if (userId) {
        try {
          setGraphData(await loadGraph(targetWorkspaceId));
        } catch {
          // The card still shows the change; the next load draws the nodes.
        }
      }
      if (card.added.length > 0) {
        graph.refreshClusters();
        // Links it notices land in this thread, not in a modal.
        void analyzeNodes(
          card.added.map((n) => n.id),
          targetWorkspaceId,
          turnMessageId,
        );
      }
    }
  };

  const undoChangeSteps = async (steps: unknown[]): Promise<boolean> => {
    if (!workspaceId) return false;
    try {
      const res = await fetch("/api/changes/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, steps }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { undone?: number };
      return (data.undone ?? 0) > 0;
    } catch {
      return false;
    }
  };

  // Undo on an applied priority card: the server restores exactly the fields
  // the change touched (lib/ai/tools/priority-mutations undoPriorityChanges).
  const undoAppliedAction = async (messageId: string, slot?: "commitments") => {
    // A brain-dump turn card holds two applied changes: the priority changes
    // (the message's own) and the weekly commitments (slot "commitments").
    const message = chatMessages.find((m) => m.id === messageId);
    const action = slot === "commitments" ? message?.turn?.commitments : message?.appliedAction;
    const targetWorkspaceId = workspaceId;
    if (!action || (action.status !== "applied" && action.status !== "error") || !targetWorkspaceId) return;

    const setStatus = (status: AppliedAction["status"], errorMessage?: string) =>
      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          if (slot === "commitments") {
            return m.turn?.commitments
              ? { ...m, turn: { ...m.turn, commitments: { ...m.turn.commitments, status, errorMessage } } }
              : m;
          }
          return m.appliedAction ? { ...m, appliedAction: { ...m.appliedAction, status, errorMessage } } : m;
        }),
      );

    setStatus("undoing");
    try {
      const res = await fetch(appliedUndoEndpoint(action), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: targetWorkspaceId, undo: action.undo, ...clientDayHints() }),
      });
      if (!res.ok) throw new Error("undo failed");
      setStatus("undone");
      if (isCommitmentAction(action)) clearFocusCache(targetWorkspaceId);
      // Back to the earlier plan — the Planner re-reads its tasks.
      if (isPlanAction(action)) planner?.refreshPlanner();
    } catch {
      setStatus("error", "Couldn't undo that — try again.");
    }
    void refreshAfterPriorityChange(
      targetWorkspaceId,
      action.items.map((item) => item.nodeId),
    );
  };

  // The Undo on one section of a turn card (Added / Marked done / Linked).
  // Cards from before 2026-10-02 carry no undo steps: their Added Undo goes
  // through the proposal ledger instead (and teaches the auto-apply calibration).
  const undoTurnSection = async (messageId: string, section: TurnSection) => {
    const turn = chatMessages.find((m) => m.id === messageId)?.turn;
    if (!turn) return;
    const statusKey = section === "added" ? "addedStatus" : section === "done" ? "doneStatus" : "linksStatus";
    const status = turn[statusKey] ?? "applied";
    if (status !== "applied" && status !== "error") return;
    const steps = turn.undo?.[section] ?? [];
    const proposalIds = section === "added" ? turn.added.flatMap((n) => (n.proposalId ? [n.proposalId] : [])) : [];
    if (steps.length === 0 && proposalIds.length === 0) return;
    const setStatus = (next: TurnAddedStatus) =>
      setChatMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.turn ? { ...m, turn: { ...m.turn, [statusKey]: next } } : m)),
      );
    setStatus("undoing");
    const ok = steps.length > 0 ? await undoChangeSteps(steps) : (await undoAutoApplied(proposalIds)).length > 0;
    setStatus(ok ? "undone" : "error");
    if (ok) await graph.reloadGraph();
  };

  // The Undo on a card's accepted rows (a reorganization, a suggestion OK'd).
  const undoAcceptedCard = async (messageId: string) => {
    const action = chatMessages.find((m) => m.id === messageId)?.pendingAction;
    if (!action || action.status !== "accepted" || !action.undo?.length) return;
    if (action.undoStatus && action.undoStatus !== "error") return;
    const setStatus = (undoStatus: TurnAddedStatus) =>
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.pendingAction ? { ...m, pendingAction: { ...m.pendingAction, undoStatus } } : m,
        ),
      );
    setStatus("undoing");
    const ok = await undoChangeSteps(action.undo);
    setStatus(ok ? "undone" : "error");
    if (ok) await graph.reloadGraph();
  };

  // A question on a brain-dump turn card, answered: the answer is an ordinary
  // chat message — the thread's note of the dump (turn-note.ts) tells the
  // model what was asked, so nothing synthetic is sent.
  const answerTurnQuestion = (messageId: string, questionIndex: number, answer: string) => {
    const turn = chatMessages.find((m) => m.id === messageId)?.turn;
    const question = turn?.questions[questionIndex];
    const text = answer.trim();
    if (!turn || !question || question.answer || !text || chatLoading || chatSendingRef.current) return;
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === messageId && m.turn
          ? {
              ...m,
              turn: {
                ...m.turn,
                questions: m.turn.questions.map((q, i) => (i === questionIndex ? { ...q, answer: text } : q)),
              },
            }
          : m,
      ),
    );
    // With several questions open, say which one this answers.
    const open = turn.questions.filter((q) => !q.answer).length;
    void submitMessage(open > 1 ? `About "${question.text}" — ${text}` : text);
  };

  return { postTurn, undoAppliedAction, undoTurnSection, undoAcceptedCard, answerTurnQuestion };
}

export type TurnCards = ReturnType<typeof useTurnCards>;
