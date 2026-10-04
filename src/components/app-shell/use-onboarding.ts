"use client";

// First run and new workspaces: the one-time "about you" intake, the welcome
// screen, the setup wizard (with its first dump handed to the review), the
// guided tour — and creating or deleting a workspace, which can start or
// cancel that wizard.

import { useEffect, useRef, useState } from "react";

import { markWelcomeDone, shouldShowWelcome } from "@/components/ui/onboarding-tutorial";
import type { BootstrapDumpHandoff } from "@/components/ui/workspace-bootstrap-wizard";
import type { Workspace } from "@/types/graph";

import type { ProposalReview } from "./use-proposal-review";
import type { ShellSession } from "./use-session";
import type { ShellPanels } from "./use-shell-ui";
import type { WorkspaceGraph } from "./use-workspace-graph";

export function useOnboarding({
  session,
  graph,
  proposals,
  panels,
  showToast,
}: {
  session: ShellSession;
  graph: Pick<WorkspaceGraph, "graphData" | "graphLoading" | "setGraphData" | "loadGraph">;
  proposals: Pick<ProposalReview, "takeBootstrapHandoff">;
  panels: Pick<ShellPanels, "setWorkspaceMenuOpen">;
  showToast: (message: string) => void;
}) {
  const { authUser, workspaces, setWorkspaces, selectedWorkspaceId, setSelectedWorkspaceId, selectedWorkspace } =
    session;
  const { graphData, graphLoading } = graph;
  // User-level "about you" intake — a one-time sign-up moment gated on
  // profiles.intake_completed_at. "loading" until we've checked; "open" shows
  // the intake; "done" lets the workspace onboarding (welcome/bootstrap) run.
  const [profileIntakeState, setProfileIntakeState] = useState<"loading" | "open" | "done">("loading");
  // Bootstrap wizard — shown when a new empty workspace is created OR loaded empty
  const [bootstrapWorkspaceId, setBootstrapWorkspaceId] = useState<string | null>(null);
  // Workspaces whose onboarding wizard the user "Skip for now"-ed this session.
  // We do NOT write bootstrap_completed_at on skip, so the wizard can re-offer
  // itself on a later still-empty load — but this set stops it from re-opening
  // immediately when the empty-workspace effect re-runs this same session.
  const bootstrapSkippedThisSessionRef = useRef<Set<string>>(new Set());
  // Welcome screen — shown once per user on first login
  const [showWelcome, setShowWelcome] = useState(false);
  // Guided tour — shown after workspace wizard during onboarding
  const [showTour, setShowTour] = useState(false);
  // Set while a workspace the user just created is in its setup wizard (and
  // cleared when that ends): a skip then deletes it instead.
  const workspaceCreationFlowRef = useRef<{
    previousWorkspaceId: string | null;
    workspaceId: string;
  } | null>(null);

  // Onboarding decision — runs AFTER the graph has loaded (reads the loaded
  // node count) instead of re-fetching. For empty workspaces: show welcome for
  // brand-new users, or go straight to the wizard if welcome was already seen.
  // Held until the user-level intake is resolved so the two onboarding overlays
  // never stack. Also held until the workspace RECORD is loaded: the workspace
  // id is seeded from localStorage before the list arrives (parallel
  // bootstrap), and until then `bootstrap_completed_at` reads as missing — which
  // used to reopen the setup wizard on an empty, already-onboarded workspace.
  const selectedWorkspaceLoaded = selectedWorkspace !== null;
  useEffect(() => {
    if (graphLoading || !authUser || !selectedWorkspaceId || !selectedWorkspaceLoaded) return;
    if (graphData.nodes.length !== 0 || profileIntakeState !== "done") return;

    if (shouldShowWelcome(authUser.id)) {
      setShowWelcome(true);
    } else if (
      !selectedWorkspace?.bootstrap_completed_at &&
      !bootstrapSkippedThisSessionRef.current.has(selectedWorkspaceId)
    ) {
      setBootstrapWorkspaceId(selectedWorkspaceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graphLoading,
    graphData.nodes.length,
    authUser?.id,
    selectedWorkspaceId,
    selectedWorkspaceLoaded,
    selectedWorkspace?.bootstrap_completed_at,
    profileIntakeState,
  ]);

  // Resolve the user-level "about you" intake once we know who's signed in.
  // Runs before the workspace onboarding (which is gated on this). Fails soft
  // to "done" so a profile-endpoint error (e.g. table not migrated) never traps
  // the user behind the intake.
  useEffect(() => {
    if (!authUser?.id) return;
    let cancelled = false;
    setProfileIntakeState("loading");
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("profile fetch failed"))))
      .then((data: { intake_completed_at?: string | null }) => {
        if (cancelled) return;
        setProfileIntakeState(data?.intake_completed_at ? "done" : "open");
      })
      .catch(() => {
        if (!cancelled) setProfileIntakeState("done");
      });
    return () => {
      cancelled = true;
    };
  }, [authUser?.id]);

  const deleteWorkspace = async (workspaceId: string, options?: { fallbackWorkspaceId?: string | null }) => {
    const res = await fetch(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
    if (!res.ok) {
      return false;
    }

    const remainingWorkspaces = workspaces.filter((workspace) => workspace.id !== workspaceId);
    setWorkspaces(remainingWorkspaces);

    if (selectedWorkspaceId === workspaceId) {
      if (
        options?.fallbackWorkspaceId &&
        remainingWorkspaces.some((workspace) => workspace.id === options.fallbackWorkspaceId)
      ) {
        setSelectedWorkspaceId(options.fallbackWorkspaceId);
      } else {
        setSelectedWorkspaceId(remainingWorkspaces[0]?.id ?? null);
      }
    }

    setBootstrapWorkspaceId((currentWorkspaceId) => (currentWorkspaceId === workspaceId ? null : currentWorkspaceId));

    if (workspaceCreationFlowRef.current?.workspaceId === workspaceId) {
      workspaceCreationFlowRef.current = null;
    }

    return true;
  };

  const cancelWorkspaceCreation = async () => {
    if (!bootstrapWorkspaceId || workspaceCreationFlowRef.current?.workspaceId !== bootstrapWorkspaceId) {
      setBootstrapWorkspaceId(null);
      return;
    }

    const previousWorkspaceId = workspaceCreationFlowRef.current.previousWorkspaceId;
    const fallbackWorkspaceId =
      previousWorkspaceId && workspaces.some((workspace) => workspace.id === previousWorkspaceId)
        ? previousWorkspaceId
        : (workspaces.find((workspace) => workspace.id !== bootstrapWorkspaceId)?.id ?? null);

    const deleted = await deleteWorkspace(bootstrapWorkspaceId, { fallbackWorkspaceId });

    if (!deleted) {
      setBootstrapWorkspaceId(null);
    }
  };

  // A new workspace from the workspace menu: selected, and straight into setup.
  const createWorkspace = async (name: string) => {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    const workspace = (await res.json()) as Workspace;
    workspaceCreationFlowRef.current = {
      previousWorkspaceId: selectedWorkspaceId,
      workspaceId: workspace.id,
    };
    setWorkspaces((prev) => [...prev, workspace]);
    setSelectedWorkspaceId(workspace.id);
    setBootstrapWorkspaceId(workspace.id);
    panels.setWorkspaceMenuOpen(false);
  };

  const completeBootstrap = (handoff?: BootstrapDumpHandoff) => {
    if (workspaceCreationFlowRef.current?.workspaceId === selectedWorkspaceId) {
      workspaceCreationFlowRef.current = null;
    }
    setBootstrapWorkspaceId(null);

    // Mirror the first (bootstrap) dump into the chat thread, exactly like
    // every later brain dump does, and hand its proposals to the review.
    const { hasHandoff, extractionFailed } = proposals.takeBootstrapHandoff(handoff);
    if (!hasHandoff && extractionFailed) {
      showToast("Couldn't process that dump right now — your notes are saved, try a Brain Dump again.");
    }
    void graph.loadGraph(selectedWorkspaceId).then((nextGraphData) => {
      graph.setGraphData(nextGraphData);
      // Run the tour after EVERY new-workspace wizard (not just first
      // onboarding), unless a review modal is already grabbing focus — the
      // tour popping over the proposals is jarring.
      if (!hasHandoff) {
        setShowTour(true);
      }
    });
  };

  const skipBootstrap = () => {
    // "Skip for now" (onboarding): dismiss for this session without
    // writing bootstrap_completed_at, so the wizard can re-offer
    // itself on a later still-empty load. The session ref stops it
    // from immediately re-opening this same session.
    if (!workspaceCreationFlowRef.current) {
      if (selectedWorkspaceId) {
        bootstrapSkippedThisSessionRef.current.add(selectedWorkspaceId);
      }
      setBootstrapWorkspaceId(null);
      // Skipping setup must NOT dead-end onboarding — the user still
      // gets the guided tour of the UI (previously the tour only ran
      // after completing the wizard, so a skip left them staring at an
      // empty graph with no walkthrough).
      setShowTour(true);
      return;
    }
    // Non-onboarding ("created a workspace by mistake") still discards.
    void cancelWorkspaceCreation();
  };

  const startFromWelcome = () => {
    if (!authUser) return;
    markWelcomeDone(authUser.id);
    setShowWelcome(false);
    if (selectedWorkspaceId) {
      setBootstrapWorkspaceId(selectedWorkspaceId);
    }
  };

  const skipWelcome = () => {
    if (!authUser) return;
    markWelcomeDone(authUser.id);
    setShowWelcome(false);
  };

  return {
    profileIntakeState,
    finishIntake: () => setProfileIntakeState("done"),
    bootstrapWorkspaceId,
    // The wizard is first-run onboarding unless the user just created this workspace.
    isOnboardingFlow: () => !workspaceCreationFlowRef.current,
    showWelcome,
    showTour,
    endTour: () => setShowTour(false),
    createWorkspace,
    deleteWorkspace,
    completeBootstrap,
    skipBootstrap,
    startFromWelcome,
    skipWelcome,
  };
}

export type Onboarding = ReturnType<typeof useOnboarding>;
