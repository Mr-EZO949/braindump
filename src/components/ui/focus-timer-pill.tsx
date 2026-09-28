"use client";

import type { FocusTimer } from "@/hooks/use-focus-timer";

type FocusTimerPillProps = {
  timer: FocusTimer;
  remainingSeconds: number;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDone: () => void;
};

function formatTime(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Persistent, presentational focus pill. State + side effects live in the hook
// and app-shell; this just renders the active timer and surfaces controls.
export function FocusTimerPill({
  timer,
  remainingSeconds,
  onPause,
  onResume,
  onStop,
  onDone,
}: FocusTimerPillProps) {
  const isPaused = timer.pausedAt !== null;
  // Set-up-but-never-run: start() froze it at t0 (pausedAt === startedAt, no
  // accumulated pause). Label the control "Start" then, "Resume" after it ran.
  const neverStarted =
    isPaused && timer.accumulatedPausedMs === 0 && timer.pausedAt === timer.startedAt;

  return (
    <div className="focus-pill" role="status" aria-live="polite">
      <span className="focus-pill__title" title={timer.title}>
        {timer.title}
      </span>
      <span className="focus-pill__time">{formatTime(remainingSeconds)}</span>
      <div className="focus-pill__actions">
        {isPaused ? (
          <button
            type="button"
            className="focus-pill__btn focus-pill__btn--ghost"
            onClick={onResume}
          >
            {neverStarted ? "Start" : "Resume"}
          </button>
        ) : (
          <button
            type="button"
            className="focus-pill__btn focus-pill__btn--ghost"
            onClick={onPause}
          >
            Pause
          </button>
        )}
        <button
          type="button"
          className="focus-pill__btn focus-pill__btn--ghost"
          onClick={onStop}
        >
          Stop
        </button>
        <button
          type="button"
          className="focus-pill__btn focus-pill__btn--done"
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </div>
  );
}
