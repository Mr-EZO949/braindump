"use client";

// A brain dump, from the Brain Dump box or typed in chat: submit it, show its
// progress while /api/entries streams, retry a failed one, and land the answer
// — ONE turn card (docs/unified-turn.md), or the older proposals review with
// calibrated auto-apply and its one-tap Undo.

import { useCallback, useState } from "react";

import type { DumpProgressState } from "@/components/ui/dump-progress";
import { clearFocusCache } from "@/components/ui/what-now-dialog";
import { appliedActionFromPayload } from "@/lib/chat/applied-marker";
import { dumpSummaryText } from "@/lib/chat/dump-summary";
import { readDumpResponse } from "@/lib/chat/dump-stream";
import { dumpHistoryForEntries } from "@/lib/chat/thread-history";
import { acceptProposalsNow, undoAutoApplied } from "@/lib/graph/auto-apply-client";
import { createUserChatMessage } from "@/lib/graph/chat";
import { looksLikeBrainDump } from "@/lib/graph/dump-heuristic";
import { withoutNodes } from "@/lib/graph/graph-patches";
import type { DumpTurn, ProposedNode } from "@/types/ai";

import type { ChatActions } from "./use-chat-actions";
import type { ChatThread } from "./use-chat-thread";
import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { ProposalReview } from "./use-proposal-review";
import type { ShellPanels } from "./use-shell-ui";
import type { DumpTurnExtras, TurnCards } from "./use-turn-cards";
import type { WorkspaceGraph } from "./use-workspace-graph";

/** What /api/entries answers for a dump. */
type DumpAnswer = DumpTurnExtras & {
  proposed_nodes?: ProposedNode[];
  clarifying_questions?: string[];
  completed_existing_node_titles?: string[];
  suggested_areas?: Array<{ title: string; area_type: string }>;
  auto_apply_proposal_ids?: string[];
  // The dump handled as ONE turn (docs/unified-turn.md): what it added,
  // finished and linked, the reply to its human part, open questions.
  turn?: DumpTurn;
};

export function useBrainDump({
  workspaceId,
  thread,
  graph,
  postTurn,
  proposals,
  analyzeNodes,
  submitMessage,
  panels,
  showToast,
}: {
  workspaceId: string | null;
  thread: Pick<
    ChatThread,
    "chatMessages" | "setChatMessages" | "startFreshThread" | "dumpInChatRef" | "chatSendingRef" | "chatLoading" | "setChatLoading" | "setRailChatInput"
  >;
  graph: Pick<WorkspaceGraph, "setGraphData" | "refreshAfterPriorityChange" | "refreshClusters">;
  postTurn: TurnCards["postTurn"];
  proposals: Pick<ProposalReview, "mergeAcceptedIntoGraph" | "openReview">;
  analyzeNodes: ConnectionAnalysis["analyzeNodes"];
  submitMessage: ChatActions["submitMessage"];
  panels: Pick<ShellPanels, "setRightPanelOpen" | "setActiveRailTab">;
  showToast: (message: string) => void;
}) {
  const { chatMessages, setChatMessages, chatSendingRef, setChatLoading } = thread;
  const [brainDumpOpen, setBrainDumpOpen] = useState(false);
  // Workspace captured at open time — stays fixed even if the user switches workspace mid-dump.
  const [brainDumpWorkspaceId, setBrainDumpWorkspaceId] = useState<string | null>(null);
  const [brainDumpValue, setBrainDumpValue] = useState("");
  const [brainDumpSubmitting, setBrainDumpSubmitting] = useState(false);
  // Where a submitted dump is (box or chat) — streamed by /api/entries.
  const [dumpProgress, setDumpProgress] = useState<DumpProgressState | null>(null);
  const [brainDumpRetrying, setBrainDumpRetrying] = useState(false);
  const [brainDumpError, setBrainDumpError] = useState<string | null>(null);
  const [brainDumpFailedEntryId, setBrainDumpFailedEntryId] = useState<string | null>(null);
  // Calibrated auto-apply: what was added without review, for one-tap Undo.
  const [autoApplyUndo, setAutoApplyUndo] = useState<{
    proposalIds: string[];
    nodeIds: string[];
    count: number;
  } | null>(null);

  // Shared tail for every dump (button, chat): one turn card, or — for an
  // answer without a turn — mirror the dump + a summary into a fresh thread,
  // auto-apply what this user reliably accepts, and review the rest.
  const applyDumpExtraction = async (
    rawText: string,
    data: DumpAnswer,
    targetWorkspaceId: string | null,
    // From the chat composer: the dump continues the current thread (its
    // message is already shown) instead of opening a fresh one.
    opts?: { continueThread?: boolean },
  ) => {
    if (data.turn) {
      await postTurn(rawText, data.turn, data, targetWorkspaceId, opts?.continueThread ?? false);
      return;
    }
    const nodes = data.proposed_nodes ?? [];
    const questions = data.clarifying_questions ?? [];
    const completedTitles = data.completed_existing_node_titles ?? [];
    const areas = data.suggested_areas ?? [];
    const autoIds = (data.auto_apply_proposal_ids ?? []).filter((id) => nodes.some((n) => n.id === id));
    // Dump → priorities: shown as the same applied card chat uses, with Undo.
    const priorityAction = data.priority_update
      ? appliedActionFromPayload({ ...data.priority_update, tool_name: "update_priorities" })
      : null;
    const unclear = data.priority_update?.unclear ?? [];
    // Dump → fixed commitments: their own card (a message can hold one).
    const commitmentAction = data.commitment_update
      ? appliedActionFromPayload({ ...data.commitment_update, tool_name: "set_commitments" })
      : null;
    if (commitmentAction && targetWorkspaceId) clearFocusCache(targetWorkspaceId);
    // Dump → a restructure of existing nodes: the same Accept card chat shows.
    const restructure = data.pending_action ?? null;

    const buildSummary = (appliedCount: number, reviewCount: number) =>
      dumpSummaryText({
        appliedCount,
        reviewCount,
        completedTitles,
        questionCount: questions.length,
        priorityChanged: Boolean(priorityAction),
        otherChange: Boolean(commitmentAction || restructure),
        unclear,
      });

    const nowIso = new Date().toISOString();
    const summaryId = `chat-extract-${Math.random().toString(36).slice(2, 10)}`;
    // #18: a dump starts a FRESH chat thread — the previous conversation is
    // already auto-saved, so cut the session over and REPLACE the visible
    // messages instead of appending. #11: this echoes the dump text exactly
    // once, and dumpInChatRef=true tells the clarifying-question flow not to
    // echo it a second time. The old thread is flushed first, so it's
    // genuinely saved before we cut over. Posted BEFORE auto-apply so the
    // roadmap prompt it may add lands after the summary, not wiped by it.
    thread.startFreshThread();
    setChatMessages([
      {
        id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
        role: "user" as const,
        body: rawText,
        createdAt: nowIso,
        status: "ready" as const,
      },
      {
        id: summaryId,
        role: "assistant" as const,
        body: buildSummary(autoIds.length, nodes.length - autoIds.length),
        createdAt: nowIso,
        status: "ready" as const,
        ...(priorityAction ? { appliedAction: { ...priorityAction, status: "applied" as const } } : {}),
      },
      ...(commitmentAction
        ? [
            {
              id: `chat-commit-${Math.random().toString(36).slice(2, 10)}`,
              role: "assistant" as const,
              body: "And your week:",
              createdAt: nowIso,
              status: "ready" as const,
              appliedAction: { ...commitmentAction, status: "applied" as const },
            },
          ]
        : []),
      ...(restructure
        ? [
            {
              id: `chat-restructure-${Math.random().toString(36).slice(2, 10)}`,
              role: "assistant" as const,
              body: "You also asked to reorganize what's already there — here's the change:",
              createdAt: nowIso,
              status: "ready" as const,
              pendingAction: {
                runId: restructure.run_id,
                toolUseId: restructure.tool_use_id,
                toolName: restructure.tool_name,
                toolInput: restructure.tool_input,
                status: "awaiting" as const,
              },
            },
          ]
        : []),
    ]);
    thread.dumpInChatRef.current = true;
    panels.setRightPanelOpen(true);
    panels.setActiveRailTab("chat");

    // Calibrated auto-apply (src/lib/ai/auto-apply.ts): the proposals this user
    // reliably accepts go straight into the graph through the normal review
    // route, with a one-tap Undo — no modal. Only the rest need a look.
    let appliedIds = new Set<string>();
    if (autoIds.length > 0) {
      const batch = await acceptProposalsNow(autoIds);
      if (batch && batch.acceptedNodes.length > 0) {
        appliedIds = new Set(autoIds);
        graph.refreshClusters();
        proposals.mergeAcceptedIntoGraph(batch.acceptedNodes, batch.acceptedEdges);
        const createdIds = batch.acceptedNodes.map((n) => n.id);
        if (targetWorkspaceId) void analyzeNodes(createdIds, targetWorkspaceId);
        setAutoApplyUndo({ proposalIds: autoIds, nodeIds: createdIds, count: createdIds.length });
      } else {
        // Couldn't apply — fall back to reviewing everything, and say so.
        setChatMessages((prev) =>
          prev.map((m) => (m.id === summaryId ? { ...m, body: buildSummary(0, nodes.length) } : m)),
        );
      }
    }

    if (priorityAction && targetWorkspaceId) {
      void graph.refreshAfterPriorityChange(
        targetWorkspaceId,
        priorityAction.items.map((item) => item.nodeId),
      );
    }

    const remaining = nodes.filter((n) => !appliedIds.has(n.id));
    if (remaining.length > 0 || questions.length > 0) {
      proposals.openReview({ nodes: remaining, questions, areas, rawText });
    }
  };

  // Stable so the notice's auto-dismiss timer isn't reset on every render.
  const dismissAutoApplyNotice = useCallback(() => setAutoApplyUndo(null), []);

  // One-tap Undo for auto-applied proposals: remove the nodes and teach the
  // calibration that this kind of proposal needs review for this user.
  const undoAutoApply = async () => {
    const pending = autoApplyUndo;
    if (!pending) return;
    setAutoApplyUndo(null);
    const removedIds = new Set(await undoAutoApplied(pending.proposalIds));
    if (removedIds.size === 0) {
      showToast("Couldn't undo — those items may have changed.");
      return;
    }
    graph.setGraphData((prev) => withoutNodes(prev, removedIds));
    showToast(`Removed ${removedIds.size} item${removedIds.size === 1 ? "" : "s"}.`);
  };

  // A dump typed in the chat composer: the same turn as the Brain Dump box —
  // one reply and one card — but it continues THIS thread, and the reply sees
  // the conversation so far.
  const submitDumpFromChat = async (text: string) => {
    const trimmed = text.trim();
    const targetWorkspaceId = workspaceId;
    if (!trimmed || !targetWorkspaceId || chatSendingRef.current) return;
    chatSendingRef.current = true;
    const history = dumpHistoryForEntries(chatMessages);
    panels.setRightPanelOpen(true);
    panels.setActiveRailTab("chat");
    setChatMessages((prev) => [...prev, createUserChatMessage(trimmed)]);
    setChatLoading(true);
    const fail = (body: string) =>
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-err-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body,
          createdAt: new Date().toISOString(),
          status: "error" as const,
        },
      ]);
    // The wait is counted from the send, not from the first line back.
    const startedAt = Date.now();
    setDumpProgress({ stage: "reading", startedAt });
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: trimmed,
          workspace_id: targetWorkspaceId,
          history,
          stream: true,
        }),
      });
      const { status, data } = await readDumpResponse<DumpAnswer & { error?: string; message?: string }>(res, (stage) =>
        setDumpProgress({ stage, startedAt }),
      );
      if (status >= 300 || status === 207) {
        fail(data.error ?? data.message ?? "I couldn't work through that just now. Try again or rephrase it.");
        return;
      }
      await applyDumpExtraction(trimmed, data as DumpAnswer, targetWorkspaceId, {
        continueThread: true,
      });
    } catch {
      fail("Network error processing that. Try again.");
    } finally {
      chatSendingRef.current = false;
      setChatLoading(false);
      setDumpProgress(null);
    }
  };

  // A message typed in the rail's composer. One that reads like a brain dump
  // is ONE turn in this thread — reply + card, the same as the Brain Dump box
  // (docs/unified-turn.md); there is no "dump or chat?" chooser any more. The
  // cheap regex gates; Haiku confirms (~$0.0004) so a multi-clause question
  // doesn't pay for a graph-builder call.
  const submitChatInput = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (!thread.chatLoading && looksLikeBrainDump(trimmed)) {
      thread.setRailChatInput("");
      void (async () => {
        let isDump = true; // fail-safe: a dump turn also answers questions
        try {
          const res = await fetch("/api/assistant/classify-dump", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: trimmed }),
          });
          if (res.ok) {
            const data = (await res.json()) as { is_dump?: boolean };
            isDump = data.is_dump !== false;
          }
        } catch {
          // Network error: keep the fail-safe.
        }
        if (isDump) void submitDumpFromChat(trimmed);
        else void submitMessage(trimmed);
      })();
      return;
    }
    void submitMessage(message);
  };

  // A fresh dump, or (retryEntryId) the failed one again: the same one turn —
  // reply, card, progress. Until 2026-10-03 a retry opened the old review
  // modal and dropped any reorganization the dump asked for.
  const submitBrainDump = async (retryEntryId?: string) => {
    const trimmed = brainDumpValue.trim();
    // Use the workspace captured at open time, not the current selection.
    const targetWorkspaceId = brainDumpWorkspaceId ?? workspaceId;
    if ((!trimmed && !retryEntryId) || brainDumpSubmitting || !targetWorkspaceId) return;

    setBrainDumpSubmitting(true);
    if (retryEntryId) setBrainDumpRetrying(true);
    setBrainDumpError(null);
    setBrainDumpFailedEntryId(null);
    const startedAt = Date.now();
    setDumpProgress({ stage: "reading", startedAt });
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: trimmed,
          workspace_id: targetWorkspaceId,
          stream: true,
          ...(retryEntryId ? { retry_entry_id: retryEntryId } : {}),
        }),
      });
      const read = await readDumpResponse<
        DumpAnswer & {
          raw_entry_id?: string;
          error?: string;
          message?: string;
        }
      >(res, (stage) => setDumpProgress({ stage, startedAt }));
      const data = read.data;
      if (read.status >= 300) {
        setBrainDumpError(data.error ?? data.message ?? "Could not process that brain dump.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? null);
        return;
      }
      if (read.status === 207) {
        setBrainDumpError(data.error ?? data.message ?? "Extraction failed. Retry when ready.");
        setBrainDumpFailedEntryId(data.raw_entry_id ?? null);
        return;
      }

      setBrainDumpValue("");
      setBrainDumpOpen(false);
      setBrainDumpError(null);
      setBrainDumpFailedEntryId(null);
      await applyDumpExtraction(trimmed, data, targetWorkspaceId);
    } catch (err) {
      setBrainDumpError(err instanceof Error ? err.message : "Could not process that brain dump.");
    } finally {
      setBrainDumpSubmitting(false);
      setBrainDumpRetrying(false);
      setDumpProgress(null);
    }
  };

  const retryBrainDump = async () => {
    if (!brainDumpFailedEntryId || brainDumpRetrying) return;
    await submitBrainDump(brainDumpFailedEntryId);
  };

  // The box opens on the workspace in view and keeps it, even if the user
  // switches mid-dump.
  const openBrainDump = () => {
    setBrainDumpError(null);
    setBrainDumpFailedEntryId(null);
    setBrainDumpWorkspaceId(workspaceId);
    setBrainDumpOpen(true);
  };

  const closeBrainDump = () => {
    setBrainDumpOpen(false);
    setBrainDumpWorkspaceId(null);
    setBrainDumpValue("");
    setBrainDumpError(null);
    setBrainDumpFailedEntryId(null);
  };

  return {
    brainDumpOpen,
    brainDumpValue,
    setBrainDumpValue,
    brainDumpSubmitting,
    brainDumpRetrying,
    brainDumpError,
    brainDumpFailedEntryId,
    dumpProgress,
    autoApplyUndo,
    dismissAutoApplyNotice,
    undoAutoApply,
    submitChatInput,
    submitBrainDump,
    retryBrainDump,
    openBrainDump,
    closeBrainDump,
  };
}

export type BrainDump = ReturnType<typeof useBrainDump>;
