"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  NetworkIcon,
  SparklesIcon,
  BoltIcon,
  ChartBarIcon,
  TargetIcon,
  LockIcon,
  ListIcon,
  RoadmapIcon,
  FlameIcon,
  CheckSquareIcon,
  ChevronDownIcon,
  TimerIcon,
} from "@/components/ui/icons";

export type AppMode = "graph" | "assistant" | "todos" | "habits" | "roadmap" | "pomodoro";

const LISTS_MODES = new Set<AppMode>(["todos", "habits", "roadmap"]);

export function isListsMode(mode: AppMode): boolean {
  return LISTS_MODES.has(mode);
}

type ModeDockProps = {
  mode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onOpenBrainDump: () => void;
  onOpenWhatNow: () => void;
  onOpenWeeklyReflection: () => void;
  onOpenHistory: () => void;
  weeklyReflectionLocked: boolean;
  // Pulse the Focus button (until first hover) to draw the indecisive user to
  // their prioritized "what to work on now" list. Eligible when there's work.
  focusGlow?: boolean;
};

const WEEKLY_LOCKED_NOTICE_MS = 3200;

function nextSundayLabel(now = new Date()): string {
  const today = now.getDay();
  const daysUntilSunday = (7 - today) % 7 || 7;
  const target = new Date(now);
  target.setDate(now.getDate() + daysUntilSunday);
  return target.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const SUB_BTN_TRANSITION = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };

const LISTS_EXPANDED_KEY = "dock.listsExpanded";

export function ModeDock({
  mode,
  onSetMode,
  onOpenBrainDump,
  onOpenWhatNow,
  onOpenWeeklyReflection,
  onOpenHistory,
  weeklyReflectionLocked,
  focusGlow,
}: ModeDockProps) {
  const [lockedNotice, setLockedNotice] = useState<string | null>(null);
  // Stops the Focus glow once the user has hovered/opened it this session.
  const [focusGlowSeen, setFocusGlowSeen] = useState(false);
  const listsActive = isListsMode(mode);

  // The Lists pill toggles its own expanded state — independent of which
  // mode is active. So you can park the sub-row open while working in
  // Graph or Planner, and pressing Lists doesn't yank you into a list
  // mode, it just shows/hides the three sub-buttons. Persisted in
  // localStorage so it stays however you left it across reloads.
  //
  // SSR-safe: useState seeds from `mode` only (deterministic on server +
  // client first render), then a post-mount effect rehydrates from
  // localStorage. Reading localStorage in the initial state would cause
  // a hydration mismatch since the server has no localStorage.
  const [listsExpanded, setListsExpanded] = useState<boolean>(() => isListsMode(mode));
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(LISTS_EXPANDED_KEY);
    if (stored === "true") setListsExpanded(true);
    else if (stored === "false") setListsExpanded(false);
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LISTS_EXPANDED_KEY, String(listsExpanded));
    }
  }, [listsExpanded, hasHydrated]);

  // If the mode programmatically jumps into a list view (e.g. user clicks
  // a node in Todos), make sure the sub-row is visible so they can see
  // which sub-mode they're on.
  useEffect(() => {
    if (listsActive && !listsExpanded) {
      setListsExpanded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listsActive]);

  useEffect(() => {
    if (!lockedNotice) return;
    const t = setTimeout(() => setLockedNotice(null), WEEKLY_LOCKED_NOTICE_MS);
    return () => clearTimeout(t);
  }, [lockedNotice]);

  const handleWeeklyClick = () => {
    if (weeklyReflectionLocked) {
      setLockedNotice(`Unlocks Sunday — see you ${nextSundayLabel()}.`);
      return;
    }
    onOpenWeeklyReflection();
  };

  // Lists button is purely an expand/collapse for the sub-row. Mode is
  // only changed when the user explicitly clicks one of the sub-buttons
  // (Todos / Habits / Roadmap) or another top-level dock button.
  const handleListsClick = () => {
    setListsExpanded((v) => !v);
  };

  return (
    <div className="mode-dock-wrapper">
      <AnimatePresence>
        {lockedNotice ? (
          <motion.div
            key="locked-notice"
            className="mode-dock-notice"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            role="status"
          >
            <span className="mode-dock-notice-lock" aria-hidden="true">⌛</span>
            {lockedNotice}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="mode-dock" data-tour="dock" role="toolbar" aria-label="App mode">
        <button
          aria-pressed={mode === "graph"}
          className="mode-dock-btn"
          data-active={mode === "graph"}
          data-tour="graph-btn"
          onClick={() => onSetMode("graph")}
          type="button"
        >
          <NetworkIcon className="h-[13px] w-[13px]" />
          Graph
        </button>

        <button
          aria-pressed={mode === "assistant"}
          className="mode-dock-btn"
          data-active={mode === "assistant"}
          data-tour="assistant-btn"
          onClick={() => onSetMode("assistant")}
          type="button"
        >
          <SparklesIcon className="h-[13px] w-[13px]" />
          Planner
        </button>

        <button
          aria-pressed={listsActive}
          aria-expanded={listsExpanded}
          className="mode-dock-btn mode-dock-lists"
          data-active={listsActive}
          data-expanded={listsExpanded}
          data-tour="lists-btn"
          onClick={handleListsClick}
          type="button"
          title={listsExpanded ? "Hide Lists row" : "Show Lists row"}
        >
          <ListIcon className="h-[13px] w-[13px]" />
          Lists
          <ChevronDownIcon
            className="mode-dock-lists-chevron h-[11px] w-[11px]"
            data-open={listsExpanded}
          />
        </button>

        <AnimatePresence initial={false}>
          {listsExpanded ? (
            <>
              <motion.button
                key="todos"
                aria-pressed={mode === "todos"}
                className="mode-dock-btn mode-dock-subbtn"
                data-active={mode === "todos"}
                onClick={() => onSetMode("todos")}
                type="button"
                title="Tasks only — flat sortable list"
                initial={{ opacity: 0, scale: 0.85, marginLeft: -10, width: 0 }}
                animate={{ opacity: 1, scale: 1, marginLeft: 0, width: "auto" }}
                exit={{ opacity: 0, scale: 0.85, marginLeft: -10, width: 0 }}
                transition={SUB_BTN_TRANSITION}
                style={{ overflow: "hidden", whiteSpace: "nowrap" }}
              >
                <CheckSquareIcon className="h-[12px] w-[12px]" />
                Todos
              </motion.button>
              <motion.button
                key="habits"
                aria-pressed={mode === "habits"}
                className="mode-dock-btn mode-dock-subbtn"
                data-active={mode === "habits"}
                onClick={() => onSetMode("habits")}
                type="button"
                title="Habit calendars + streaks"
                initial={{ opacity: 0, scale: 0.85, marginLeft: -10, width: 0 }}
                animate={{ opacity: 1, scale: 1, marginLeft: 0, width: "auto" }}
                exit={{ opacity: 0, scale: 0.85, marginLeft: -10, width: 0 }}
                transition={{ ...SUB_BTN_TRANSITION, delay: 0.03 }}
                style={{ overflow: "hidden", whiteSpace: "nowrap" }}
              >
                <FlameIcon className="h-[12px] w-[12px]" />
                Habits
              </motion.button>
              <motion.button
                key="roadmap"
                aria-pressed={mode === "roadmap"}
                className="mode-dock-btn mode-dock-subbtn"
                data-active={mode === "roadmap"}
                onClick={() => onSetMode("roadmap")}
                type="button"
                title="Big-picture timeline of dated goals and projects"
                initial={{ opacity: 0, scale: 0.85, marginLeft: -10, width: 0 }}
                animate={{ opacity: 1, scale: 1, marginLeft: 0, width: "auto" }}
                exit={{ opacity: 0, scale: 0.85, marginLeft: -10, width: 0 }}
                transition={{ ...SUB_BTN_TRANSITION, delay: 0.06 }}
                style={{ overflow: "hidden", whiteSpace: "nowrap" }}
              >
                <RoadmapIcon className="h-[12px] w-[12px]" />
                Roadmap
              </motion.button>
            </>
          ) : null}
        </AnimatePresence>

        <button
          aria-pressed={mode === "pomodoro"}
          className="mode-dock-btn"
          data-active={mode === "pomodoro"}
          data-tour="pomodoro-btn"
          onClick={() => onSetMode("pomodoro")}
          type="button"
          title="Pomodoro focus timer"
        >
          <TimerIcon className="h-[13px] w-[13px]" />
          Pomodoro
        </button>

        <div className="mode-dock-sep" aria-hidden="true" />

        <button
          className="mode-dock-action"
          data-tour="weekly-reflection-btn"
          data-locked={weeklyReflectionLocked}
          onClick={handleWeeklyClick}
          type="button"
          title={weeklyReflectionLocked ? "Available on Sunday" : "Open weekly review"}
        >
          {weeklyReflectionLocked ? (
            <LockIcon className="h-[11px] w-[11px]" />
          ) : (
            <ChartBarIcon className="h-[12px] w-[12px]" />
          )}
          Weekly Review
        </button>

        <button
          className="mode-dock-action"
          data-tour="history-btn"
          onClick={onOpenHistory}
          type="button"
          title="View past brain dumps"
        >
          <ListIcon className="h-[12px] w-[12px]" />
          History
        </button>

        <div className="mode-dock-sep" aria-hidden="true" />

        <button
          className="mode-dock-action mode-dock-prime"
          data-tour="braindump-btn"
          onClick={onOpenBrainDump}
          type="button"
          title="Capture anything on your mind"
        >
          <BoltIcon className="h-[13px] w-[13px]" />
          Brain Dump
        </button>

        <button
          className="mode-dock-action mode-dock-call"
          data-tour="focus-btn"
          data-glow={focusGlow && !focusGlowSeen ? true : undefined}
          onMouseEnter={() => setFocusGlowSeen(true)}
          onClick={() => {
            setFocusGlowSeen(true);
            onOpenWhatNow();
          }}
          type="button"
          title="Focus: today's top priorities, summary, and quick add to planner"
        >
          <TargetIcon className="h-[13px] w-[13px]" />
          Focus
        </button>
      </div>
    </div>
  );
}
