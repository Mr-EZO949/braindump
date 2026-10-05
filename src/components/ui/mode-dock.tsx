"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  NetworkIcon,
  SparklesIcon,
  BoltIcon,
  TargetIcon,
  ListIcon,
  RoadmapIcon,
  FlameIcon,
  CheckSquareIcon,
  ChevronDownIcon,
} from "@/components/ui/icons";

export type AppMode = "graph" | "assistant" | "todos" | "habits" | "roadmap";

const LISTS_MODES = new Set<AppMode>(["todos", "habits", "roadmap"]);

export function isListsMode(mode: AppMode): boolean {
  return LISTS_MODES.has(mode);
}

type ModeDockProps = {
  mode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onOpenBrainDump: () => void;
  onOpenWhatNow: () => void;
  // Pulse the Focus button (until first hover) to draw the indecisive user to
  // their prioritized "what to work on now" list. Eligible when there's work.
  focusGlow?: boolean;
};

// A dock label. On a phone the dock is a bottom tab bar with ~42px per item,
// so a long label shows a short form there; the full one stays for screen
// readers. On wider screens the short form is display:none (see globals.css).
function DockLabel({ full, short }: { full: string; short?: string }) {
  if (!short) return <span className="mode-dock-label">{full}</span>;
  return (
    <>
      <span className="mode-dock-label mode-dock-label-full">{full}</span>
      <span aria-hidden="true" className="mode-dock-label mode-dock-label-short">
        {short}
      </span>
    </>
  );
}

const LIST_VIEWS: { mode: AppMode; label: string; title: string; Icon: typeof CheckSquareIcon }[] = [
  { mode: "todos", label: "Todos", title: "Tasks by project, priority or due date", Icon: CheckSquareIcon },
  { mode: "habits", label: "Habits", title: "Habit calendars + streaks", Icon: FlameIcon },
  { mode: "roadmap", label: "Roadmap", title: "Big-picture timeline of dated goals and projects", Icon: RoadmapIcon },
];

export function ModeDock({ mode, onSetMode, onOpenBrainDump, onOpenWhatNow, focusGlow }: ModeDockProps) {
  // Stops the Focus glow once the user has hovered/opened it this session.
  const [focusGlowSeen, setFocusGlowSeen] = useState(false);
  const listsActive = isListsMode(mode);

  // Lists opens a small column above the button (owner, 2026-10-05: lists
  // expand vertically, not along the dock). Picking a view, a click outside or
  // Escape closes it; the Lists button stays lit while a list view is open.
  const [listsOpen, setListsOpen] = useState(false);
  const listsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listsOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!listsRef.current?.contains(e.target as Node)) setListsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setListsOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [listsOpen]);

  return (
    <div className="mode-dock-wrapper">
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
          <DockLabel full="Graph" />
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
          <DockLabel full="Planner" />
        </button>

        <div className="mode-dock-lists-wrap" ref={listsRef}>
          <button
            aria-pressed={listsActive}
            aria-expanded={listsOpen}
            aria-haspopup="menu"
            className="mode-dock-btn mode-dock-lists"
            data-active={listsActive}
            data-expanded={listsOpen}
            data-tour="lists-btn"
            onClick={() => setListsOpen((v) => !v)}
            type="button"
            title="Todos, Habits, Roadmap"
          >
            <ListIcon className="h-[13px] w-[13px]" />
            <DockLabel full="Lists" />
            <ChevronDownIcon
              className="mode-dock-lists-chevron h-[11px] w-[11px]"
              data-open={listsOpen}
            />
          </button>

          <AnimatePresence>
            {listsOpen ? (
              <motion.div
                key="lists-menu"
                className="mode-dock-lists-menu"
                role="menu"
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.97 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              >
                {LIST_VIEWS.map(({ mode: view, label, title, Icon }) => (
                  <button
                    key={view}
                    aria-checked={mode === view}
                    className="mode-dock-btn mode-dock-subbtn"
                    data-active={mode === view}
                    onClick={() => {
                      onSetMode(view);
                      setListsOpen(false);
                    }}
                    role="menuitemradio"
                    type="button"
                    title={title}
                  >
                    <Icon className="h-[12px] w-[12px]" />
                    <span className="mode-dock-label">{label}</span>
                  </button>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="mode-dock-sep" aria-hidden="true" />

        <button
          className="mode-dock-action mode-dock-prime"
          data-tour="braindump-btn"
          onClick={onOpenBrainDump}
          type="button"
          title="Capture anything on your mind — it goes into your graph"
        >
          <BoltIcon className="h-[13px] w-[13px]" />
          <DockLabel full="Brain Dump" short="Dump" />
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
          <DockLabel full="Focus" />
        </button>
      </div>
    </div>
  );
}
