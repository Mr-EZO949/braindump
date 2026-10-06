"use client";

// The Focus Zone — the fullscreen place "Work on this" (Focus) and "Start
// working" (Details) open. Lights down, one thing on screen: the task, the
// time Focus suggested, and Start. Nothing runs until the user presses it.
// While it runs, the ember field breathes slowly and the ring fills; at the
// end it asks once whether the thing got done.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import type { FocusTimer } from "@/hooks/use-focus-timer";

export type FocusZoneStep = { id: string; title: string; done: boolean };

type FocusZoneProps = {
  title: string;
  /** "in Pass Statistics" — where the step lives. */
  context: string | null;
  /** Why this, now — Focus's hero line. */
  reason: string | null;
  /** What Focus suggested; the user can change it before starting. */
  suggestedMinutes: number;
  /** The running session when it is this node's, else null. */
  timer: FocusTimer | null;
  remainingSeconds: number;
  steps: FocusZoneStep[];
  onStart: (minutes: number) => void;
  onPause: () => void;
  onResume: () => void;
  onExtend: (minutes: number) => void;
  onFinish: (completed: boolean) => void;
  onStepOut: () => void;
  onToggleStep: (stepId: string, done: boolean) => void;
};

const MIN_MINUTES = 5;
const MAX_MINUTES = 180;
const STEP_MINUTES = 5;
const EXTRA_MINUTES = 10;
const RING_R = 180;
const RING_C = 2 * Math.PI * RING_R;
const EASE = [0.16, 1, 0.3, 1] as const;

function clock(totalSeconds: number): { mm: string; ss: string } {
  const safe = Math.max(0, Math.round(totalSeconds));
  return { mm: String(Math.floor(safe / 60)), ss: String(safe % 60).padStart(2, "0") };
}

// A soft two-note bell when time is up — no audio file, nothing to load.
function chime() {
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [659.25, 987.77].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + i * 0.22;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 1.9);
    });
    window.setTimeout(() => void ctx.close(), 2600);
  } catch {
    // Sound is a nicety; the screen already says time's up.
  }
}

export function FocusZone({
  title,
  context,
  reason,
  suggestedMinutes,
  timer,
  remainingSeconds,
  steps,
  onStart,
  onPause,
  onResume,
  onExtend,
  onFinish,
  onStepOut,
  onToggleStep,
}: FocusZoneProps) {
  // The user's own length, once they pick one; until then the suggestion
  // (which can arrive a moment late, from today's plan).
  const [chosen, setChosen] = useState<number | null>(null);
  const minutes = chosen ?? suggestedMinutes;

  const phase: "ready" | "running" | "done" = !timer ? "ready" : remainingSeconds <= 0 ? "done" : "running";
  const paused = timer?.pausedAt != null;
  const totalSeconds = timer ? timer.durationMinutes * 60 : minutes * 60;
  const shownSeconds = phase === "ready" ? minutes * 60 : remainingSeconds;
  const progress = phase === "ready" ? 0 : phase === "done" ? 1 : 1 - remainingSeconds / totalSeconds;
  const { mm, ss } = clock(shownSeconds);
  const headAngle = progress * 2 * Math.PI - Math.PI / 2;

  // Time's up while the Zone is open → the bell, once.
  const prevRemaining = useRef(remainingSeconds);
  useEffect(() => {
    if (timer && prevRemaining.current > 0 && remainingSeconds <= 0) chime();
    prevRemaining.current = remainingSeconds;
  }, [remainingSeconds, timer]);

  // The tab title counts down, so a glance at the tab bar is enough.
  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);
  useEffect(() => {
    if (phase === "running" && !paused) document.title = `${mm}:${ss} — ${title}`;
    else if (phase === "done") document.title = `Time's up — ${title}`;
  }, [mm, ss, phase, paused, title]);

  const setLength = (next: number) => setChosen(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, next)));

  // Esc steps out; Space starts / pauses when no button has focus.
  const keyRef = useRef({ phase, paused, minutes, onStart, onPause, onResume, onStepOut });
  useEffect(() => {
    keyRef.current = { phase, paused, minutes, onStart, onPause, onResume, onStepOut };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        k.onStepOut();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (e.code !== "Space" || target?.closest("button, input, textarea, [contenteditable]")) return;
      e.preventDefault();
      if (k.phase === "ready") k.onStart(k.minutes);
      else if (k.phase === "running") (k.paused ? k.onResume : k.onPause)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const doneSteps = steps.filter((step) => step.done).length;

  return (
    <motion.div
      animate={{ opacity: 1 }}
      aria-label="Focus zone"
      aria-modal="true"
      className="fz"
      data-paused={paused || undefined}
      data-phase={phase}
      exit={{ opacity: 0, transition: { duration: 0.35, ease: EASE } }}
      initial={{ opacity: 0 }}
      role="dialog"
      transition={{ duration: 0.6, ease: EASE }}
    >
      <div className="fz-field" aria-hidden="true">
        <span className="fz-ember fz-ember--a" />
        <span className="fz-ember fz-ember--b" />
        <span className="fz-ember fz-ember--c" />
        <span className="fz-grain" />
      </div>

      <button className="fz-stepout" onClick={onStepOut} type="button">
        {phase === "ready" ? "Close" : "Step out"}
      </button>

      <div className="fz-stage">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="fz-task"
          initial={{ opacity: 0, y: 14 }}
          layout
          transition={{ duration: 0.7, ease: EASE, delay: 0.1 }}
        >
          {context ? <span className="fz-context">in {context}</span> : null}
          <h1 className="fz-title">{title}</h1>
          {reason && phase === "ready" ? <p className="fz-reason">{reason}</p> : null}
        </motion.div>

        <motion.div
          animate={{ opacity: 1, scale: 1 }}
          className="fz-ring-wrap"
          initial={{ opacity: 0, scale: 0.94 }}
          layout
          transition={{ duration: 0.9, ease: EASE, delay: 0.18 }}
        >
          <svg className="fz-ring" viewBox="0 0 400 400" aria-hidden="true">
            <defs>
              <linearGradient id="fz-arc" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="#f0a35e" />
                <stop offset="55%" stopColor="#d53a47" />
                <stop offset="100%" stopColor="#a8233a" />
              </linearGradient>
            </defs>
            <circle className="fz-ring-track" cx="200" cy="200" r={RING_R} />
            <circle
              className="fz-ring-arc"
              cx="200"
              cy="200"
              r={RING_R}
              stroke="url(#fz-arc)"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - progress)}
              transform="rotate(-90 200 200)"
            />
            {phase !== "ready" ? (
              <circle
                className="fz-ring-head"
                cx={200 + RING_R * Math.cos(headAngle)}
                cy={200 + RING_R * Math.sin(headAngle)}
                r="7"
              />
            ) : null}
          </svg>
          <div className="fz-time" role="timer" aria-live="off">
            {phase === "done" ? (
              <span className="fz-time-up">Time&rsquo;s up</span>
            ) : (
              <span className="fz-digits">
                {mm}
                <span className="fz-colon">:</span>
                {ss}
              </span>
            )}
            <span className="fz-time-sub">
              {phase === "ready"
                ? minutes === suggestedMinutes
                  ? "suggested for this"
                  : `Focus suggested ${suggestedMinutes} min`
                : phase === "done"
                  ? `${timer?.durationMinutes ? Math.round(timer.durationMinutes) : minutes} minutes in`
                  : paused
                    ? "paused"
                    : `of ${Math.round(timer?.durationMinutes ?? minutes)} min`}
            </span>
          </div>
        </motion.div>

        <AnimatePresence initial={false} mode="wait">
          {phase === "ready" ? (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="fz-controls"
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 10 }}
              key="ready"
              transition={{ duration: 0.4, ease: EASE, delay: 0.25 }}
            >
              <div className="fz-length" role="group" aria-label="Session length">
                <button
                  aria-label="5 minutes less"
                  className="fz-length-btn"
                  disabled={minutes <= MIN_MINUTES}
                  onClick={() => setLength(minutes - STEP_MINUTES)}
                  type="button"
                >
                  −
                </button>
                <span className="fz-length-value">{minutes} min</span>
                <button
                  aria-label="5 minutes more"
                  className="fz-length-btn"
                  disabled={minutes >= MAX_MINUTES}
                  onClick={() => setLength(minutes + STEP_MINUTES)}
                  type="button"
                >
                  +
                </button>
              </div>
              {minutes !== suggestedMinutes ? (
                <button className="fz-quiet" onClick={() => setLength(suggestedMinutes)} type="button">
                  Back to {suggestedMinutes} min
                </button>
              ) : null}
              <button autoFocus className="fz-start" onClick={() => onStart(minutes)} type="button">
                Start focusing
              </button>
            </motion.div>
          ) : phase === "running" ? (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="fz-controls fz-controls--row"
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 10 }}
              key="running"
              transition={{ duration: 0.4, ease: EASE }}
            >
              <button className="fz-ghost" onClick={paused ? onResume : onPause} type="button">
                {paused ? "Resume" : "Pause"}
              </button>
              <button className="fz-ghost fz-ghost--strong" onClick={() => onFinish(true)} type="button">
                I finished it
              </button>
              <button className="fz-quiet" onClick={() => onFinish(false)} type="button">
                End session
              </button>
            </motion.div>
          ) : (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="fz-controls"
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 10 }}
              key="done"
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className="fz-ask">Did you finish it?</p>
              <button autoFocus className="fz-start" onClick={() => onFinish(true)} type="button">
                Yes, mark it done
              </button>
              <div className="fz-controls--row">
                <button className="fz-ghost" onClick={() => onExtend(EXTRA_MINUTES)} type="button">
                  {EXTRA_MINUTES} more minutes
                </button>
                <button className="fz-ghost" onClick={() => onFinish(false)} type="button">
                  Not yet, keep it on my list
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {steps.length > 0 ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="fz-steps"
            initial={{ opacity: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
          >
            <p className="fz-steps-count">
              {doneSteps} of {steps.length} steps done
            </p>
            <ul>
              {steps.map((step) => (
                <li key={step.id}>
                  <button
                    aria-pressed={step.done}
                    className="fz-step"
                    data-done={step.done || undefined}
                    onClick={() => onToggleStep(step.id, !step.done)}
                    type="button"
                  >
                    <span className="fz-step-box" aria-hidden="true" />
                    <span className="fz-step-title">{step.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </div>
    </motion.div>
  );
}

/** After stepping out of a running session: one small way back in. */
export function FocusReturnChip({
  title,
  remainingSeconds,
  paused,
  onReturn,
}: {
  title: string;
  remainingSeconds: number;
  paused: boolean;
  onReturn: () => void;
}) {
  const { mm, ss } = clock(remainingSeconds);
  return (
    <motion.button
      animate={{ opacity: 1, y: 0 }}
      className="fz-return"
      data-paused={paused || undefined}
      exit={{ opacity: 0, y: 10 }}
      initial={{ opacity: 0, y: 10 }}
      onClick={onReturn}
      title={`Back to ${title}`}
      transition={{ duration: 0.3, ease: EASE }}
      type="button"
    >
      <span className="fz-return-dot" aria-hidden="true" />
      <span className="fz-return-title">{title}</span>
      <span className="fz-return-time">{remainingSeconds > 0 ? `${mm}:${ss}` : "time's up"}</span>
    </motion.button>
  );
}
