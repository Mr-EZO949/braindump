"use client";

import { NetworkIcon, SparklesIcon, BoltIcon, TargetIcon, SunIcon } from "@/components/ui/icons";

export type AppMode = "graph" | "assistant";

type ModeDockProps = {
  mode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onOpenBrainDump: () => void;
  onOpenWhatNow: () => void;
  onOpenDailyBrief: () => void;
};

export function ModeDock({
  mode,
  onSetMode,
  onOpenBrainDump,
  onOpenWhatNow,
  onOpenDailyBrief,
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
        className="mode-dock-action"
        data-tour="dailybrief-btn"
        onClick={onOpenDailyBrief}
        type="button"
      >
        <SunIcon className="h-[12px] w-[12px]" />
        Daily Brief
      </button>

      <button
        className="mode-dock-action"
        data-tour="whatnow-btn"
        onClick={onOpenWhatNow}
        type="button"
      >
        <TargetIcon className="h-[12px] w-[12px]" />
        What Now
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
