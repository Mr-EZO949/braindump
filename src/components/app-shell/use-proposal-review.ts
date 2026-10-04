"use client";

// The proposal review modal — the older dump path (and the setup wizard's
// first dump): proposals to accept, clarifying questions answered inline or
// handed to chat after it closes, and life areas to add. Accepted nodes are
// placed near the view, and a project with no steps gets a roadmap offer.

import { useEffect, useRef, useState } from "react";

import { bootstrapSummaryText, roadmapOfferText } from "@/lib/chat/dump-summary";
import { persistLocalNodePosition, removeLocalNodePosition } from "@/lib/graph/data";
import { findChildlessProjects } from "@/lib/graph/dump-heuristic";
import { placeAcceptedNodes, stepCandidates } from "@/lib/graph/graph-patches";
import type { BootstrapDumpHandoff } from "@/components/ui/workspace-bootstrap-wizard";
import type { ProposedNode } from "@/types/ai";
import type { Edge, GraphData, Node } from "@/types/graph";

import type { ChatActions } from "./use-chat-actions";
import type { ChatThread } from "./use-chat-thread";
import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { GraphView } from "./use-graph-view";
import type { ShellPanels } from "./use-shell-ui";
import type { StepSuggestions } from "./use-step-suggestions";
import type { WorkspaceGraph } from "./use-workspace-graph";

type SuggestedArea = { title: string; area_type: string };

export function useProposalReview({
  userId,
  workspaceId,
  graph,
  view,
  thread,
  submitMessage,
  analyzeNodes,
  steps,
  panels,
}: {
  userId: string | null;
  workspaceId: string | null;
  graph: Pick<WorkspaceGraph, "graphData" | "setGraphData" | "loadGraph" | "refreshClusters">;
  view: Pick<GraphView, "cameraView">;
  thread: Pick<ChatThread, "setChatMessages" | "startFreshThread" | "dumpInChatRef" | "setRailChatInput">;
  submitMessage: ChatActions["submitMessage"];
  analyzeNodes: ConnectionAnalysis["analyzeNodes"];
  steps: Pick<StepSuggestions, "offerSteps">;
  panels: Pick<ShellPanels, "setRightPanelOpen" | "setActiveRailTab">;
}) {
  const { graphData, setGraphData } = graph;
  const { setChatMessages, dumpInChatRef } = thread;
  const [proposedNodes, setProposedNodes] = useState<ProposedNode[]>([]);
  const [proposedReviewOpen, setProposedReviewOpen] = useState(false);
  const [proposedNodesSubmitting, setProposedNodesSubmitting] = useState(false);
  // Life-areas inferred from the dump (same call the wizard uses), surfaced in
  // the review modal so a normal dump can also spin up top-level branches.
  const [suggestedAreas, setSuggestedAreas] = useState<SuggestedArea[]>([]);
  // Clarifying questions returned alongside (or instead of) proposals — the
  // extractor asks back when the dump is vague. Paired with the raw dump
  // text so the chat seed can echo the full context.
  const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
  const [lastDumpRawText, setLastDumpRawText] = useState<string>("");
  // Flag set when the proposed-nodes review was opened by the bootstrap
  // wizard handoff. We use it to skip the auto suggest-steps modal +
  // post-acceptance connection analysis so a first dump doesn't dogpile
  // the user with three modals + several Sonnet calls. They can still
  // trigger suggest-steps manually from any node's details panel.
  const [proposalsFromBootstrap, setProposalsFromBootstrap] = useState(false);
  // Project ids we've already offered a roadmap for this session — so the
  // in-thread "want a roadmap?" prompt never nags about the same project.
  const roadmapPromptedRef = useRef<Set<string>>(new Set());
  // Questions the user already answered inline while the modal was open;
  // these are excluded from the after-close auto-dispatch.
  const [answeredInlineQuestions, setAnsweredInlineQuestions] = useState<Set<string>>(() => new Set());
  // The inline answers themselves, in order — sent to the assistant as one
  // turn when the review closes (sendInlineAnswersToChat).
  const inlineAnswersRef = useRef<Array<{ question: string; answer: string }>>([]);

  useEffect(() => {
    if (proposedReviewOpen) {
      // NOTE: dumpInChatRef is intentionally NOT reset here. Each review-opening
      // path sets it explicitly (true when it already echoed the dump, false
      // when it didn't), so resetting it here would clobber that and let the
      // clarifying flow re-echo the dump (#11).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh review starts with no answers
      setAnsweredInlineQuestions(new Set());
      inlineAnswersRef.current = [];
    }
  }, [proposedReviewOpen]);

  /** Open the review on a dump's proposals and questions. */
  const openReview = (review: { nodes: ProposedNode[]; questions: string[]; areas: SuggestedArea[]; rawText: string }) => {
    setProposedNodes(review.nodes);
    setClarifyingQuestions(review.questions);
    setSuggestedAreas(review.areas);
    setLastDumpRawText(review.rawText);
    setProposedReviewOpen(true);
  };

  // Merge freshly accepted nodes into the graph: position unattached ones near
  // the viewport centre, clear stale positions for attached ones, and softly
  // offer a roadmap for any project that landed with no steps. Shared by the
  // review modal and calibrated auto-apply so both behave identically.
  const mergeAcceptedIntoGraph = (nodes: Node[], acceptedEdges: Edge[]) => {
    const { positioned, stored } = placeAcceptedNodes(nodes, acceptedEdges, view.cameraView);
    if (userId && workspaceId) {
      for (const { nodeId, position } of stored) {
        if (position) persistLocalNodePosition(userId, workspaceId, nodeId, position);
        else removeLocalNodePosition(userId, workspaceId, nodeId);
      }
    }

    setGraphData((prev) => ({
      ...prev,
      nodes: [...prev.nodes, ...positioned],
      edges: [...prev.edges, ...acceptedEdges],
    }));

    // After accepting, if any project landed with no steps under it,
    // proactively ask in-thread whether they want a roadmap. Guarded so
    // it never nags about the same project twice in a session. The user
    // replies in chat → the assistant proposes steps via the normal
    // propose-with-Accept/Reject flow.
    const mergedGraph: GraphData = {
      nodes: [...graphData.nodes, ...positioned],
      edges: [...graphData.edges, ...acceptedEdges],
    };
    const childless = findChildlessProjects(mergedGraph).filter((p) => !roadmapPromptedRef.current.has(p.id));
    if (childless.length > 0) {
      childless.forEach((p) => roadmapPromptedRef.current.add(p.id));
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-roadmap-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: roadmapOfferText(childless),
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        },
      ]);
      panels.setRightPanelOpen(true);
      panels.setActiveRailTab("chat");
    }
  };

  // Opens the right-rail chat with the prior dump + extractor questions as
  // an initial conversation. Crucially does NOT switch app mode — the user
  // stays on whatever view they were on (graph, list, etc.) and the chat
  // appears alongside as a side panel. Called automatically after the
  // proposed-nodes review closes when there are unanswered questions.
  // #18: a brain dump's follow-up conversation should start its OWN chat with
  // zero prior context, not pile onto whatever thread happens to be open. The
  // first time a given dump is injected into chat (dumpInChatRef still false),
  // cut over to a fresh session. The previous conversation is already
  // auto-saved, so it stays available in chat history.
  const startFreshDumpChatIfNeeded = () => {
    if (dumpInChatRef.current) return;
    thread.startFreshThread();
  };

  const openClarifyingQuestionsInChat = (questions: string[], dumpText: string) => {
    if (questions.length === 0) return;
    startFreshDumpChatIfNeeded();
    panels.setRightPanelOpen(true);
    panels.setActiveRailTab("chat");
    setChatMessages((prev) => {
      // Never wipe prior messages here — keep the dump echo + summary that
      // applyDumpExtraction already placed. The ref guard below is the sole
      // thing preventing a second echo (#11).
      const out = [...prev];
      if (!dumpInChatRef.current && dumpText.length > 0) {
        out.push({
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: dumpText,
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        });
        dumpInChatRef.current = true;
      }
      for (const q of questions) {
        out.push({
          id: `chat-q-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: q,
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        });
      }
      return out;
    });
    thread.setRailChatInput("");
  };

  // Handler for inline answers from the modal. Threads (dump →) question →
  // answer into the chat rail without disturbing the user's view. The
  // modal stays open so they can keep reviewing nodes.
  const answerInline = (question: string, answer: string) => {
    const dumpText = lastDumpRawText;
    startFreshDumpChatIfNeeded();
    panels.setRightPanelOpen(true);
    panels.setActiveRailTab("chat");
    setChatMessages((prev) => {
      // Never wipe prior messages here — keep the dump echo + summary that
      // applyDumpExtraction already placed. The ref guard below is the sole
      // thing preventing a second echo (#11).
      const out = [...prev];
      if (!dumpInChatRef.current && dumpText.length > 0) {
        out.push({
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: dumpText,
          createdAt: new Date().toISOString(),
          status: "ready" as const,
        });
        dumpInChatRef.current = true;
      }
      out.push({
        id: `chat-q-${Math.random().toString(36).slice(2, 10)}`,
        role: "assistant" as const,
        body: question,
        createdAt: new Date().toISOString(),
        status: "ready" as const,
      });
      out.push({
        id: `chat-a-${Math.random().toString(36).slice(2, 10)}`,
        role: "user" as const,
        body: answer,
        createdAt: new Date().toISOString(),
        status: "ready" as const,
      });
      return out;
    });
    setAnsweredInlineQuestions((prev) => {
      const next = new Set(prev);
      next.add(question);
      return next;
    });
    inlineAnswersRef.current.push({ question, answer });
  };

  // Answers typed inline in the review used to be shown in the chat rail and
  // go nowhere: no model ever read them, so "yeah" to "want me to restructure
  // this?" changed nothing (2026-09-30). When the review closes they go to the
  // assistant as ONE turn — after the accepted nodes are in the graph — and it
  // acts on them with the usual Accept cards. The Q → A bubbles are already in
  // the thread, so the turn itself adds no user bubble.
  const sendInlineAnswersToChat = () => {
    const answers = inlineAnswersRef.current;
    inlineAnswersRef.current = [];
    if (answers.length === 0) return;
    const lines = answers.map(({ question, answer }) => `- "${question}" → ${answer}`);
    void submitMessage(
      `My answers to your questions about my last brain dump — act on them now:\n${lines.join("\n")}`,
      false,
    );
  };

  const acceptProposals = async (
    actions: Array<{
      id: string;
      action: "accept" | "reject";
      replaced_by_node_id?: string;
      edits?: { proposed_title: string; proposed_summary: string | null; proposed_node_type: string };
    }>,
  ) => {
    setProposedNodesSubmitting(true);
    const res = await fetch("/api/proposals/nodes/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    const data = (await res.json()) as { accepted_nodes?: Node[]; accepted_edges?: Edge[] };
    // The review route runs the clustering pass server-side; re-poll so any new
    // grouping suggestions surface right after accepting a dump's nodes.
    graph.refreshClusters();
    if (data.accepted_nodes && data.accepted_nodes.length > 0) {
      mergeAcceptedIntoGraph(data.accepted_nodes, data.accepted_edges ?? []);
    }
    setProposedNodesSubmitting(false);
    setProposedReviewOpen(false);
    setProposedNodes([]);

    // After the review closes, surface any clarifying questions the user
    // didn't already answer inline — without switching off their current
    // view.
    const questionsToAsk = clarifyingQuestions.filter((q) => !answeredInlineQuestions.has(q));
    const dumpToAsk = lastDumpRawText;
    setClarifyingQuestions([]);
    setLastDumpRawText("");
    if (questionsToAsk.length > 0) {
      openClarifyingQuestionsInChat(questionsToAsk, dumpToAsk);
    }
    // The accepted nodes are in the graph now, so the answers given inline can
    // be acted on without duplicating anything still under review.
    sendInlineAnswersToChat();

    // First-dump shortcut: if these proposals came from the bootstrap
    // wizard, skip the suggest-steps modal — a first dump already produces
    // enough nodes and the user just spent time reviewing them; don't dogpile
    // them with another modal + a stack of Sonnet calls. Suggest-steps stays
    // available manually from any node's details panel. We DO still run
    // connection analysis, though: the wizard builds the initial graph and the
    // user expects edges between their nodes (and to the life-areas) to appear.
    if (proposalsFromBootstrap) {
      setProposalsFromBootstrap(false);
      if (data.accepted_nodes && data.accepted_nodes.length > 0 && workspaceId) {
        const bootstrapNodeIds = (data.accepted_nodes as Node[]).map((n) => n.id);
        void analyzeNodes(bootstrapNodeIds, workspaceId);
      }
    } else if (data.accepted_nodes && data.accepted_nodes.length > 0 && workspaceId) {
      const acceptedNodes = data.accepted_nodes as Node[];
      const nodeIds = acceptedNodes.map((n) => n.id);

      // Only suggest steps for leaf nodes — anything that's already a parent
      // already has structure beneath it.
      const goalOrProjectNodes = stepCandidates(
        acceptedNodes,
        graphData.edges,
        (data.accepted_edges as Edge[]) ?? [],
      );

      if (goalOrProjectNodes.length > 0) {
        // Store node IDs so connection analysis can run after step flow
        steps.offerSteps(goalOrProjectNodes, { nodeIds, workspaceId });
      } else {
        // No goals/projects — run connection analysis immediately
        void analyzeNodes(nodeIds);
      }
    }
  };

  const closeReview = () => {
    // Capture pending questions/dump BEFORE we wipe state, so we can hand
    // unanswered ones to chat after the modal closes.
    const questionsToAsk = clarifyingQuestions.filter((q) => !answeredInlineQuestions.has(q));
    const dumpToAsk = lastDumpRawText;

    setProposedReviewOpen(false);
    setProposedNodes([]);
    setClarifyingQuestions([]);
    setSuggestedAreas([]);
    setLastDumpRawText("");

    if (questionsToAsk.length > 0) {
      openClarifyingQuestionsInChat(questionsToAsk, dumpToAsk);
    }
    sendInlineAnswersToChat();
  };

  const requestCloseReview = () => {
    // Warn before discarding the dump's payoff — only when there are still
    // un-actioned proposed nodes worth losing. A questions-only review
    // closing is cheap, so it skips the confirm.
    if (proposedNodes.length > 0) {
      const count = proposedNodes.length;
      const confirmed = window.confirm(
        `Discard ${count} suggested node${count === 1 ? "" : "s"}? They came from your brain dump and won't be saved.`,
      );
      if (!confirmed) {
        return;
      }
    }

    closeReview();
  };

  // Create the life-area branches the user selected in the review modal. Runs
  // BEFORE node acceptance (the modal awaits it first), so the areas exist +
  // are embedded when the accepted nodes get connection-analyzed and linked
  // under them. Best-effort — a failure here must never block accepting nodes.
  const addAreas = async (areas: SuggestedArea[]) => {
    if (!workspaceId || areas.length === 0) return;
    try {
      await fetch(`/api/workspaces/${workspaceId}/areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areas }),
      });
      // Reload so the new branch nodes + their root edges render. The node
      // acceptance that runs right after appends onto this fresh graph.
      const next = await graph.loadGraph(workspaceId);
      setGraphData(next);
    } catch {
      // Best-effort — area creation failing shouldn't block node acceptance.
    }
  };

  /**
   * The setup wizard's first dump: mirrored into the thread like every later
   * dump, then its proposals and questions open in the review. Returns whether
   * the review opened, and whether extraction failed.
   */
  const takeBootstrapHandoff = (handoff: BootstrapDumpHandoff | undefined) => {
    // The user submitted a dump but extraction failed/was disabled and
    // produced nothing — surface it instead of silently dropping it.
    const extractionFailed = Boolean(handoff?.extraction_error);
    const bootstrapDumpText = handoff?.raw_text?.trim() ?? "";
    if (bootstrapDumpText) {
      const bootstrapSummary = bootstrapSummaryText({
        extractionFailed,
        nodeCount: handoff?.proposed_nodes?.length ?? 0,
        questionCount: handoff?.clarifying_questions?.length ?? 0,
      });
      const bootstrapNowIso = new Date().toISOString();
      setChatMessages((prev) => [
        ...prev,
        {
          id: `chat-dump-${Math.random().toString(36).slice(2, 10)}`,
          role: "user" as const,
          body: bootstrapDumpText,
          createdAt: bootstrapNowIso,
          status: "ready" as const,
        },
        {
          id: `chat-extract-${Math.random().toString(36).slice(2, 10)}`,
          role: "assistant" as const,
          body: bootstrapSummary,
          createdAt: bootstrapNowIso,
          status: "ready" as const,
        },
      ]);
      // Onboarding dump is now echoed once — the clarifying flow must
      // not echo it again (#11).
      dumpInChatRef.current = true;
    }

    // If the bootstrap dump produced proposed nodes, hand them
    // straight to the review modal so the user immediately sees
    // what got extracted from their first dump.
    const hasHandoff = Boolean(
      handoff &&
        ((handoff.proposed_nodes && handoff.proposed_nodes.length > 0) ||
          (handoff.clarifying_questions && handoff.clarifying_questions.length > 0)),
    );
    if (hasHandoff) {
      setProposedNodes((handoff!.proposed_nodes ?? []) as ProposedNode[]);
      setClarifyingQuestions((handoff!.clarifying_questions ?? []) as string[]);
      // The wizard already created the user's life-areas, so don't
      // re-offer area branches in the first-dump review.
      setSuggestedAreas([]);
      setLastDumpRawText(handoff!.raw_text);
      setProposalsFromBootstrap(true);
      setProposedReviewOpen(true);
    }
    return { hasHandoff, extractionFailed };
  };

  return {
    proposedNodes,
    proposedReviewOpen,
    proposedNodesSubmitting,
    suggestedAreas,
    clarifyingQuestions,
    openReview,
    mergeAcceptedIntoGraph,
    acceptProposals,
    requestCloseReview,
    answerInline,
    addAreas,
    takeBootstrapHandoff,
  };
}

export type ProposalReview = ReturnType<typeof useProposalReview>;
