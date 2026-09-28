"use client";

import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  PencilIcon,
  PlusIcon,
} from "@/components/ui/icons";
import {
  PlannerPanel,
  INITIAL_PLANNER_STATE,
  type GeneratePlanOptions,
  type PlannerState,
} from "@/components/panel/planner-panel";
import type { PlanBlock, PlanSession, PlanningWindow } from "@/types/ai";
import type { GraphData, NodeStatus } from "@/types/graph";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { clientDayHints } from "@/lib/habits/streak";
import { localDateISO } from "@/lib/time/local-date";

// ── Types ──────────────────────────────────────────────────────────────────────

type PlanTask = {
  id: string;
  title: string;
  done: boolean;
  date: string | null; // "YYYY-MM-DD" or null = unscheduled
  start_time: string | null; // "HH:MM"
  duration_minutes: number | null;
  created_at: string;
  completed_at: string | null;
  node_id?: string | null; // set on tasks created from AI plan blocks
};

type PlanTaskRow = {
  created_at: string;
  done: boolean;
  duration_minutes: number | null;
  id: string;
  node_id: string | null;
  scheduled_date: string | null;
  start_time: string | null;
  title: string;
};

type TaskDraft = {
  title: string;
  date: string;
  startTime: string;
  durationMinutes: string;
};

type TaskComposerPlacement =
  | { kind: "inline" }
  | { kind: "timeline-overlay"; top: number; left: number };

// Pending state for the replan clarifying modal: the plan tasks waiting to be
// written, the day they target, and the ids of that day's existing plan tasks
// (deleted on REPLACE).
type ReplanPrompt = {
  targetDate: string;
  newTasks: PlanTask[];
  existingTaskIds: string[];
};

type TaskEditorState =
  | {
      mode: "create";
      key: string;
      draft: TaskDraft;
      placement: TaskComposerPlacement;
    }
  | {
      mode: "edit";
      key: string;
      taskId: string;
      draft: TaskDraft;
    };

// ── Module-level helpers (defined outside the component to keep stable identity) ─

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const DEFAULT_TASK_DURATION_MINUTES = 60;
const DEFAULT_TASK_START_TIME = "09:00";
const DURATION_PRESETS = [30, 60, 90, 120];
const TIMELINE_SNAP_MINUTES = 15;
const TIMELINE_MIN_DURATION_MINUTES = 15;
const DEFAULT_DAY_PLAN_START_MINUTES = 9 * 60;

function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function normalizeStoredTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(normalized);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function parseTimeToMinutes(value: string | null): number | null {
  if (!value || !isValidTimeString(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinutesToTaskTime(value: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, value));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function snapMinutes(value: number, step: number = TIMELINE_SNAP_MINUTES): number {
  return Math.round(value / step) * step;
}

function clampTaskStartMinutes(startMinutes: number, durationMinutes: number): number {
  const maxStart = Math.max(0, 24 * 60 - Math.max(TIMELINE_MIN_DURATION_MINUTES, durationMinutes));
  return Math.max(0, Math.min(maxStart, startMinutes));
}

function clampTaskDurationMinutes(durationMinutes: number, startMinutes: number): number {
  const maxDuration = Math.max(TIMELINE_MIN_DURATION_MINUTES, 24 * 60 - Math.max(0, startMinutes));
  return Math.max(TIMELINE_MIN_DURATION_MINUTES, Math.min(maxDuration, durationMinutes));
}

function formatMinutesToTime(value: number): string {
  const minutesInDay = 24 * 60;
  const normalized = ((value % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function formatStartTime(value: string | null): string | null {
  const minutes = parseTimeToMinutes(value);
  return minutes === null ? null : formatMinutesToTime(minutes);
}

function formatEndTime(startTime: string | null, durationMinutes: number | null): string | null {
  const startMinutes = parseTimeToMinutes(startTime);
  if (startMinutes === null || durationMinutes === null) return null;
  return formatMinutesToTime(startMinutes + durationMinutes);
}

function formatTimeRange(startTime: string | null, durationMinutes: number | null): string | null {
  const startLabel = formatStartTime(startTime);
  if (!startLabel) return null;
  const endLabel = formatEndTime(startTime, durationMinutes);
  return endLabel ? `${startLabel} - ${endLabel}` : startLabel;
}

function sanitizeTaskDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.max(1, Math.round(value));
}

function sanitizeTaskTime(value: unknown): string | null {
  return normalizeStoredTime(value);
}

function sanitizeTaskDate(value: unknown): string | null {
  return typeof value === "string" && isValidDateString(value) ? value : null;
}

function inferCreatedAt(id: string): string {
  const match = /^t-(\d+)$/.exec(id);
  if (!match) return new Date().toISOString();

  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp)) return new Date().toISOString();

  return new Date(timestamp).toISOString();
}

function getDefaultStartTime(date: string | null): string {
  const now = new Date();
  if (!date || date !== toDateString(now)) {
    return DEFAULT_TASK_START_TIME;
  }

  const roundedMinutes = Math.min(
    23 * 60 + 30,
    Math.ceil((now.getHours() * 60 + now.getMinutes() + 15) / 30) * 30,
  );
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function getCurrentTimeOfDayMinutes(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

function getPlanTaskAnchorMinutes(
  planningWindow: PlanningWindow | null | undefined,
  date: string,
  totalMinutes: number,
  startTime?: string | null,
): number {
  // An explicit clock start ("At a time") always wins over the window default.
  const explicitStartMinutes = parseTimeToMinutes(startTime ?? null);

  const preferredStartMinutes =
    explicitStartMinutes !== null
      ? explicitStartMinutes
      : planningWindow === "day"
        ? DEFAULT_DAY_PLAN_START_MINUTES
        : parseTimeToMinutes(getDefaultStartTime(date)) ?? DEFAULT_DAY_PLAN_START_MINUTES;

  return clampTaskStartMinutes(preferredStartMinutes, totalMinutes);
}

function createTaskDraft(task?: Partial<PlanTask> | null, fallbackDate?: string | null): TaskDraft {
  const date = task?.date ?? fallbackDate ?? "";
  return {
    title: task?.title ?? "",
    date,
    startTime: task?.start_time ?? getDefaultStartTime(date || null),
    durationMinutes: String(task?.duration_minutes ?? DEFAULT_TASK_DURATION_MINUTES),
  };
}

function normalizeTask(raw: unknown): PlanTask | null {
  if (!raw || typeof raw !== "object") return null;

  const task = raw as Record<string, unknown>;
  if (typeof task.id !== "string" || typeof task.title !== "string") {
    return null;
  }

  const createdAt =
    typeof task.created_at === "string" && !Number.isNaN(Date.parse(task.created_at))
      ? task.created_at
      : inferCreatedAt(task.id);
  const completedAt =
    typeof task.completed_at === "string" && !Number.isNaN(Date.parse(task.completed_at))
      ? task.completed_at
      : null;

  return {
    id: task.id,
    title: task.title,
    done: Boolean(task.done),
    date: sanitizeTaskDate(task.date ?? task.scheduled_date),
    start_time: sanitizeTaskTime(task.start_time),
    duration_minutes: sanitizeTaskDuration(task.duration_minutes),
    created_at: createdAt,
    completed_at: completedAt,
    node_id: typeof task.node_id === "string" ? task.node_id : null,
  };
}

function normalizeTaskList(rawTasks: unknown[]): PlanTask[] {
  return rawTasks
    .map(normalizeTask)
    .filter((task): task is PlanTask => Boolean(task))
    .sort(compareTasks);
}

// Tasks created from an AI plan are tagged two ways depending on the storage
// path: local/legacy tasks keep their "plan-" id prefix, while DB-backed tasks
// get a fresh UUID but carry the source block's node_id (see PlanTask.node_id).
// Either signal marks a task as plan-derived for a given day, which is how we
// detect "this day already has a plan" at accept time.
function findPlanTasksForDate(allTasks: PlanTask[], date: string): PlanTask[] {
  return allTasks.filter(
    (task) =>
      task.date === date && (task.id.startsWith("plan-") || task.node_id != null),
  );
}

function toPlanTaskInsert(
  task: PlanTask,
  workspaceId: string,
  userId: string,
): Omit<PlanTaskRow, "id"> & {
  user_id: string;
  workspace_id: string;
} {
  return {
    user_id: userId,
    workspace_id: workspaceId,
    title: task.title,
    done: task.done,
    scheduled_date: task.date,
    start_time: task.start_time,
    duration_minutes: task.duration_minutes,
    created_at: task.created_at,
    node_id: task.node_id ?? null,
  };
}

function compareTasks(a: PlanTask, b: PlanTask): number {
  const aHasTime = Boolean(a.start_time);
  const bHasTime = Boolean(b.start_time);
  if (aHasTime !== bHasTime) {
    return aHasTime ? -1 : 1;
  }

  const aTime = parseTimeToMinutes(a.start_time) ?? Number.MAX_SAFE_INTEGER;
  const bTime = parseTimeToMinutes(b.start_time) ?? Number.MAX_SAFE_INTEGER;
  if (aTime !== bTime) {
    return aTime - bTime;
  }

  if (a.done !== b.done) {
    return a.done ? 1 : -1;
  }

  const aCreated = Date.parse(a.created_at);
  const bCreated = Date.parse(b.created_at);
  if (aCreated !== bCreated) {
    return aCreated - bCreated;
  }

  return a.title.localeCompare(b.title);
}

type TaskRowProps = {
  task: PlanTask;
  onToggle: (id: string) => void;
  onEdit: (task: PlanTask) => void;
  onDelete: (id: string) => void;
};

function TaskRow({ task, onToggle, onEdit, onDelete }: TaskRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timeRange = formatTimeRange(task.start_time, task.duration_minutes);
  const hasTiming = Boolean(task.start_time);

  const timeLabel = timeRange ?? (task.date ? "Any time" : "Unscheduled");

  return (
    <div
      className="planner-task-card"
      data-done={task.done || undefined}
      data-timed={hasTiming || undefined}
    >
      {confirmDelete ? (
        <div className="planner-task-confirm-delete">
          <span className="planner-task-confirm-label">Remove this task?</span>
          <div className="planner-task-confirm-actions">
            <button
              className="planner-task-confirm-cancel"
              onClick={() => setConfirmDelete(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="planner-task-confirm-ok"
              onClick={() => onDelete(task.id)}
              type="button"
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            aria-label={task.done ? "Mark undone" : "Mark done"}
            className={`planner-task-check${task.done ? " planner-task-check-done" : ""}`}
            onClick={() => onToggle(task.id)}
            type="button"
          >
            {task.done ? (
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
                <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>

          <div className="planner-task-body">
            <span className={`planner-task-title${task.done ? " planner-task-title-done" : ""}`}>
              {task.title}
            </span>
            <div className="planner-task-meta">
              <span className="planner-task-time-label">{timeLabel}</span>
              {task.duration_minutes ? (
                <span className="planner-task-duration-pill">
                  {formatDuration(task.duration_minutes)}
                </span>
              ) : null}
            </div>
          </div>

          <div className="planner-task-actions">
            <button
              aria-label="Edit task"
              className="planner-task-action"
              onClick={() => onEdit(task)}
              type="button"
            >
              <PencilIcon className="h-2.5 w-2.5" />
            </button>
            <button
              aria-label="Delete task"
              className="planner-task-action planner-task-delete"
              onClick={() => setConfirmDelete(true)}
              type="button"
            >
              <CloseIcon className="h-2.5 w-2.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type TaskComposerProps = {
  initialDraft: TaskDraft;
  submitLabel: string;
  compact?: boolean;
  onSubmit: (draft: {
    title: string;
    date: string | null;
    start_time: string | null;
    duration_minutes: number | null;
  }) => void;
  onCancel: () => void;
};

function TaskComposer({
  initialDraft,
  submitLabel,
  compact = false,
  onSubmit,
  onCancel,
}: TaskComposerProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(initialDraft.title);
  const [date, setDate] = useState(initialDraft.date);
  const [startTime, setStartTime] = useState(initialDraft.startTime);
  const [durationMinutes, setDurationMinutes] = useState(initialDraft.durationMinutes);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const hasDate = Boolean(date);
  const normalizedDuration =
    sanitizeTaskDuration(Number(durationMinutes)) ?? DEFAULT_TASK_DURATION_MINUTES;
  const preview = hasDate
    ? formatTimeRange(startTime, normalizedDuration) ?? "Set a start time"
    : "Unscheduled";

  const handleSubmit = () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      onCancel();
      return;
    }

    const sanitizedDate = sanitizeTaskDate(date);
    const sanitizedStartTime = sanitizedDate
      ? sanitizeTaskTime(startTime) ?? getDefaultStartTime(sanitizedDate)
      : null;

    onSubmit({
      title: trimmedTitle,
      date: sanitizedDate,
      start_time: sanitizedStartTime,
      duration_minutes: sanitizeTaskDuration(Number(durationMinutes)),
    });
  };

  const keyDownHandler = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
  };

  if (compact) {
    return (
      <div className="planner-task-editor-compact" onKeyDown={keyDownHandler}>
        <input
          ref={titleRef}
          className="planner-add-input"
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title…"
          type="text"
          value={title}
        />
        <div className="planner-task-editor-compact-row">
          <label className="planner-task-editor-compact-field">
            <span className="planner-task-editor-compact-label">Starts</span>
            <input
              className="planner-task-field-input planner-compact-time"
              onChange={(e) => setStartTime(e.target.value)}
              type="time"
              value={startTime}
            />
          </label>
          <label className="planner-task-editor-compact-field">
            <span className="planner-task-editor-compact-label">Duration</span>
            <input
              className="planner-task-field-input planner-compact-duration"
              min="1"
              onChange={(e) => setDurationMinutes(e.target.value)}
              step="1"
              type="number"
              value={durationMinutes}
            />
          </label>
          <span className="planner-task-editor-compact-unit">min</span>
        </div>
        <div
          className="planner-task-duration-presets planner-task-duration-presets-compact"
          role="group"
          aria-label="Duration presets"
        >
          {DURATION_PRESETS.map((minutes) => (
            <button
              key={minutes}
              className="planner-task-duration-preset"
              data-active={normalizedDuration === minutes}
              onClick={() => setDurationMinutes(String(minutes))}
              type="button"
            >
              {formatDuration(minutes)}
            </button>
          ))}
        </div>
        <div className="planner-task-editor-footer">
          <span className="planner-task-editor-preview">{preview}</span>
          <div className="planner-task-editor-actions">
            <button className="planner-task-editor-cancel" onClick={onCancel} type="button">
              Cancel
            </button>
            <button className="planner-task-editor-save" onClick={handleSubmit} type="button">
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="planner-add-row planner-task-editor"
      onKeyDown={keyDownHandler}
    >
      <input
        ref={titleRef}
        className="planner-add-input"
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        type="text"
        value={title}
      />
      <div className="planner-task-editor-grid">
        <label className="planner-task-field">
          <span className="planner-task-field-label">Date</span>
          <div className="planner-task-date-row">
            <input
              className="planner-task-field-input"
              onChange={(e) => {
                const nextDate = e.target.value;
                setDate(nextDate);
                if (nextDate && !isValidTimeString(startTime)) {
                  setStartTime(getDefaultStartTime(nextDate));
                }
              }}
              type="date"
              value={date}
            />
            <button
              className="planner-task-unscheduled-toggle"
              data-active={!hasDate}
              onClick={() => setDate("")}
              type="button"
            >
              No date
            </button>
          </div>
        </label>
        <label className="planner-task-field">
          <span className="planner-task-field-label">Starts</span>
          <input
            className="planner-task-field-input"
            disabled={!hasDate}
            onChange={(e) => setStartTime(e.target.value)}
            type="time"
            value={hasDate ? startTime : ""}
          />
        </label>
        <label className="planner-task-field">
          <span className="planner-task-field-label">Duration</span>
          <input
            className="planner-task-field-input"
            min="5"
            onChange={(e) => setDurationMinutes(e.target.value)}
            step="5"
            type="number"
            value={durationMinutes}
          />
        </label>
      </div>
      <div className="planner-task-duration-presets" role="group" aria-label="Duration presets">
        {DURATION_PRESETS.map((minutes) => (
          <button
            key={minutes}
            className="planner-task-duration-preset"
            data-active={normalizedDuration === minutes}
            onClick={() => setDurationMinutes(String(minutes))}
            type="button"
          >
            {formatDuration(minutes)}
          </button>
        ))}
      </div>
      <div className="planner-task-editor-footer">
        <span className="planner-task-editor-preview">{preview}</span>
        <div className="planner-task-editor-actions">
          <button className="planner-task-editor-cancel" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="planner-task-editor-save" onClick={handleSubmit} type="button">
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Storage helpers ────────────────────────────────────────────────────────────

function sk(prefix: string, workspaceId: string | null) {
  return `tr_${prefix}_${workspaceId ?? "null"}`;
}

function loadTasks(workspaceId: string | null): PlanTask[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(sk("tasks", workspaceId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTask).filter((task): task is PlanTask => Boolean(task));
  } catch {
    return [];
  }
}

function saveTasks(workspaceId: string | null, tasks: PlanTask[]) {
  localStorage.setItem(sk("tasks", workspaceId), JSON.stringify(tasks));
}

function clearSavedTasks(workspaceId: string | null) {
  localStorage.removeItem(sk("tasks", workspaceId));
}

// ── Planner helpers ────────────────────────────────────────────────────────────

function sortPlanBlocks(blocks: PlanBlock[]): PlanBlock[] {
  return [...blocks].sort((a, b) => a.start_offset - b.start_offset);
}

// ── Date helpers ───────────────────────────────────────────────────────────────

// The user's LOCAL calendar date for d. This used d.toISOString() — the UTC
// date — so the planner showed "yesterday" after local midnight east of UTC
// (00:00–02:00 in Milan) and "tomorrow" all evening west of it (US), and filed
// new tasks under the wrong scheduled_date.
function toDateString(d: Date): string {
  return localDateISO(d);
}

function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay();
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    return dd;
  });
}

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const QUICK_ACTIONS: { label: string; window: PlanningWindow }[] = [
  { label: "1h focus", window: "1h" },
  { label: "2h session", window: "2h" },
  { label: "Plan today", window: "day" },
];

// ── Timeline ───────────────────────────────────────────────────────────────────

const HOUR_HEIGHT = 56; // px per hour
const TIMELINE_DEFAULT_START = 8;
const TIMELINE_DEFAULT_END = 20;

function fmtHour(h: number): string {
  return `${h.toString().padStart(2, "0")}:00`;
}

type AnyTimeChipProps = {
  task: PlanTask;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function AnyTimeChip({ task, onToggle, onEdit, onDelete }: AnyTimeChipProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (confirmDelete) {
    return (
      <div className="anytime-chip anytime-chip-confirm">
        <span className="anytime-chip-confirm-label">Remove?</span>
        <button className="planner-task-confirm-cancel" onClick={() => setConfirmDelete(false)} type="button">Cancel</button>
        <button className="planner-task-confirm-ok" onClick={onDelete} type="button">Delete</button>
      </div>
    );
  }
  return (
    <div className={`anytime-chip${task.done ? " anytime-chip-done" : ""}`}>
      <button
        className={`timeline-event-check${task.done ? " timeline-event-check-done" : ""}`}
        onClick={onToggle}
        type="button"
      >
        {task.done ? (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
            <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </button>
      <span className={`anytime-chip-title${task.done ? " anytime-chip-title-done" : ""}`} onClick={onEdit}>{task.title}</span>
      <button className="anytime-chip-del" onClick={() => setConfirmDelete(true)} type="button">
        <CloseIcon className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

// Assign side-by-side columns to timeline events that overlap in time, so
// concurrent tasks render next to each other instead of stacked on the same
// pixels (journal #6a). Events are grouped into clusters of transitively-
// overlapping intervals; within a cluster each event takes the first free
// column. Returns id → { lane, laneCount } where laneCount is the cluster width.
function computeTimelineLanes(
  tasks: { id: string; start_time: string | null; duration_minutes: number | null }[],
): Map<string, { lane: number; laneCount: number }> {
  const result = new Map<string, { lane: number; laneCount: number }>();
  const evs = tasks
    .map((t) => {
      const start = parseTimeToMinutes(t.start_time);
      if (start === null) return null;
      const dur = Math.max(
        TIMELINE_MIN_DURATION_MINUTES,
        t.duration_minutes ?? DEFAULT_TASK_DURATION_MINUTES,
      );
      return { id: t.id, start, end: start + dur };
    })
    .filter((e): e is { id: string; start: number; end: number } => e !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let cluster: { id: string; start: number; end: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (cluster.length === 0) return;
    const colEnds: number[] = []; // last end-minute per column
    const colOf = new Map<string, number>();
    for (const e of cluster) {
      let col = colEnds.findIndex((end) => end <= e.start);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(e.end);
      } else {
        colEnds[col] = e.end;
      }
      colOf.set(e.id, col);
    }
    const laneCount = colEnds.length;
    for (const e of cluster) result.set(e.id, { lane: colOf.get(e.id) ?? 0, laneCount });
  };
  for (const e of evs) {
    if (cluster.length > 0 && e.start >= clusterEnd) {
      flush();
      cluster = [];
      clusterEnd = -1;
    }
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return result;
}

type TimelineEventProps = {
  task: PlanTask;
  startHour: number;
  startMinutes: number;
  durationMinutes: number;
  lane?: number;
  laneCount?: number;
  isInteracting: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMoveStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
};

function TimelineEvent({
  task,
  startHour,
  startMinutes,
  durationMinutes,
  lane = 0,
  laneCount = 1,
  isInteracting,
  onToggle,
  onEdit,
  onDelete,
  onMoveStart,
  onResizeStart,
}: TimelineEventProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const top = (startMinutes / 60 - startHour) * HOUR_HEIGHT;
  const height = Math.max((durationMinutes / 60) * HOUR_HEIGHT, 28);
  const isShort = height < 46;
  const timeLabel = formatTimeRange(formatMinutesToTaskTime(startMinutes), durationMinutes);

  // When events overlap in time, split them into side-by-side columns instead
  // of stacking on the same pixels (journal #6a). Single events keep the full
  // width (left/right come from the CSS).
  const laneStyle =
    laneCount > 1
      ? {
          left: `calc(4px + ${(lane / laneCount) * 100}% )`,
          width: `calc(${100 / laneCount}% - ${(4 * (laneCount + 1)) / laneCount}px)`,
          right: "auto" as const,
        }
      : null;

  return (
    <div
      className={`timeline-event${task.done ? " timeline-event-done" : ""}${confirmDelete ? " timeline-event-confirming" : ""}`}
      data-interacting={isInteracting || undefined}
      style={{ top, height, ...laneStyle }}
    >
      {confirmDelete ? (
        <div className="timeline-event-confirm">
          <span className="timeline-event-confirm-label">Remove?</span>
          <div className="timeline-event-confirm-actions">
            <button className="planner-task-confirm-cancel" onClick={() => setConfirmDelete(false)} type="button">Cancel</button>
            <button className="planner-task-confirm-ok" onClick={onDelete} type="button">Delete</button>
          </div>
        </div>
      ) : (
        <>
          <button
            className={`timeline-event-check${task.done ? " timeline-event-check-done" : ""}`}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            type="button"
          >
            {task.done ? (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
                <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
          <div
            className="timeline-event-body"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            onPointerDown={onMoveStart}
          >
            <span className="timeline-event-title">{task.title}</span>
            {!isShort && timeLabel ? (
              <span className="timeline-event-time">{timeLabel}</span>
            ) : null}
          </div>
          <button
            className="timeline-event-del"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
            type="button"
          >
            <CloseIcon className="h-2.5 w-2.5" />
          </button>
          <button
            aria-label={`Resize ${task.title}`}
            className="timeline-event-resize"
            onPointerDown={onResizeStart}
            type="button"
          >
            <span className="timeline-event-resize-grip" />
          </button>
        </>
      )}
    </div>
  );
}

type TimelineInteractionMode = "move" | "resize";

type TimelineDraftTiming = {
  taskId: string;
  startMinutes: number;
  durationMinutes: number;
};

type TimelineInteraction = TimelineDraftTiming & {
  cleanup: () => void;
  didChange: boolean;
  mode: TimelineInteractionMode;
  originY: number;
  pointerId: number;
};

type TimelineAddRequest = {
  startTime: string;
  clientX: number;
  clientY: number;
};

type DayTimelineProps = {
  tasks: PlanTask[];
  onToggle: (id: string) => void;
  onEdit: (task: PlanTask) => void;
  onDelete: (id: string) => void;
  onAddAt: (request: TimelineAddRequest) => void;
  onUpdateTaskTiming: (id: string, timing: { start_time: string; duration_minutes: number }) => void;
  showCurrentTime: boolean;
};

function DayTimeline({
  tasks,
  onToggle,
  onEdit,
  onDelete,
  onAddAt,
  onUpdateTaskTiming,
  showCurrentTime,
}: DayTimelineProps) {
  const timedTasks = tasks.filter((t) => Boolean(t.start_time));
  const anyTimeTasks = tasks.filter((t) => !t.start_time);
  const interactionRef = useRef<TimelineInteraction | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [draftTiming, setDraftTiming] = useState<TimelineDraftTiming | null>(null);
  const [currentTimeMinutes, setCurrentTimeMinutes] = useState(() => getCurrentTimeOfDayMinutes());

  let startHour = TIMELINE_DEFAULT_START;
  let endHour = TIMELINE_DEFAULT_END;
  for (const t of timedTasks) {
    const m = parseTimeToMinutes(t.start_time);
    if (m !== null) {
      startHour = Math.min(startHour, Math.floor(m / 60));
      endHour = Math.max(endHour, Math.ceil((m + (t.duration_minutes ?? 60)) / 60));
    }
  }
  startHour = Math.max(0, startHour - 1);
  endHour = Math.min(24, endHour + 1);

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  useEffect(() => {
    if (!showCurrentTime) return;

    const updateCurrentTime = () => {
      setCurrentTimeMinutes(getCurrentTimeOfDayMinutes());
    };

    updateCurrentTime();

    const intervalId = window.setInterval(updateCurrentTime, 60_000);
    return () => window.clearInterval(intervalId);
  }, [showCurrentTime]);

  const finishTimelineInteraction = useCallback(
    (commit: boolean) => {
      const interaction = interactionRef.current;
      if (!interaction) return;

      interaction.cleanup();
      interactionRef.current = null;
      setDraftTiming((current) => (current?.taskId === interaction.taskId ? null : current));

      if (commit && interaction.didChange) {
        suppressClickUntilRef.current = Date.now() + 120;
        onUpdateTaskTiming(interaction.taskId, {
          start_time: formatMinutesToTaskTime(interaction.startMinutes),
          duration_minutes: interaction.durationMinutes,
        });
      }
    },
    [onUpdateTaskTiming],
  );

  useEffect(() => () => {
    interactionRef.current?.cleanup();
    interactionRef.current = null;
  }, []);

  const startTimelineInteraction = useCallback(
    (
      event: React.PointerEvent<HTMLDivElement | HTMLButtonElement>,
      task: PlanTask,
      mode: TimelineInteractionMode,
    ) => {
      const parsedStartMinutes = parseTimeToMinutes(task.start_time);
      if (parsedStartMinutes === null) return;

      event.stopPropagation();
      if (mode === "resize") {
        event.preventDefault();
      }

      finishTimelineInteraction(false);

      const initialStartMinutes = parsedStartMinutes;
      const initialDurationMinutes = Math.max(
        TIMELINE_MIN_DURATION_MINUTES,
        task.duration_minutes ?? DEFAULT_TASK_DURATION_MINUTES,
      );
      const pointerId = event.pointerId;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const interaction = interactionRef.current;
        if (!interaction || moveEvent.pointerId !== pointerId) return;

        const deltaMinutes = snapMinutes(((moveEvent.clientY - interaction.originY) / HOUR_HEIGHT) * 60);

        if (interaction.mode === "move") {
          const nextStartMinutes = clampTaskStartMinutes(
            initialStartMinutes + deltaMinutes,
            initialDurationMinutes,
          );

          interaction.startMinutes = nextStartMinutes;
          interaction.durationMinutes = initialDurationMinutes;
          interaction.didChange ||= nextStartMinutes !== initialStartMinutes;
        } else {
          const nextDurationMinutes = clampTaskDurationMinutes(
            initialDurationMinutes + deltaMinutes,
            initialStartMinutes,
          );

          interaction.startMinutes = initialStartMinutes;
          interaction.durationMinutes = nextDurationMinutes;
          interaction.didChange ||= nextDurationMinutes !== initialDurationMinutes;
        }

        setDraftTiming({
          taskId: interaction.taskId,
          startMinutes: interaction.startMinutes,
          durationMinutes: interaction.durationMinutes,
        });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        finishTimelineInteraction(true);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      interactionRef.current = {
        taskId: task.id,
        startMinutes: initialStartMinutes,
        durationMinutes: initialDurationMinutes,
        cleanup,
        didChange: false,
        mode,
        originY: event.clientY,
        pointerId,
      };
      setDraftTiming({
        taskId: task.id,
        startMinutes: initialStartMinutes,
        durationMinutes: initialDurationMinutes,
      });

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [finishTimelineInteraction],
  );

  const handleEventEdit = useCallback(
    (task: PlanTask) => {
      if (Date.now() < suppressClickUntilRef.current) return;
      onEdit(task);
    },
    [onEdit],
  );

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressClickUntilRef.current) return;
    if ((e.target as Element).closest(".timeline-event")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rawMinutes = ((e.clientY - rect.top) / HOUR_HEIGHT) * 60 + startHour * 60;
    const snapped = snapMinutes(rawMinutes);
    const clamped = Math.max(0, Math.min(23 * 60 + 45, snapped));
    onAddAt({
      startTime: formatMinutesToTaskTime(clamped),
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  const nowTop = ((currentTimeMinutes / 60) - startHour) * HOUR_HEIGHT;
  const showNowLine =
    showCurrentTime &&
    currentTimeMinutes >= startHour * 60 &&
    currentTimeMinutes <= endHour * 60;

  return (
    <div className="day-timeline">
      {anyTimeTasks.length > 0 && (
        <div className="timeline-anytime-row">
          {anyTimeTasks.map((t) => (
            <AnyTimeChip
              key={t.id}
              task={t}
              onToggle={() => onToggle(t.id)}
              onEdit={() => onEdit(t)}
              onDelete={() => onDelete(t.id)}
            />
          ))}
        </div>
      )}
      <div className="timeline-grid">
        {showNowLine ? (
          <div className="timeline-now" style={{ top: nowTop }}>
            <div className="timeline-now-label">{formatMinutesToTime(currentTimeMinutes)}</div>
            <div className="timeline-now-dot" />
            <div className="timeline-now-line" />
          </div>
        ) : null}
        <div className="timeline-labels">
          {hours.map((h, i) => (
            <div key={h} className="timeline-label-cell" style={{ height: HOUR_HEIGHT }}>
              {i > 0 ? <span className="timeline-hour-text">{fmtHour(h)}</span> : null}
            </div>
          ))}
        </div>
        <div
          className="timeline-events-area"
          onClick={handleGridClick}
          style={{ height: hours.length * HOUR_HEIGHT }}
        >
          {hours.map((_, i) => (
            <div key={i}>
              <div className="timeline-line-hour" style={{ top: i * HOUR_HEIGHT }} />
              <div className="timeline-line-half" style={{ top: i * HOUR_HEIGHT + HOUR_HEIGHT / 2 }} />
            </div>
          ))}
          {(() => {
            const lanes = computeTimelineLanes(timedTasks);
            return timedTasks.map((t) => {
              const baseStartMinutes = parseTimeToMinutes(t.start_time);
              if (baseStartMinutes === null) return null;

              const durationMinutes = draftTiming?.taskId === t.id
                ? draftTiming.durationMinutes
                : Math.max(TIMELINE_MIN_DURATION_MINUTES, t.duration_minutes ?? DEFAULT_TASK_DURATION_MINUTES);
              const startMinutes = draftTiming?.taskId === t.id
                ? draftTiming.startMinutes
                : baseStartMinutes;
              const laneInfo = lanes.get(t.id);

              return (
                <TimelineEvent
                  key={t.id}
                  task={t}
                  durationMinutes={durationMinutes}
                  lane={laneInfo?.lane ?? 0}
                  laneCount={laneInfo?.laneCount ?? 1}
                  isInteracting={draftTiming?.taskId === t.id}
                  onDelete={() => onDelete(t.id)}
                  onEdit={() => handleEventEdit(t)}
                  onMoveStart={(event) => startTimelineInteraction(event, t, "move")}
                  onResizeStart={(event) => startTimelineInteraction(event, t, "resize")}
                  onToggle={() => onToggle(t.id)}
                  startHour={startHour}
                  startMinutes={startMinutes}
                />
              );
            });
          })()}
        </div>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

type AssistantModeProps = {
  graphData: GraphData;
  selectedNodeId: string | null;
  workspaceId: string | null;
  // Bumped by app-shell whenever the graph side cascades plan_tasks — we
  // re-fetch the tasks list so the planner reflects auto-toggled rows.
  tasksRefreshKey?: number;
  // Bumped by app-shell when the user accepts a chat `plan_day`. The chat tool
  // persists a DRAFT plan_session + blocks server-side; on this signal we load
  // that draft into the planner's review UI so the user actually SEES it (and
  // applies it with correct local-time scheduling). Fixes: chat "generated a
  // schedule" but nothing shows on the planner (journal #6).
  draftPlanRefreshKey?: number;
  onAskInChat?: (message: string) => void;
  // Called after the planner toggles a task that has a linked graph node,
  // so app-shell can mirror the new status into its local graphData state
  // (avoids a refetch and keeps the graph view consistent in real time).
  onLinkedNodeStatusChange?: (nodeId: string, nextStatus: NodeStatus) => void;
};

export function AssistantMode({
  graphData,
  selectedNodeId,
  workspaceId,
  tasksRefreshKey,
  draftPlanRefreshKey,
  onAskInChat,
  onLinkedNodeStatusChange,
}: AssistantModeProps) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const planTaskSelectClause =
    "id, title, done, scheduled_date, start_time, duration_minutes, created_at, node_id";
  const today = toDateString(new Date());

  // Week anchor — drives which 7-day window the strip displays. Defaults to
  // the current week. Prev/Next buttons step it ±7 days; Today snaps back.
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => new Date());
  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor]);
  const weekRangeLabel = useMemo(() => {
    const start = weekDays[0];
    const end = weekDays[6];
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const endLabel = end.toLocaleDateString(
      undefined,
      sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" },
    );
    return `${startLabel} – ${endLabel}`;
  }, [weekDays]);
  const isCurrentWeek = useMemo(() => {
    const todays = getWeekDays(new Date());
    return toDateString(todays[0]) === toDateString(weekDays[0]);
  }, [weekDays]);

  const handlePrevWeek = useCallback(() => {
    setWeekAnchor((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() - 7);
      return next;
    });
  }, []);

  const handleNextWeek = useCallback(() => {
    setWeekAnchor((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + 7);
      return next;
    });
  }, []);

  const handleJumpToToday = useCallback(() => {
    setWeekAnchor(new Date());
    setSelectedDate(today);
  }, [today]);

  // Manual task state
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [taskEditor, setTaskEditor] = useState<TaskEditorState | null>(null);

  // AI plan state
  const [plannerState, setPlannerState] = useState<PlannerState>(INITIAL_PLANNER_STATE);
  // Guards against double-applying a plan: the async accept (fetch + task
  // inserts) leaves a window where a second click would stack a duplicate,
  // overlapping copy of every task on the day (journal #6a). The ref blocks
  // re-entry synchronously; the state drives the button's disabled/busy UI.
  const acceptingPlanRef = useRef(false);
  const [planAccepting, setPlanAccepting] = useState(false);
  const resetPlanAccepting = useCallback(() => {
    acceptingPlanRef.current = false;
    setPlanAccepting(false);
  }, []);
  const planAbortRef = useRef<AbortController | null>(null);
  // Chosen clock start ("HH:MM") for the in-flight/current plan, or null = now.
  // Kept here (not on the session row) because anchoring is a UI-only choice
  // the accept handler reads when converting blocks into scheduled tasks.
  const planStartTimeRef = useRef<string | null>(null);

  // Set when accepting a plan for a day that already has plan-derived tasks;
  // drives the replan clarifying modal (replace / add / cancel).
  const [replanPrompt, setReplanPrompt] = useState<ReplanPrompt | null>(null);

  const [taskError, setTaskError] = useState<string | null>(null);
  const [authUserId, setAuthUserId] = useState<string | null>(null);

  // Context chip
  const [contextDismissed, setContextDismissed] = useState(false);

  const plannerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supabase) {
      setAuthUserId(null);
      return;
    }

    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setAuthUserId(data.user?.id ?? null);
    });

    return () => {
      active = false;
    };
  }, [supabase]);

  const loadPersistedTasks = useCallback(async () => {
    if (!workspaceId) {
      setTasks([]);
      clearSavedTasks(workspaceId);
      return;
    }

    const legacyTasks = loadTasks(workspaceId);

    if (!supabase || !authUserId) {
      setTasks(legacyTasks);
      return;
    }

    const { data, error } = await supabase
      .from("plan_tasks")
      .select(planTaskSelectClause)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });

    if (error) {
      setTasks(legacyTasks);
      setTaskError("Could not load saved tasks.");
      return;
    }

    let rows = (data ?? []) as PlanTaskRow[];

    if (rows.length === 0 && legacyTasks.length > 0) {
      const { data: migratedRows, error: migrateError } = await supabase
        .from("plan_tasks")
        .insert(legacyTasks.map((task) => toPlanTaskInsert(task, workspaceId, authUserId)))
        .select(planTaskSelectClause);

      if (!migrateError && migratedRows) {
        rows = migratedRows as PlanTaskRow[];
        clearSavedTasks(workspaceId);
      }
    }

    const nextTasks = rows.length > 0 ? normalizeTaskList(rows) : legacyTasks;
    setTasks(nextTasks);
    saveTasks(workspaceId, nextTasks);
  }, [authUserId, planTaskSelectClause, supabase, workspaceId]);

  // ── Load from storage ──────────────────────────────────────────────────────

  useEffect(() => {
    let active = true;

    setTaskError(null);

    void loadPersistedTasks().catch(() => {
      if (!active) return;
      setTaskError("Could not load saved tasks.");
    });

    setContextDismissed(false);
    setSelectedDate(today);
    setTaskEditor(null);
    setPlannerState(INITIAL_PLANNER_STATE);

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPersistedTasks, today, workspaceId]);

  // Light-touch refresh — re-pull tasks when the parent shell signals a
  // server-side cascade (graph completion auto-toggling linked plan_tasks).
  // Skip the very first render so we don't double-fetch with the loader above.
  useEffect(() => {
    if (tasksRefreshKey === undefined) return;
    if (tasksRefreshKey === 0) return;
    void loadPersistedTasks().catch(() => {
      // ignore — next interaction will retry
    });
  }, [tasksRefreshKey, loadPersistedTasks]);

  // Load a fresh chat-generated draft plan into the review UI (journal #6).
  // Only picks up a draft created in the last few minutes so an old, abandoned
  // in-planner draft isn't resurrected on an unrelated remount.
  const loadLatestDraftPlan = useCallback(async () => {
    if (!supabase || !workspaceId) return;
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: sessions } = await supabase
      .from("plan_sessions")
      .select(
        "id, workspace_id, user_id, planning_window, custom_minutes, scope, status, created_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("status", "draft")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    const session = (sessions?.[0] as PlanSession | undefined) ?? null;
    if (!session) return;
    const { data: blockRows } = await supabase
      .from("plan_blocks")
      .select(
        "id, plan_session_id, node_id, title, start_offset, duration_minutes, reason, block_type, completion_status",
      )
      .eq("plan_session_id", session.id);
    setPlannerState({
      session,
      blocks: sortPlanBlocks((blockRows ?? []) as PlanBlock[]),
      recentlyUnblockedNodeIds: new Set(),
      loading: false,
      error: null,
      finalised: false,
    });
  }, [supabase, workspaceId]);

  useEffect(() => {
    if (draftPlanRefreshKey === undefined || draftPlanRefreshKey === 0) return;
    void loadLatestDraftPlan().catch(() => {
      // ignore — the draft stays in the DB; the user can re-open the planner
    });
  }, [draftPlanRefreshKey, loadLatestDraftPlan]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const selectedNode = graphData.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const showContext = Boolean(selectedNode && !contextDismissed);

  // Tasks for selected date (includes done — done tasks stay visible with strikethrough)
  const viewTasks = [...tasks.filter((t) =>
    selectedDate === "all" ? true : t.date === selectedDate,
  )].sort(compareTasks);
  const unscheduled = [...tasks.filter((t) => !t.date)].sort(compareTasks);
  const completedUnscheduledCount = unscheduled.filter((task) => task.done).length;

  // Active (undone) counts for week-strip badges
  const countByDate = weekDays.reduce<Record<string, number>>((acc, day) => {
    const ds = toDateString(day);
    acc[ds] = tasks.filter((t) => !t.done && t.date === ds).length;
    return acc;
  }, {});

  // ── Persistence wrappers ───────────────────────────────────────────────────

  const persistTasks = useCallback(
    (next: PlanTask[]) => {
      setTasks(next);
      saveTasks(workspaceId, next);
    },
    [workspaceId],
  );

  // ── Task operations ────────────────────────────────────────────────────────

  const openTaskCreator = useCallback((
    key: string,
    date: string | null,
    options?: {
      atTime?: string;
      placement?: TaskComposerPlacement;
    },
  ) => {
    setTaskEditor({
      mode: "create",
      key,
      draft: createTaskDraft(options?.atTime ? { start_time: options.atTime } : null, date),
      placement: options?.placement ?? { kind: "inline" },
    });
  }, []);

  const openTaskEditor = useCallback((task: PlanTask) => {
    setTaskEditor({
      mode: "edit",
      key: task.id,
      taskId: task.id,
      draft: createTaskDraft(task),
    });
  }, []);

  const closeTaskEditor = useCallback(() => {
    setTaskEditor(null);
  }, []);

  const submitTask = useCallback(
    async (draft: {
      title: string;
      date: string | null;
      start_time: string | null;
      duration_minutes: number | null;
    }) => {
      if (!taskEditor) return;
      setTaskError(null);

      if (taskEditor.mode === "create") {
        const nextTask: PlanTask = {
          id: `t-${Date.now()}`,
          title: draft.title,
          done: false,
          date: draft.date,
          start_time: draft.start_time,
          duration_minutes: draft.duration_minutes,
          created_at: new Date().toISOString(),
          completed_at: null,
        };

        if (!supabase || !workspaceId || !authUserId) {
          persistTasks([...tasks, nextTask].sort(compareTasks));
        } else {
          const { data, error } = await supabase
            .from("plan_tasks")
            .insert(toPlanTaskInsert(nextTask, workspaceId, authUserId))
            .select(planTaskSelectClause)
            .single();

          if (error || !data) {
            setTaskError("Could not save task.");
            return;
          }

          const savedTask = normalizeTask(data);
          if (!savedTask) {
            setTaskError("Could not save task.");
            return;
          }

          persistTasks([...tasks, savedTask].sort(compareTasks));
        }
      } else {
        const existingTask = tasks.find((task) => task.id === taskEditor.taskId);
        if (!existingTask) {
          return;
        }

        if (!supabase || !workspaceId) {
          persistTasks(
            tasks
              .map((task) =>
                task.id === taskEditor.taskId
                  ? {
                      ...task,
                      title: draft.title,
                      date: draft.date,
                      start_time: draft.start_time,
                      duration_minutes: draft.duration_minutes,
                    }
                  : task,
              )
              .sort(compareTasks),
          );
        } else {
          const { data, error } = await supabase
            .from("plan_tasks")
            .update({
              title: draft.title,
              scheduled_date: draft.date,
              start_time: draft.start_time,
              duration_minutes: draft.duration_minutes,
            })
            .eq("id", taskEditor.taskId)
            .eq("workspace_id", workspaceId)
            .select(planTaskSelectClause)
            .single();

          if (error || !data) {
            setTaskError("Could not save task.");
            return;
          }

          const savedTask = normalizeTask({
            ...data,
            completed_at: existingTask.completed_at,
          });
          if (!savedTask) {
            setTaskError("Could not save task.");
            return;
          }

          persistTasks(
            tasks
              .map((task) => (task.id === taskEditor.taskId ? savedTask : task))
              .sort(compareTasks),
          );
        }
      }

      setTaskEditor(null);
    },
    [authUserId, persistTasks, planTaskSelectClause, supabase, taskEditor, tasks, workspaceId],
  );

  const toggleTask = useCallback(
    async (id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return;
      const nowDone = !task.done;
      const completedAt = nowDone ? new Date().toISOString() : null;
      setTaskError(null);

      if (!supabase || !workspaceId) {
        persistTasks(
          tasks
            .map((t) =>
              t.id === id
                ? { ...t, done: nowDone, completed_at: completedAt }
                : t,
            )
            .sort(compareTasks),
        );
      } else {
        const { data, error } = await supabase
          .from("plan_tasks")
          .update({ done: nowDone })
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .select(planTaskSelectClause)
          .single();

        if (error || !data) {
          setTaskError("Could not update task.");
          return;
        }

        const savedTask = normalizeTask({
          ...data,
          completed_at: completedAt,
        });
        if (!savedTask) {
          setTaskError("Could not update task.");
          return;
        }

        persistTasks(
          tasks
            .map((t) => (t.id === id ? savedTask : t))
            .sort(compareTasks),
        );
      }

      // Phase 10.3 — mark linked graph node as completed when task is checked off.
      // Notify the parent shell so it can update its cached graphData immediately,
      // not just after a refetch.
      if (task.node_id) {
        const nextStatus: NodeStatus = nowDone ? "completed" : "active";
        onLinkedNodeStatusChange?.(task.node_id, nextStatus);
        void fetch(`/api/nodes/${task.node_id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
      }
    },
    [persistTasks, planTaskSelectClause, supabase, tasks, workspaceId],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      setTaskError(null);

      if (!supabase || !workspaceId) {
        persistTasks(tasks.filter((t) => t.id !== id));
        return;
      }

      const { error } = await supabase
        .from("plan_tasks")
        .delete()
        .eq("id", id)
        .eq("workspace_id", workspaceId);

      if (error) {
        setTaskError("Could not delete task.");
        return;
      }

      persistTasks(tasks.filter((t) => t.id !== id));
    },
    [persistTasks, supabase, tasks, workspaceId],
  );

  const updateTaskTiming = useCallback(
    async (id: string, timing: { start_time: string; duration_minutes: number }) => {
      setTaskError(null);

      if (!supabase || !workspaceId) {
        persistTasks(
          tasks
            .map((task) =>
              task.id === id
                ? {
                    ...task,
                    start_time: timing.start_time,
                    duration_minutes: timing.duration_minutes,
                  }
                : task,
            )
            .sort(compareTasks),
        );
      } else {
        const existingTask = tasks.find((task) => task.id === id);
        if (!existingTask) return;

        const { data, error } = await supabase
          .from("plan_tasks")
          .update({
            start_time: timing.start_time,
            duration_minutes: timing.duration_minutes,
          })
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .select(planTaskSelectClause)
          .single();

        if (error || !data) {
          setTaskError("Could not update task timing.");
          return;
        }

        const savedTask = normalizeTask({
          ...data,
          completed_at: existingTask.completed_at,
        });
        if (!savedTask) {
          setTaskError("Could not update task timing.");
          return;
        }

        persistTasks(
          tasks
            .map((task) => (task.id === id ? savedTask : task))
            .sort(compareTasks),
        );
      }

      setTaskEditor((current) =>
        current?.mode === "edit" && current.taskId === id
          ? {
              ...current,
              draft: {
                ...current.draft,
                startTime: timing.start_time,
                durationMinutes: String(timing.duration_minutes),
              },
            }
          : current,
      );
    },
    [persistTasks, planTaskSelectClause, supabase, tasks, workspaceId],
  );

  // ── AI planner operations ──────────────────────────────────────────────────

  const handlePlanGenerate = async (options: GeneratePlanOptions) => {
    if (!workspaceId) return;
    const { window, start_time, custom_minutes } = options;
    planAbortRef.current?.abort(); // cancel any in-flight plan first
    const ac = new AbortController();
    planAbortRef.current = ac;
    planStartTimeRef.current = isValidTimeString(start_time ?? "") ? start_time : null;
    setPlannerState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const res = await fetch("/api/assistant/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          planning_window: window,
          ...(window === "custom" && custom_minutes ? { custom_minutes } : {}),
          ...clientDayHints(),
        }),
        signal: ac.signal,
      });

      const data = await res.json() as {
        session?: PlanSession;
        blocks?: PlanBlock[];
        recently_unblocked_node_ids?: string[];
        error?: string;
      };

      if (!res.ok || !data.session) {
        setPlannerState((prev) => ({
          ...prev,
          loading: false,
          error: data.error ?? "Planning failed. Try again.",
        }));
        return;
      }

      setPlannerState({
        session: data.session,
        blocks: sortPlanBlocks(data.blocks ?? []),
        recentlyUnblockedNodeIds: new Set(data.recently_unblocked_node_ids ?? []),
        loading: false,
        error: null,
        finalised: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // user cancelled
      setPlannerState((prev) => ({
        ...prev,
        loading: false,
        error: "Network error. Try again.",
      }));
    }
  };

  const handlePlanCancel = () => {
    planAbortRef.current?.abort();
    planAbortRef.current = null;
    setPlannerState((prev) => ({ ...prev, loading: false, error: null }));
  };

  const handlePlanDeleteBlock = (blockId: string) => {
    setPlannerState((prev) => ({
      ...prev,
      blocks: prev.blocks.filter((b) => b.id !== blockId),
    }));
  };

  const handlePlanReorderBlocks = (blockIds: string[]) => {
    setPlannerState((prev) => {
      if (blockIds.length !== prev.blocks.length) return prev;
      const byId = new Map(prev.blocks.map((b) => [b.id, b]));
      const next = blockIds.map((id) => byId.get(id)).filter((b): b is PlanBlock => Boolean(b));
      return next.length === prev.blocks.length ? { ...prev, blocks: next } : prev;
    });
  };

  // Inserts freshly-built plan tasks into the task list/store. Any ids passed in
  // replaceTaskIds are deleted first (REPLACE), so the new plan supersedes the
  // old one instead of stacking on top of it; pass [] to add alongside (ADD).
  // Returns false if persistence failed (caller surfaces the error).
  const commitPlanTasks = useCallback(
    async (newTasks: PlanTask[], replaceTaskIds: string[]): Promise<boolean> => {
      if (newTasks.length === 0) return true;

      const replaceIdSet = new Set(replaceTaskIds);
      const survivingTasks = tasks.filter((task) => !replaceIdSet.has(task.id));

      if (!supabase || !workspaceId || !authUserId) {
        persistTasks([...survivingTasks, ...newTasks].sort(compareTasks));
        return true;
      }

      if (replaceTaskIds.length > 0) {
        const { error: deleteError } = await supabase
          .from("plan_tasks")
          .delete()
          .in("id", replaceTaskIds)
          .eq("workspace_id", workspaceId);
        if (deleteError) return false;
      }

      const { data, error } = await supabase
        .from("plan_tasks")
        .insert(newTasks.map((task) => toPlanTaskInsert(task, workspaceId, authUserId)))
        .select(planTaskSelectClause);

      if (error || !data) return false;

      persistTasks([...survivingTasks, ...normalizeTaskList(data)].sort(compareTasks));
      return true;
    },
    [authUserId, persistTasks, planTaskSelectClause, supabase, tasks, workspaceId],
  );

  const handlePlanAccept = async (finalBlockIds: string[]) => {
    if (acceptingPlanRef.current) return; // already applying — ignore re-clicks
    const sessionId = plannerState.session?.id;
    if (!sessionId) return;
    acceptingPlanRef.current = true;
    setPlanAccepting(true);

    try {
      // Chat-generated plans have local IDs — skip the server feedback call
      const isChatPlan = sessionId.startsWith("chat-plan-");
      if (!isChatPlan) {
        const res = await fetch(`/api/assistant/plan/${sessionId}/feedback`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accepted: true, final_block_ids: finalBlockIds }),
        });
        if (!res.ok) throw new Error("Accept failed");
      }

      // Convert accepted blocks into scheduled tasks, preserving kept breaks/buffers as time gaps.
      const keptBlocks = finalBlockIds
        .map((blockId) => plannerState.blocks.find((block) => block.id === blockId))
        .filter((block): block is PlanBlock => Boolean(block));
      const targetDate = selectedDate || today;
      const totalScheduledMinutes = keptBlocks.reduce(
        (total, block) => total + block.duration_minutes,
        0,
      );
      const anchorMinutes = getPlanTaskAnchorMinutes(
        plannerState.session?.planning_window,
        targetDate,
        totalScheduledMinutes,
        planStartTimeRef.current,
      );
      const createdAt = new Date().toISOString();
      let nextOffset = 0;
      const newTasks: PlanTask[] = [];

      for (const block of keptBlocks) {
        const startMinutes = clampTaskStartMinutes(
          anchorMinutes + nextOffset,
          block.duration_minutes,
        );
        nextOffset += block.duration_minutes;

        if (block.block_type === "break" || block.block_type === "buffer") {
          continue;
        }

        newTasks.push({
          id: `plan-${block.id}`,
          title: block.title,
          done: false,
          date: targetDate,
          start_time: formatMinutesToTaskTime(startMinutes),
          duration_minutes: block.duration_minutes,
          created_at: createdAt,
          completed_at: null,
          node_id: block.node_id ?? null,
        });
      }

      // If this day already holds plan-derived tasks, ask before stacking a new
      // plan on top. Defer the actual write to the modal's choice (replace/add).
      const existingPlanTasks = findPlanTasksForDate(tasks, targetDate);
      if (newTasks.length > 0 && existingPlanTasks.length > 0) {
        // Hand off to the replace/add modal — it (or cancel) resets the flag.
        setReplanPrompt({
          targetDate,
          newTasks,
          existingTaskIds: existingPlanTasks.map((task) => task.id),
        });
        return;
      }

      const ok = await commitPlanTasks(newTasks, []);
      if (!ok) {
        setPlannerState((prev) => ({
          ...prev,
          error: "Plan was accepted, but tasks could not be saved.",
        }));
        resetPlanAccepting();
        return;
      }

      // Switch to task view at the date these tasks were scheduled onto.
      setSelectedDate(targetDate);
      setPlannerState(INITIAL_PLANNER_STATE);
      resetPlanAccepting();
    } catch {
      setPlannerState((prev) => ({ ...prev, error: "Could not accept the plan. Try again." }));
      resetPlanAccepting();
    }
  };

  // ── Replan clarifying modal ────────────────────────────────────────────────
  // Resolves the replace-vs-add choice for the pending plan. REPLACE deletes the
  // day's existing plan tasks first; ADD stacks alongside; CANCEL keeps the draft.
  const finishReplan = async (replaceTaskIds: string[]) => {
    if (!replanPrompt) return;
    const { targetDate, newTasks } = replanPrompt;
    const ok = await commitPlanTasks(newTasks, replaceTaskIds);
    if (!ok) {
      setReplanPrompt(null);
      setPlannerState((prev) => ({
        ...prev,
        error: "Plan was accepted, but tasks could not be saved.",
      }));
      resetPlanAccepting();
      return;
    }
    setReplanPrompt(null);
    setSelectedDate(targetDate);
    setPlannerState(INITIAL_PLANNER_STATE);
    resetPlanAccepting();
  };

  const handleReplanReplace = () => void finishReplan(replanPrompt?.existingTaskIds ?? []);
  const handleReplanAdd = () => void finishReplan([]);
  const handleReplanCancel = () => {
    setReplanPrompt(null);
    resetPlanAccepting();
  };

  // Escape closes the replan modal (cancel), matching the rest of the app.
  useEffect(() => {
    if (!replanPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReplanPrompt(null);
        resetPlanAccepting();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replanPrompt, resetPlanAccepting]);

  const handlePlanReject = async () => {
    const sessionId = plannerState.session?.id;
    if (!sessionId) return;
    try {
      // Chat-generated plans have local IDs — just clear state
      if (!sessionId.startsWith("chat-plan-")) {
        const res = await fetch(`/api/assistant/plan/${sessionId}/feedback`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rejected: true }),
        });
        if (!res.ok) throw new Error("Reject failed");
      }
      setPlannerState(INITIAL_PLANNER_STATE);
    } catch {
      setPlannerState((prev) => ({ ...prev, error: "Could not reject the plan. Try again." }));
    }
  };

  const handlePlanReset = () => setPlannerState(INITIAL_PLANNER_STATE);

  // ── Render ─────────────────────────────────────────────────────────────────

  const selectedDaySectionKey = `date-${selectedDate}`;
  const selectedDayCreateEditor =
    taskEditor?.mode === "create" && taskEditor.key === selectedDaySectionKey ? taskEditor : null;
  const selectedDayEditEditor =
    taskEditor?.mode === "edit" && viewTasks.some((t) => t.id === taskEditor.taskId) ? taskEditor : null;
  const selectedDayOverlayPlacement =
    selectedDayCreateEditor?.placement.kind === "timeline-overlay"
      ? selectedDayCreateEditor.placement
      : null;

  return (
    <div className="assistant-layout">
      {/* Context chip bar */}
      {showContext ? (
        <div className="assistant-context-bar">
          <span className="assistant-context-chip">
            <span className="assistant-context-chip-label">Context</span>
            <span className="assistant-context-chip-name">{selectedNode!.title}</span>
            <button
              aria-label="Clear context"
              className="assistant-context-chip-dismiss"
              onClick={() => setContextDismissed(true)}
              type="button"
            >
              <CloseIcon className="h-2.5 w-2.5" />
            </button>
          </span>
        </div>
      ) : null}

      <div className="assistant-workspace">
        {/* ── LEFT: Planner ── */}
        <div className="assistant-planner shell-scrollbar" ref={plannerRef}>
          {/* Quick action chips — always visible */}
          <div className="planner-quick-row">
            {QUICK_ACTIONS.map(({ label, window }) => (
              <button
                className="assistant-quick-chip"
                key={label}
                onClick={() =>
                  void handlePlanGenerate({ window, start_time: null, custom_minutes: null })
                }
                type="button"
              >
                {label}
              </button>
            ))}
            <button
              className="assistant-quick-chip"
              onClick={() => onAskInChat?.("What's next?")}
              type="button"
            >
              What&apos;s next?
            </button>
          </div>

          {taskError ? <p className="planner-error planner-error-inline">{taskError}</p> : null}

          {/* AI plan view OR manual task list */}
          {plannerState.session || plannerState.loading || plannerState.error ? (
            <PlannerPanel
              graphData={graphData}
              plannerState={plannerState}
              onGenerate={handlePlanGenerate}
              onDeleteBlock={handlePlanDeleteBlock}
              onReorderBlocks={handlePlanReorderBlocks}
              onAccept={(ids) => void handlePlanAccept(ids)}
              onReject={() => void handlePlanReject()}
              onReset={handlePlanReset}
              onCancel={handlePlanCancel}
              accepting={planAccepting}
            />
          ) : (
            <>
              {/* Week navigation header */}
              <div className="week-nav">
                <button
                  type="button"
                  className="week-nav-btn"
                  onClick={handlePrevWeek}
                  aria-label="Previous week"
                  title="Previous week"
                >
                  <ChevronLeftIcon className="h-[14px] w-[14px]" />
                </button>
                <span className="week-nav-label">
                  {isCurrentWeek ? "This week" : weekRangeLabel}
                  {!isCurrentWeek ? (
                    <button
                      type="button"
                      className="week-nav-jump-today"
                      onClick={handleJumpToToday}
                    >
                      Jump to today
                    </button>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="week-nav-btn"
                  onClick={handleNextWeek}
                  aria-label="Next week"
                  title="Next week"
                >
                  <ChevronRightIcon className="h-[14px] w-[14px]" />
                </button>
              </div>

              {/* Week strip */}
              <div className="week-strip">
                {weekDays.map((day, i) => {
                  const ds = toDateString(day);
                  const isToday = ds === today;
                  const count = countByDate[ds] ?? 0;
                  return (
                    <button
                      className="week-day-btn"
                      data-active={selectedDate === ds}
                      data-today={isToday || undefined}
                      key={ds}
                      onClick={() => setSelectedDate(ds)}
                      type="button"
                    >
                      <span className="week-day-abbr">{DAY_ABBR[i]}</span>
                      <span className={`week-day-num${isToday ? " week-day-num-today" : ""}`}>
                        {day.getDate()}
                      </span>
                      {count > 0 ? <span className="week-day-dot" /> : null}
                    </button>
                  );
                })}
              </div>

              {/* Task sections */}
              <div className="planner-sections">
                {/* Selected day — timeline view */}
                <div className="planner-section">
                  <p className="planner-section-label">
                    {selectedDate === today
                      ? "Today"
                      : new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", {
                          weekday: "long",
                          month: "short",
                          day: "numeric",
                        })}
                  </p>
                  <DayTimeline
                    tasks={viewTasks}
                    onToggle={toggleTask}
                    onEdit={openTaskEditor}
                    onDelete={deleteTask}
                    onAddAt={({ startTime, clientX, clientY }) => {
                      // Use viewport coordinates directly — overlay uses position:fixed
                      const FORM_WIDTH = 380;
                      const FORM_HEIGHT = 160;
                      const plannerRect = plannerRef.current?.getBoundingClientRect();
                      const vw = window.innerWidth;
                      const vh = window.innerHeight;
                      const left = Math.max(
                        plannerRect ? plannerRect.left + 12 : 12,
                        Math.min(
                          plannerRect ? plannerRect.right - FORM_WIDTH - 12 : vw - FORM_WIDTH - 12,
                          clientX - 24,
                        ),
                      );
                      const top = Math.max(
                        12,
                        Math.min(vh - FORM_HEIGHT - 12, clientY - 20),
                      );
                      openTaskCreator(selectedDaySectionKey, selectedDate, {
                        atTime: startTime,
                        placement: { kind: "timeline-overlay", left, top },
                      });
                    }}
                    onUpdateTaskTiming={updateTaskTiming}
                    showCurrentTime={selectedDate === today}
                  />
                  {/* Inline forms (no overlay) */}
                  {!selectedDayOverlayPlacement && selectedDayCreateEditor ? (
                    <TaskComposer
                      initialDraft={selectedDayCreateEditor.draft}
                      onCancel={closeTaskEditor}
                      onSubmit={submitTask}
                      submitLabel="Add task"
                    />
                  ) : selectedDayEditEditor ? (
                    <TaskComposer
                      initialDraft={selectedDayEditEditor.draft}
                      onCancel={closeTaskEditor}
                      onSubmit={submitTask}
                      submitLabel="Save task"
                    />
                  ) : (
                    <button
                      className="planner-add-trigger"
                      onClick={() => openTaskCreator(selectedDaySectionKey, selectedDate)}
                      type="button"
                    >
                      <PlusIcon className="h-[11px] w-[11px]" />
                      Add task
                    </button>
                  )}
                </div>

                {/* Unscheduled */}
                <div className="planner-section">
                  <p className="planner-section-label">Unscheduled</p>
                  {unscheduled.length === 0 &&
                  !(taskEditor?.mode === "create" && taskEditor.key === "unscheduled") ? (
                    <p className="planner-section-empty">Tasks without a date stay here.</p>
                  ) : null}
                  {unscheduled.map((task) =>
                    taskEditor?.mode === "edit" && taskEditor.taskId === task.id ? (
                      <TaskComposer
                        key={task.id}
                        initialDraft={taskEditor.draft}
                        onCancel={closeTaskEditor}
                        onSubmit={submitTask}
                        submitLabel="Save task"
                      />
                    ) : (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onDelete={deleteTask}
                        onEdit={openTaskEditor}
                        onToggle={toggleTask}
                      />
                    ),
                  )}
                  {completedUnscheduledCount > 0 ? (
                    <p className="planner-done-summary">
                      {completedUnscheduledCount} finished {completedUnscheduledCount === 1 ? "task stays" : "tasks stay"} visible until deleted.
                    </p>
                  ) : null}
                  {taskEditor?.mode === "create" && taskEditor.key === "unscheduled" ? (
                    <TaskComposer
                      initialDraft={taskEditor.draft}
                      onCancel={closeTaskEditor}
                      onSubmit={submitTask}
                      submitLabel="Add task"
                    />
                  ) : (
                    <button
                      className="planner-add-trigger"
                      onClick={() => openTaskCreator("unscheduled", null)}
                      type="button"
                    >
                      <PlusIcon className="h-[11px] w-[11px]" />
                      Add task
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Timeline overlay — rendered outside scroll content, uses position:fixed */}
          {selectedDayOverlayPlacement && selectedDayCreateEditor ? (
            <>
              <button
                aria-label="Close task composer"
                className="planner-overlay-backdrop"
                onClick={closeTaskEditor}
                type="button"
              />
              <div
                className="planner-floating-composer"
                style={{
                  left: selectedDayOverlayPlacement.left,
                  top: selectedDayOverlayPlacement.top,
                }}
              >
                <TaskComposer
                  compact
                  initialDraft={selectedDayCreateEditor.draft}
                  onCancel={closeTaskEditor}
                  onSubmit={submitTask}
                  submitLabel="Add"
                />
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Replan clarifying modal — shown when accepting a plan for a day that
          already has plan-derived tasks. */}
      {replanPrompt ? (
        <div
          className="replan-backdrop"
          onClick={handleReplanCancel}
          role="presentation"
        >
          <div
            className="replan-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="replan-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="replan-modal-header">
              <h2 className="replan-modal-title" id="replan-modal-title">
                You already have a plan for this day
              </h2>
              <p className="replan-modal-sub">
                Replace the {replanPrompt.existingTaskIds.length} existing plan{" "}
                {replanPrompt.existingTaskIds.length === 1 ? "task" : "tasks"} for this day,
                or add this one alongside?
              </p>
            </div>
            <div className="replan-modal-actions">
              <button
                className="replan-btn replan-btn--primary"
                onClick={handleReplanReplace}
                type="button"
              >
                Replace
              </button>
              <button className="replan-btn" onClick={handleReplanAdd} type="button">
                Add
              </button>
              <button className="replan-btn replan-btn--ghost" onClick={handleReplanCancel} type="button">
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
