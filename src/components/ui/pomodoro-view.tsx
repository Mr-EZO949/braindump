"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData } from "@/types/graph";
import type { FocusTimerControls } from "@/hooks/use-focus-timer";
import { TimerIcon } from "@/components/ui/icons";

type PomodoroViewProps = {
  graphData: GraphData;
  focusTimer: FocusTimerControls;
};

// Sentinel node id for the "No task — just focus" option. The focus timer
// requires a nodeId; this gives focus-only sessions a stable, non-task id.
const FOCUS_SENTINEL = "_focus";

type Preset = { key: string; label: string; workMin: number; breakMin: number };

const PRESETS: Preset[] = [
  { key: "classic", label: "Classic", workMin: 25, breakMin: 5 },
  { key: "long", label: "Long", workMin: 50, breakMin: 10 },
  { key: "sprint", label: "Sprint", workMin: 15, breakMin: 3 },
];

type Phase = { kind: "work" | "break"; index: number };

// The FSM (phase) + config drive a PERSISTENT timer, so they must persist too —
// otherwise navigating away (unmount) or reloading mid-session orphans the
// running timer and the view freezes at "Ready". One session at a time.
const SESSION_KEY = "braindump:pomodoro-session";
type PomodoroSession = {
  selectedNodeId: string;
  presetKey: string;
  cycles: number;
  phase: Phase | null;
};
function readPomodoroSession(): Partial<PomodoroSession> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Partial<PomodoroSession>) : {};
  } catch {
    return {};
  }
}

function formatMMSS(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Title encodes the phase so the auto-advance effect can confirm the running
// timer still belongs to the phase the view thinks is active (double-fire guard).
function phaseTitle(taskTitle: string, phase: Phase): string {
  return phase.kind === "work" ? taskTitle : "Break";
}

export function PomodoroView({ graphData, focusTimer }: PomodoroViewProps) {
  const taskOptions = useMemo(
    () =>
      graphData.nodes.filter(
        (n) =>
          (n.node_type === "task" || n.node_type === "project") &&
          n.status !== "archived" &&
          n.status !== "completed",
      ),
    [graphData.nodes],
  );

  const persisted = useMemo(() => readPomodoroSession(), []);
  const [selectedNodeId, setSelectedNodeId] = useState<string>(
    () => persisted.selectedNodeId ?? focusTimer.timer?.nodeId ?? FOCUS_SENTINEL,
  );
  const [presetKey, setPresetKey] = useState<string>(() => persisted.presetKey ?? "classic");
  const [cycles, setCycles] = useState<number>(() => persisted.cycles ?? 4);
  const [phase, setPhase] = useState<Phase | null>(() => persisted.phase ?? null);
  // True once the current phase's timer has actually counted down (remaining > 0
  // seen at least once). Guards against the transient remaining===0 in the render
  // right after start() — without it the FSM advances work→break instantly.
  const phaseRanRef = useRef(false);

  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0];
  const config = { workMin: preset.workMin, breakMin: preset.breakMin, cycles };

  const selectedTask = taskOptions.find((n) => n.id === selectedNodeId);
  const taskTitle = selectedTask?.title ?? "Focus";

  const running = focusTimer.timer !== null;
  const paused = focusTimer.timer?.pausedAt != null;

  // Auto-advance FSM. When the running phase's countdown reaches zero, move on
  // to the next phase (work → break → work …). Guard against the tick reporting
  // 0 for a stale timer by confirming the running timer still matches the phase
  // the view believes is active (same title + duration).
  useEffect(() => {
    if (!phase || !focusTimer.timer) return;

    // The phase's timer is genuinely running — remember it so a later 0 is real.
    if (focusTimer.remainingSeconds > 0) {
      phaseRanRef.current = true;
      return;
    }
    // remaining === 0 but the timer never ticked for this phase yet → it's the
    // transient 0 right after start(); ignore it (don't advance prematurely).
    if (!phaseRanRef.current) return;

    const expectedTitle = phaseTitle(taskTitle, phase);
    const expectedMinutes = phase.kind === "work" ? config.workMin : config.breakMin;
    if (
      focusTimer.timer.title !== expectedTitle ||
      focusTimer.timer.durationMinutes !== expectedMinutes
    ) {
      return;
    }

    const nodeId = selectedNodeId === FOCUS_SENTINEL ? FOCUS_SENTINEL : selectedNodeId;
    phaseRanRef.current = false; // next phase starts fresh

    if (phase.kind === "work") {
      // Work just ended → start the break for this cycle.
      const next: Phase = { kind: "break", index: phase.index };
      setPhase(next);
      focusTimer.start({
        nodeId,
        title: phaseTitle(taskTitle, next),
        durationMinutes: config.breakMin,
      });
      return;
    }

    // Break just ended → either start the next cycle's work, or finish.
    if (phase.index + 1 < config.cycles) {
      const next: Phase = { kind: "work", index: phase.index + 1 };
      setPhase(next);
      focusTimer.start({
        nodeId,
        title: phaseTitle(taskTitle, next),
        durationMinutes: config.workMin,
      });
    } else {
      focusTimer.stop();
      setPhase(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTimer.remainingSeconds, phase]);

  // Persist the session so unmount (navigating to another mode) or a reload
  // mid-session restores the FSM + config instead of freezing the live timer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ selectedNodeId, presetKey, cycles, phase }),
      );
    } catch {
      /* ignore quota */
    }
  }, [selectedNodeId, presetKey, cycles, phase]);

  const handleStart = () => {
    const next: Phase = { kind: "work", index: 0 };
    phaseRanRef.current = false; // ignore the transient 0 until the timer ticks
    setPhase(next);
    focusTimer.start({
      nodeId: selectedNodeId === FOCUS_SENTINEL ? FOCUS_SENTINEL : selectedNodeId,
      title: phaseTitle(taskTitle, next),
      durationMinutes: config.workMin,
    });
  };

  const handleStop = () => {
    phaseRanRef.current = false;
    focusTimer.stop();
    setPhase(null);
  };

  // Display: live remaining when running, else the full work duration as a preview.
  const displaySeconds = running ? focusTimer.remainingSeconds : config.workMin * 60;

  const phaseLabel = phase
    ? phase.kind === "work"
      ? `Focus · cycle ${phase.index + 1} of ${config.cycles}`
      : `Break · cycle ${phase.index + 1} of ${config.cycles}`
    : "Ready";

  return (
    <div className="pomodoro-view">
      <div className="pomodoro-card">
        <div className="pomodoro-header">
          <TimerIcon className="h-[18px] w-[18px]" />
          <span>Pomodoro</span>
        </div>

        <div className="pomodoro-field">
          <label className="pomodoro-label" htmlFor="pomodoro-task">
            Task
          </label>
          <select
            id="pomodoro-task"
            className="pomodoro-select"
            value={selectedNodeId}
            onChange={(e) => setSelectedNodeId(e.target.value)}
            disabled={running}
          >
            <option value={FOCUS_SENTINEL}>No task — just focus</option>
            {taskOptions.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>

        <div className="pomodoro-field">
          <span className="pomodoro-label">Session</span>
          <div className="pomodoro-presets">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="pomodoro-preset"
                data-active={presetKey === p.key}
                aria-pressed={presetKey === p.key}
                onClick={() => setPresetKey(p.key)}
                disabled={running}
              >
                <span className="pomodoro-preset-name">{p.label}</span>
                <span className="pomodoro-preset-detail">
                  {p.workMin}/{p.breakMin}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="pomodoro-field">
          <span className="pomodoro-label">Cycles</span>
          <div className="pomodoro-stepper">
            <button
              type="button"
              className="pomodoro-step-btn"
              onClick={() => setCycles((c) => Math.max(1, c - 1))}
              disabled={running || cycles <= 1}
              aria-label="Fewer cycles"
            >
              −
            </button>
            <span className="pomodoro-step-value">{cycles}</span>
            <button
              type="button"
              className="pomodoro-step-btn"
              onClick={() => setCycles((c) => Math.min(12, c + 1))}
              disabled={running || cycles >= 12}
              aria-label="More cycles"
            >
              +
            </button>
          </div>
        </div>

        <div className="pomodoro-countdown" data-phase={phase?.kind ?? "idle"}>
          {formatMMSS(displaySeconds)}
        </div>

        <div className="pomodoro-phase">{phaseLabel}</div>

        <div className="pomodoro-dots" aria-hidden="true">
          {Array.from({ length: config.cycles }, (_, i) => {
            const state = !phase
              ? "pending"
              : i < phase.index
                ? "done"
                : i === phase.index
                  ? "active"
                  : "pending";
            return <span key={i} className="pomodoro-dot" data-state={state} />;
          })}
        </div>

        <div className="pomodoro-controls">
          {!running ? (
            <button type="button" className="pomodoro-btn pomodoro-btn-primary" onClick={handleStart}>
              Start
            </button>
          ) : (
            <>
              {paused ? (
                <button
                  type="button"
                  className="pomodoro-btn pomodoro-btn-primary"
                  onClick={focusTimer.resume}
                >
                  Resume
                </button>
              ) : (
                <button type="button" className="pomodoro-btn" onClick={focusTimer.pause}>
                  Pause
                </button>
              )}
              <button type="button" className="pomodoro-btn pomodoro-btn-ghost" onClick={handleStop}>
                Stop
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
