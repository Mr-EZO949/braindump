"use client";

import { NetworkIcon, SparklesIcon, BoltIcon } from "@/components/ui/icons";

export type AppMode = "graph" | "assistant";

type ModeDockProps = {
  mode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onOpenBrainDump: () => void;
  onOpenCommandBar: () => void;
};

export function ModeDock({
  mode,
  onSetMode,
  onOpenBrainDump,
  onOpenCommandBar,
}: ModeDockProps) {
  return (
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

      <div className="mode-dock-sep" aria-hidden="true" />

      <button
        aria-label="Open command bar"
        className="mode-dock-action"
        data-tour="command-btn"
        onClick={onOpenCommandBar}
        type="button"
        title="Ask / Dump / Do · ⌘K"
      >
        <SparklesIcon className="h-[12px] w-[12px]" />
        Ask
        <span className="ml-1 rounded border border-current/30 px-1 text-[10px] opacity-70">⌘K</span>
      </button>

      <button
        className="mode-dock-action"
        data-tour="braindump-btn"
        onClick={onOpenBrainDump}
        type="button"
      >
        <BoltIcon className="h-[12px] w-[12px]" />
        Brain Dump
      </button>
    </div>
  );
}
