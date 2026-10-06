"use client";

// The shell's own UI state: which view is up, the right rail and its tab, the
// system panel and workspace menu, the dock's dialogs, and the toast.

import { useEffect, useRef, useState } from "react";

import type { AppMode } from "@/components/ui/mode-dock";
import type { RailTab } from "@/types/chat";

export function useShellPanels() {
  const [appMode, setAppMode] = useState<AppMode>("graph");
  // IMPORTANT: this must initialize to the SAME value the server renders
  // (true) — reading window.matchMedia in the initializer makes the first
  // client render diverge from SSR on mobile and breaks hydration. The real
  // viewport-derived value is applied in a mount effect below, after
  // hydration, so there is no server/client mismatch.
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [systemPanelOpen, setSystemPanelOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>("details");

  // Apply the viewport-derived default for the right panel AFTER hydration.
  // On mobile the rail should start closed; doing this in an effect (not the
  // useState initializer) keeps the first client render identical to the
  // server's, avoiding the hydration mismatch. Runs once on mount.
  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration default, see above
      setRightPanelOpen(false);
    }
  }, []);

  /** The rail open on its Chat tab. */
  const openChatRail = () => {
    setRightPanelOpen(true);
    setActiveRailTab("chat");
  };

  return {
    appMode,
    setAppMode,
    rightPanelOpen,
    setRightPanelOpen,
    systemPanelOpen,
    setSystemPanelOpen,
    workspaceMenuOpen,
    setWorkspaceMenuOpen,
    activeRailTab,
    setActiveRailTab,
    openChatRail,
  };
}

export type ShellPanels = ReturnType<typeof useShellPanels>;

/** The dock's dialogs: Focus ("What now"), the weekly reflection, dump history. */
export function useShellDialogs() {
  const [whatNowOpen, setWhatNowOpen] = useState(false);
  const [weeklyReflectionOpen, setWeeklyReflectionOpen] = useState(false);
  const [dumpHistoryOpen, setDumpHistoryOpen] = useState(false);
  return {
    whatNowOpen,
    setWhatNowOpen,
    weeklyReflectionOpen,
    setWeeklyReflectionOpen,
    dumpHistoryOpen,
    setDumpHistoryOpen,
  };
}

/** Minimal hand-rolled toast (no library). Cleared after ~3s. */
export function useShellToast() {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const showToast = (message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  };

  return { toast, showToast };
}

/**
 * Keys the Planner watches: bumped when tasks change elsewhere (a cascade, a
 * chat tool, a habit), and a chat-drafted plan with where it was made for.
 */
export function usePlannerSync() {
  // Bumped whenever the server cascades plan_tasks updates (e.g. graph
  // completion auto-marked a linked task). The planner subscribes via prop
  // and re-loads its tasks list when the key changes — keeps the two views
  // in sync without a full page refresh.
  const [plannerRefreshKey, setPlannerRefreshKey] = useState(0);
  // Bumped when a chat `plan_day` is accepted, to pull its freshly-drafted plan
  // into the planner's review UI (journal #6).
  const [draftPlanRefreshKey, setDraftPlanRefreshKey] = useState(0);
  // That plan_day's start time and the busy time named in chat, so Accept in
  // the Planner lays the blocks where the plan was made for.
  const [draftPlanHint, setDraftPlanHint] = useState<{
    startTime: unknown;
    busy: unknown;
    window: unknown;
    acceptedAt: number;
    include?: unknown;
    day?: unknown;
    userMessage?: unknown;
  } | null>(null);

  const refreshPlanner = () => setPlannerRefreshKey((v) => v + 1);

  return {
    plannerRefreshKey,
    refreshPlanner,
    draftPlanRefreshKey,
    setDraftPlanRefreshKey,
    draftPlanHint,
    setDraftPlanHint,
  };
}

export type PlannerSync = ReturnType<typeof usePlannerSync>;
