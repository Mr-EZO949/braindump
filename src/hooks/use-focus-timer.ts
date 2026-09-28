"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One focus timer at a time, persisted to localStorage so it survives view/mode
// switches and full reloads. We store `startedAt` (and any accumulated paused
// time) rather than a remaining count, so a reload recomputes the true elapsed
// from wall-clock time instead of losing whatever ran while the tab was gone.

export type FocusTimer = {
  nodeId: string;
  title: string;
  durationMinutes: number;
  startedAt: number; // Date.now() at (re)start
  pausedAt: number | null; // Date.now() when paused, else null
  accumulatedPausedMs: number; // total paused time before the current pause
};

export type FocusTimerControls = {
  timer: FocusTimer | null;
  remainingSeconds: number;
  start: (input: {
    nodeId: string;
    title: string;
    durationMinutes: number;
    // When true, the timer is SET UP but not running — it lands paused at full
    // duration so the user starts it explicitly. Used by "Start working" /
    // Focus, which should never auto-run a countdown.
    paused?: boolean;
  }) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

// Mirrors the per-workspace key shape used elsewhere; null workspace gets its
// own bucket so a signed-out / pre-workspace state never collides with a real
// workspace's timer.
function storageKey(workspaceId: string | null): string {
  return `braindump:focus-timer:${workspaceId ?? "null"}`;
}

function isFocusTimer(value: unknown): value is FocusTimer {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.nodeId === "string" &&
    typeof t.title === "string" &&
    typeof t.durationMinutes === "number" &&
    typeof t.startedAt === "number" &&
    (t.pausedAt === null || typeof t.pausedAt === "number") &&
    typeof t.accumulatedPausedMs === "number"
  );
}

function loadTimer(workspaceId: string | null): FocusTimer | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isFocusTimer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveTimer(workspaceId: string | null, timer: FocusTimer | null) {
  if (typeof window === "undefined") return;
  try {
    if (timer) {
      window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(timer));
    } else {
      window.localStorage.removeItem(storageKey(workspaceId));
    }
  } catch {
    // localStorage can throw (private mode / quota) — the timer still works
    // in-memory; we just lose reload-persistence in that edge case.
  }
}

// Pure: how much running (non-paused) time has elapsed for this timer right now.
function elapsedMs(timer: FocusTimer, now: number): number {
  const frozenAt = timer.pausedAt ?? now;
  return Math.max(0, frozenAt - timer.startedAt - timer.accumulatedPausedMs);
}

function computeRemainingSeconds(timer: FocusTimer | null, now: number): number {
  if (!timer) return 0;
  const totalMs = timer.durationMinutes * 60_000;
  return Math.max(0, Math.ceil((totalMs - elapsedMs(timer, now)) / 1000));
}

export function useFocusTimer(workspaceId: string | null): FocusTimerControls {
  const [timer, setTimer] = useState<FocusTimer | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Rehydrate whenever the workspace changes (and on mount). Recompute the
  // remaining count from wall-clock so a reload doesn't lose elapsed time.
  useEffect(() => {
    const restored = loadTimer(workspaceId);
    setTimer(restored);
    setRemainingSeconds(computeRemainingSeconds(restored, Date.now()));
  }, [workspaceId]);

  // Single ticking interval, alive only while a timer is running (not paused).
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!timer) {
      setRemainingSeconds(0);
      return;
    }
    // Always reflect the current value immediately (covers resume + rehydrate).
    setRemainingSeconds(computeRemainingSeconds(timer, Date.now()));
    if (timer.pausedAt !== null) return; // paused → frozen, no tick

    intervalRef.current = setInterval(() => {
      setRemainingSeconds(computeRemainingSeconds(timer, Date.now()));
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [timer]);

  const persist = useCallback(
    (next: FocusTimer | null) => {
      saveTimer(workspaceId, next);
      setTimer(next);
    },
    [workspaceId],
  );

  const start = useCallback(
    (input: {
      nodeId: string;
      title: string;
      durationMinutes: number;
      paused?: boolean;
    }) => {
      const now = Date.now();
      // paused start: freeze at t0 (pausedAt === startedAt, no accumulated
      // pause) → full duration remaining, no tick, and a clean "never ran yet"
      // signal for the pill to show "Start" instead of "Resume".
      persist({
        nodeId: input.nodeId,
        title: input.title,
        durationMinutes: input.durationMinutes,
        startedAt: now,
        pausedAt: input.paused ? now : null,
        accumulatedPausedMs: 0,
      });
    },
    [persist],
  );

  const pause = useCallback(() => {
    setTimer((current) => {
      if (!current || current.pausedAt !== null) return current;
      const next = { ...current, pausedAt: Date.now() };
      saveTimer(workspaceId, next);
      return next;
    });
  }, [workspaceId]);

  const resume = useCallback(() => {
    setTimer((current) => {
      if (!current || current.pausedAt === null) return current;
      const next: FocusTimer = {
        ...current,
        accumulatedPausedMs: current.accumulatedPausedMs + (Date.now() - current.pausedAt),
        pausedAt: null,
      };
      saveTimer(workspaceId, next);
      return next;
    });
  }, [workspaceId]);

  const stop = useCallback(() => {
    persist(null);
  }, [persist]);

  return { timer, remainingSeconds, start, pause, resume, stop };
}
