"use client";

// Where a long brain dump is right now — "Sorting it into your graph · 14s" —
// in place of a bare spinner (lib/chat/dump-stream.ts). The seconds show from
// 4 s on: a quick dump just shows its stage.

import { useEffect, useState } from "react";

import { DUMP_STAGE_LABEL, type DumpStage } from "@/lib/chat/dump-stream";

export interface DumpProgressState {
  stage: DumpStage;
  startedAt: number;
}

export function DumpProgressLabel({ progress, className }: { progress: DumpProgressState; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - progress.startedAt) / 1000));
  return (
    <span className={className} aria-live="polite">
      {DUMP_STAGE_LABEL[progress.stage]}
      {seconds >= 4 ? <span className="dump-progress-seconds"> · {seconds}s</span> : null}
    </span>
  );
}
