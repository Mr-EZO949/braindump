"use client";

// Breaking things into steps: the "Break these into steps?" picker, steps for
// one node from its details panel, the "break it down?" chooser a big-looking
// new task gets, and cancelling a slow generation. Generated steps land as ONE
// card in a fresh thread (postTurn); nothing changes until Apply.

import { useRef, useState } from "react";

import { classifyTaskSize } from "@/lib/ai/sizing";
import type { Node } from "@/types/graph";

import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { ShellPanels } from "./use-shell-ui";
import type { TurnCards } from "./use-turn-cards";
import type { WorkspaceGraph } from "./use-workspace-graph";

export interface StepSuggestionNode {
  id: string;
  title: string;
  summary: string | null;
  node_type: string;
  selected: boolean;
}

export function useStepSuggestions({
  workspaceId,
  graph,
  postTurn,
  analyzeNodes,
  panels,
}: {
  workspaceId: string | null;
  graph: Pick<WorkspaceGraph, "graphData">;
  postTurn: TurnCards["postTurn"];
  analyzeNodes: ConnectionAnalysis["analyzeNodes"];
  panels: Pick<ShellPanels, "setRightPanelOpen" | "setActiveRailTab">;
}) {
  const { graphData } = graph;
  const [stepSuggestionNodes, setStepSuggestionNodes] = useState<StepSuggestionNode[]>([]);
  const [stepSuggestionOpen, setStepSuggestionOpen] = useState(false);
  const [stepSuggestionLoading, setStepSuggestionLoading] = useState(false);
  // Lets the user cancel a slow roadmap/step generation (#5). Aborting the
  // fetch also aborts the upstream model call server-side (the route forwards
  // req.signal to Anthropic), so a cancel doesn't keep burning tokens.
  const stepSuggestAbortRef = useRef<AbortController | null>(null);
  // Connection analysis held back while the picker is up (after a review).
  const pendingAnalysisRef = useRef<{ nodeIds: string[]; workspaceId: string } | null>(null);
  // When a freshly-created task looks like a multi-session project, we hold it
  // here and show an inline "break it down?" chooser in the chat rail (the
  // sizing layer — see lib/ai/sizing.ts).
  const [pendingSizeBreakdown, setPendingSizeBreakdown] = useState<{
    nodeId: string;
    title: string;
  } | null>(null);

  /** Open the picker on these nodes (all ticked); analysis can wait for it. */
  const offerSteps = (
    nodes: Array<Pick<Node, "id" | "title" | "summary" | "node_type">>,
    deferredAnalysis?: { nodeIds: string[]; workspaceId: string },
  ) => {
    if (deferredAnalysis) pendingAnalysisRef.current = deferredAnalysis;
    setStepSuggestionNodes(
      nodes.map((n) => ({
        id: n.id,
        title: n.title,
        summary: n.summary,
        node_type: n.node_type,
        selected: true,
      })),
    );
    setStepSuggestionOpen(true);
  };

  // Generated steps land as ONE Suggested card in a fresh chat thread, the
  // way a dump's changes do (fix list #8): the step-writer makes one call per
  // item (api/nodes/suggest-steps), nothing changes until Apply. Until
  // 2026-10-03 its text went through a second extraction into the old review
  // modal.
  const requestSteps = async (
    nodes: Array<{ id: string }>,
    mode: "light" | "full",
    instructions: string | undefined,
    signal: AbortSignal,
  ) => {
    const targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId || nodes.length === 0) return;
    const res = await fetch("/api/nodes/suggest-steps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_ids: nodes.map((n) => n.id),
        workspace_id: targetWorkspaceId,
        mode,
        instructions,
      }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      label?: string;
      error?: string;
      pending_action?: { run_id: string; tool_use_id: string; tool_name: string; tool_input: Record<string, unknown> };
    };
    if (signal.aborted) return;
    const title = graphData.nodes.find((n) => n.id === nodes[0].id)?.title ?? "this";
    await postTurn(
      data.label ?? `Steps for “${title}”`,
      {
        reply: res.ok && data.pending_action ? null : (data.error ?? "Couldn't write steps right now — try again."),
        added: [],
        done: [],
        links: [],
        questions: [],
      },
      { pending_action: res.ok ? (data.pending_action ?? null) : null },
      targetWorkspaceId,
      false,
    );
  };

  // Quick steps / AI roadmap for one node from the details panel. Fires
  // regardless of node type or whether it already has children — a re-prompt
  // for a finer breakdown is intentional here.
  const suggestStepsForNode = async (nodeId: string, mode: "light" | "full" = "full", instructions?: string) => {
    if (!workspaceId || stepSuggestionLoading) return;
    if (!graphData.nodes.some((n) => n.id === nodeId)) return;

    const abort = new AbortController();
    stepSuggestAbortRef.current = abort;
    setStepSuggestionLoading(true);
    try {
      await requestSteps([{ id: nodeId }], mode, instructions, abort.signal);
    } catch {
      // Aborted or failed — silent (the user cancelled, or the network dropped).
    } finally {
      if (stepSuggestAbortRef.current === abort) stepSuggestAbortRef.current = null;
      setStepSuggestionLoading(false);
    }
  };

  const toggleStepNode = (nodeId: string) => {
    setStepSuggestionNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, selected: !n.selected } : n)));
  };

  const generateSteps = async () => {
    if (!workspaceId) return;
    const selectedNodes = stepSuggestionNodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return;
    const abort = new AbortController();
    stepSuggestAbortRef.current = abort;
    setStepSuggestionLoading(true);
    setStepSuggestionOpen(false);

    try {
      // One request: the server writes every item's steps in parallel and
      // puts them on ONE card.
      await requestSteps(selectedNodes, "full", undefined, abort.signal);
    } catch {
      // Step generation failed silently
    } finally {
      if (stepSuggestAbortRef.current === abort) stepSuggestAbortRef.current = null;
      setStepSuggestionLoading(false);
      setStepSuggestionNodes([]);
      // Now run deferred connection analysis (skip if the user cancelled)
      const pending = pendingAnalysisRef.current;
      if (pending && !abort.signal.aborted) {
        pendingAnalysisRef.current = null;
        void analyzeNodes(pending.nodeIds);
      }
    }
  };

  // Cancel an in-flight roadmap/step generation (#5). Aborts the fetch, which
  // also cancels the upstream model call (the route forwards req.signal).
  const cancelStepSuggestion = () => {
    stepSuggestAbortRef.current?.abort();
    setStepSuggestionLoading(false);
  };

  const dismissStepSuggestion = () => {
    setStepSuggestionOpen(false);
    setStepSuggestionNodes([]);
    // Run deferred connection analysis
    const pending = pendingAnalysisRef.current;
    if (pending) {
      pendingAnalysisRef.current = null;
      void analyzeNodes(pending.nodeIds);
    }
  };

  // Decide whether a just-created task is really a multi-session endeavour and,
  // if so, offer the inline "break it into steps?" chooser. The cheap heuristic
  // decides most titles for free; only 'ambiguous' ones cost a Haiku call,
  // which fails safe to "task" (no interruption) on any error.
  //
  // We do NOT mutate the node here. Breaking it down just nests generated steps
  // under it (a task can have children), and only if the user accepts — so
  // "Keep as one task" genuinely leaves it untouched. No DB write happens until
  // the user actually picks "Break it down".
  //
  // No concurrency guard: the sole caller is the manual create-node form, where
  // a second creation can't realistically land within the classify window, and
  // a clobbered chooser causes no harm now that nothing is mutated.
  const maybeOfferBreakdown = async (node: Node) => {
    const title = node.title;
    let verdict = classifyTaskSize(title);
    if (verdict === "ambiguous") {
      verdict = "task"; // fail-safe: don't interrupt unless we're confident
      try {
        const res = await fetch("/api/assistant/classify-size", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (res.ok) {
          const data = (await res.json()) as { size?: "task" | "project" };
          if (data.size === "project") verdict = "project";
        }
      } catch {
        // network error — keep the task default, never block creation
      }
    }
    if (verdict !== "project") return;
    setPendingSizeBreakdown({ nodeId: node.id, title });
    panels.setRightPanelOpen(true);
    panels.setActiveRailTab("chat");
  };

  // Resolve the breakdown chooser. "light"/"full" generate nested steps under
  // the task (leaving its type alone) at the chosen depth; "keep" leaves the
  // task exactly as created.
  const resolveSizeBreakdown = (choice: "light" | "full" | "keep") => {
    const pending = pendingSizeBreakdown;
    setPendingSizeBreakdown(null);
    if (pending && choice !== "keep") {
      void suggestStepsForNode(pending.nodeId, choice);
    }
  };

  /** A deleted node takes its pending breakdown offer with it. */
  const forgetBreakdownFor = (nodeIds: string[]) => {
    setPendingSizeBreakdown((p) => (p && nodeIds.includes(p.nodeId) ? null : p));
  };

  return {
    stepSuggestionNodes,
    stepSuggestionOpen,
    stepSuggestionLoading,
    pendingSizeBreakdown,
    offerSteps,
    suggestStepsForNode,
    toggleStepNode,
    generateSteps,
    cancelStepSuggestion,
    dismissStepSuggestion,
    maybeOfferBreakdown,
    resolveSizeBreakdown,
    forgetBreakdownFor,
  };
}

export type StepSuggestions = ReturnType<typeof useStepSuggestions>;
