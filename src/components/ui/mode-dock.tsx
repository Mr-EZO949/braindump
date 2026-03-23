"use client";

import { NetworkIcon, SparklesIcon, BoltIcon } from "@/components/ui/icons";

export type AppMode = "graph" | "assistant";

type ModeDockProps = {
  mode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onOpenBrainDump: () => void;
};

export function ModeDock({ mode, onSetMode, onOpenBrainDump }: ModeDockProps) {
  return (
    <div className="mode-dock" role="toolbar" aria-label="App mode">
      <button
        aria-pressed={mode === "graph"}
        className="mode-dock-btn"
        data-active={mode === "graph"}
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
        onClick={() => onSetMode("assistant")}
        type="button"
      >
        <SparklesIcon className="h-[13px] w-[13px]" />
        Assistant
      </button>

      <div className="mode-dock-sep" aria-hidden="true" />

      <button
        className="mode-dock-action"
        onClick={onOpenBrainDump}
        type="button"
      >
        <BoltIcon className="h-[12px] w-[12px]" />
        Brain Dump
      </button>
    </div>
  );
}
