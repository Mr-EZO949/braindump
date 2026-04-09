"use client";

import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CloseIcon,
  PencilIcon,
  PlusIcon,
} from "@/components/ui/icons";
import {
  PlannerPanel,
  INITIAL_PLANNER_STATE,
  type PlannerState,
} from "@/components/panel/planner-panel";
import type { PlanBlock, PlanBlockType, PlanSession, PlanningWindow } from "@/types/ai";
import type { GraphData } from "@/types/graph";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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

type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: AssistantMessage[];
  createdAt: string;
};

type AssistantTextBlock =
  | { type: "paragraph"; text: string }
  | { type: "ordered-list"; items: string[] }
  | { type: "unordered-list"; items: string[] }
  | { type: "heading"; level: 1 | 2 | 3; text: string };

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

function normalizeAssistantMessageBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/([:!?])\s+(\d+\.\s+)/g, "$1\n$2")
    .replace(/([.])\s+(\d+\.\s+(?:\*\*|[A-Z(]))/g, "$1\n$2")
    .replace(/([:!?])\s+([-*]\s+)/g, "$1\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line);
}

function isUnorderedListLine(line: string): boolean {
  return /^[-*]\s+/.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^(#{1,3})\s+/.test(line);
}

function parseAssistantTextBlocks(body: string): AssistantTextBlock[] {
  const normalized = normalizeAssistantMessageBody(body);
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const blocks: AssistantTextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: Math.min(3, headingMatch[1].length) as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isOrderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index].trim();
        const listMatch = /^\d+\.\s+(.*)$/.exec(currentLine);
        if (!listMatch) break;

        let itemText = listMatch[1].trim();
        index += 1;

        while (index < lines.length) {
          const continuationLine = lines[index].trim();
          if (
            !continuationLine ||
            isOrderedListLine(continuationLine) ||
            isUnorderedListLine(continuationLine) ||
            isHeadingLine(continuationLine)
          ) {
            break;
          }

          itemText = `${itemText} ${continuationLine}`;
          index += 1;
        }

        items.push(itemText);

        if (index < lines.length && !lines[index].trim()) {
          index += 1;
          break;
        }
      }

      blocks.push({ type: "ordered-list", items });
      continue;
    }

    if (isUnorderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index].trim();
        const listMatch = /^[-*]\s+(.*)$/.exec(currentLine);
        if (!listMatch) break;

        let itemText = listMatch[1].trim();
        index += 1;

        while (index < lines.length) {
          const continuationLine = lines[index].trim();
          if (
            !continuationLine ||
            isOrderedListLine(continuationLine) ||
            isUnorderedListLine(continuationLine) ||
            isHeadingLine(continuationLine)
          ) {
            break;
          }

          itemText = `${itemText} ${continuationLine}`;
          index += 1;
        }

        items.push(itemText);

        if (index < lines.length && !lines[index].trim()) {
          index += 1;
          break;
        }
      }

      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const paragraphLines = [line];
    index += 1;

    while (index < lines.length) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        index += 1;
        break;
      }
      if (
        isOrderedListLine(nextLine) ||
        isUnorderedListLine(nextLine) ||
        isHeadingLine(nextLine)
      ) {
        break;
      }

      paragraphLines.push(nextLine);
      index += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderAssistantInlineText(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const rawMatch = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      parts.push(text.slice(lastIndex, matchIndex));
    }

    if (rawMatch.startsWith("**") && rawMatch.endsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-strong-${matchIndex}`}>
          {rawMatch.slice(2, -2)}
        </strong>,
      );
    } else if (rawMatch.startsWith("`") && rawMatch.endsWith("`")) {
      parts.push(
        <code key={`${keyPrefix}-code-${matchIndex}`}>
          {rawMatch.slice(1, -1)}
        </code>,
      );
    } else if (rawMatch.startsWith("*") && rawMatch.endsWith("*")) {
      parts.push(
        <em key={`${keyPrefix}-em-${matchIndex}`}>
          {rawMatch.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = matchIndex + rawMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function AssistantRichText({ body }: { body: string }) {
  const blocks = parseAssistantTextBlocks(body);

  if (blocks.length === 0) {
    return <p>{body}</p>;
  }

  return (
    <div className="chat-rich-text">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const content = renderAssistantInlineText(block.text, `heading-${index}`);
          if (block.level === 1) return <h1 key={`heading-${index}`}>{content}</h1>;
          if (block.level === 2) return <h2 key={`heading-${index}`}>{content}</h2>;
          return <h3 key={`heading-${index}`}>{content}</h3>;
        }

        if (block.type === "ordered-list") {
          return (
            <ol key={`ol-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`ol-${index}-${itemIndex}`}>
                  {renderAssistantInlineText(item, `ol-${index}-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === "unordered-list") {
          return (
            <ul key={`ul-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`ul-${index}-${itemIndex}`}>
                  {renderAssistantInlineText(item, `ul-${index}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={`p-${index}`}>
            {renderAssistantInlineText(block.text, `p-${index}`)}
          </p>
        );
      })}
    </div>
  );
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
): number {
  const preferredStartMinutes =
    planningWindow === "day"
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

function loadConversations(workspaceId: string | null): Conversation[] {
  try {
    return JSON.parse(
      localStorage.getItem(sk("convs", workspaceId)) ?? "[]",
    ) as Conversation[];
  } catch {
    return [];
  }
}

function saveConversations(workspaceId: string | null, convs: Conversation[]) {
  localStorage.setItem(sk("convs", workspaceId), JSON.stringify(convs));
}

function loadCurrentConvId(workspaceId: string | null): string | null {
  return localStorage.getItem(sk("cur_conv", workspaceId));
}

function saveCurrentConvId(workspaceId: string | null, id: string | null) {
  if (id) {
    localStorage.setItem(sk("cur_conv", workspaceId), id);
  } else {
    localStorage.removeItem(sk("cur_conv", workspaceId));
  }
}

// ── Planner helpers ────────────────────────────────────────────────────────────

function sortPlanBlocks(blocks: PlanBlock[]): PlanBlock[] {
  return [...blocks].sort((a, b) => a.start_offset - b.start_offset);
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
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

type TimelineEventProps = {
  task: PlanTask;
  startHour: number;
  startMinutes: number;
  durationMinutes: number;
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

  return (
    <div
      className={`timeline-event${task.done ? " timeline-event-done" : ""}${confirmDelete ? " timeline-event-confirming" : ""}`}
      data-interacting={isInteracting || undefined}
      style={{ top, height }}
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
          {timedTasks.map((t) => {
            const baseStartMinutes = parseTimeToMinutes(t.start_time);
            if (baseStartMinutes === null) return null;

            const durationMinutes = draftTiming?.taskId === t.id
              ? draftTiming.durationMinutes
              : Math.max(TIMELINE_MIN_DURATION_MINUTES, t.duration_minutes ?? DEFAULT_TASK_DURATION_MINUTES);
            const startMinutes = draftTiming?.taskId === t.id
              ? draftTiming.startMinutes
              : baseStartMinutes;

            return (
              <TimelineEvent
                key={t.id}
                task={t}
                durationMinutes={durationMinutes}
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
          })}
        </div>
      </div>
    </div>
  );
}

const STARTER_PROMPTS = [
  "Suggest a 1-hour focus plan",
  "What should I work on next?",
  "Break down my most important project",
  "Plan my day",
];

// ── Component ──────────────────────────────────────────────────────────────────

type AssistantModeProps = {
  graphData: GraphData;
  selectedNodeId: string | null;
  workspaceId: string | null;
  onExtractNodes?: (nodesContent: string, workspaceId: string) => void;
};

export function AssistantMode({
  graphData,
  selectedNodeId,
  workspaceId,
  onExtractNodes,
}: AssistantModeProps) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const planTaskSelectClause =
    "id, title, done, scheduled_date, start_time, duration_minutes, created_at, node_id";
  const today = toDateString(new Date());
  const weekDays = getWeekDays(new Date());

  // Manual task state
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [taskEditor, setTaskEditor] = useState<TaskEditorState | null>(null);

  // AI plan state
  const [plannerState, setPlannerState] = useState<PlannerState>(INITIAL_PLANNER_STATE);

  // Conversation state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingBody, setStreamingBody] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [lastChatAttempt, setLastChatAttempt] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [authUserId, setAuthUserId] = useState<string | null>(null);

  // Auto-detect assistant mode from message content
  function detectMode(text: string): "explain" | "plan" | "transform" {
    const lower = text.toLowerCase();
    const planKeywords = /\b(plan|schedule|block|time.?box|next\s+\d+\s*(h|hour|min)|my\s+(morning|afternoon|evening|day))\b/;
    const transformKeywords = /\b(move|merge|split|rename|restructure|reorganize|reparent|archive)\b/;
    if (planKeywords.test(lower)) return "plan";
    if (transformKeywords.test(lower)) return "transform";
    return "plan"; // default to plan mode which is the most capable
  }

  // Context chip
  const [contextDismissed, setContextDismissed] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);
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

    const convs = loadConversations(workspaceId);
    setConversations(convs);
    const savedId = loadCurrentConvId(workspaceId);
    setCurrentConvId(
      savedId && convs.some((c) => c.id === savedId)
        ? savedId
        : convs[0]?.id ?? null,
    );
    setContextDismissed(false);
    setSelectedDate(today);
    setTaskEditor(null);
    setPlannerState(INITIAL_PLANNER_STATE);

    return () => {
      active = false;
    };
  }, [loadPersistedTasks, today, workspaceId]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const currentConv = conversations.find((c) => c.id === currentConvId) ?? null;
  const messages = currentConv?.messages ?? [];
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

  const persistConvs = useCallback(
    (next: Conversation[], nextId?: string | null) => {
      setConversations(next);
      saveConversations(workspaceId, next);
      if (nextId !== undefined) {
        setCurrentConvId(nextId);
        saveCurrentConvId(workspaceId, nextId);
      }
    },
    [workspaceId],
  );

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading, streamingBody]);

  // ── Close history popover on outside click ─────────────────────────────────

  useEffect(() => {
    if (!historyOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest(".conv-history-popover") && !target.closest(".conv-switcher")) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [historyOpen]);

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

      // Phase 10.3 — mark linked graph node as completed when task is checked off
      if (task.node_id) {
        void fetch(`/api/nodes/${task.node_id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nowDone ? "completed" : "active" }),
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

  // ── Conversation operations ────────────────────────────────────────────────

  const newConversation = () => {
    const conv: Conversation = {
      id: `conv-${Date.now()}`,
      title: "New conversation",
      messages: [],
      createdAt: new Date().toISOString(),
    };
    persistConvs([conv, ...conversations], conv.id);
    setHistoryOpen(false);
  };

  // ── Chat (real streaming) ──────────────────────────────────────────────────

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    if (!workspaceId) {
      setChatError("Select a workspace first.");
      return;
    }

    setChatInput("");
    setChatError(null);
    setLoading(true);
    setStreamingBody("");
    setLastChatAttempt(trimmed);

    let working = currentConv;
    if (!working) {
      working = {
        id: `conv-${Date.now()}`,
        title: trimmed.slice(0, 48),
        messages: [],
        createdAt: new Date().toISOString(),
      };
    }

    const userMsg: AssistantMessage = { id: `u-${Date.now()}`, role: "user", body: trimmed };
    const withUser: Conversation = {
      ...working,
      title: working.messages.length === 0 ? trimmed.slice(0, 48) : working.title,
      messages: [...working.messages, userMsg],
    };

    const nextConvs = conversations.some((c) => c.id === withUser.id)
      ? conversations.map((c) => (c.id === withUser.id ? withUser : c))
      : [withUser, ...conversations];

    setConversations(nextConvs);
    setCurrentConvId(withUser.id);

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          workspace_id: workspaceId,
          selected_node_id: selectedNodeId,
          mode: detectMode(trimmed),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(await res.text());
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setStreamingBody(fullText);
      }

      // Detect <plan> block — parse JSON plan and feed into planner
      let displayText = fullText;
      const planMatch = fullText.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/);
      if (planMatch && planMatch[1]?.trim()) {
        displayText = fullText.replace(/<plan>[\s\S]*?<\/plan>/, "").trimEnd();
        try {
          const planData = JSON.parse(planMatch[1].trim()) as {
            planning_window?: PlanningWindow;
            total_minutes?: number;
            blocks?: Array<{
              title: string;
              node_id: string | null;
              duration_minutes: number;
              start_offset: number;
              block_type: PlanBlockType;
              reason: string | null;
            }>;
          };
          if (Array.isArray(planData.blocks) && planData.blocks.length > 0) {
            const sessionId = `chat-plan-${Date.now()}`;
            const planBlocks: PlanBlock[] = planData.blocks.map((b, i) => ({
              id: `chat-block-${Date.now()}-${i}`,
              plan_session_id: sessionId,
              node_id: b.node_id ?? null,
              title: b.title,
              start_offset: b.start_offset,
              duration_minutes: b.duration_minutes,
              reason: b.reason ?? null,
              block_type: b.block_type ?? "focus",
              completion_status: "pending" as const,
            }));
            setPlannerState({
              session: {
                id: sessionId,
                workspace_id: workspaceId ?? "",
                user_id: "",
                planning_window: planData.planning_window ?? "custom",
                scope: null,
                status: "draft",
                created_at: new Date().toISOString(),
              },
              blocks: sortPlanBlocks(planBlocks),
              recentlyUnblockedNodeIds: new Set(),
              loading: false,
              error: null,
              finalised: false,
            });
          }
        } catch {
          // Invalid JSON — ignore silently
        }
      }

      // Detect <nodes> block — extract and send to parent for extraction pipeline
      const nodesMatch = displayText.match(/<nodes>\s*([\s\S]*?)\s*<\/nodes>/);
      if (nodesMatch && nodesMatch[1]?.trim() && workspaceId && onExtractNodes) {
        displayText = displayText.replace(/<nodes>[\s\S]*?<\/nodes>/, "").trimEnd();
        onExtractNodes(nodesMatch[1].trim(), workspaceId);
      }

      const aMsg: AssistantMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        body: displayText,
      };
      const finalConv: Conversation = { ...withUser, messages: [...withUser.messages, aMsg] };
      const finalConvs = nextConvs.map((c) => (c.id === finalConv.id ? finalConv : c));
      persistConvs(finalConvs, finalConv.id);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setLoading(false);
      setStreamingBody("");
    }
  };

  // ── AI planner operations ──────────────────────────────────────────────────

  const handlePlanGenerate = async (window: PlanningWindow) => {
    if (!workspaceId) return;
    setPlannerState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const res = await fetch("/api/assistant/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, planning_window: window }),
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
    } catch {
      setPlannerState((prev) => ({
        ...prev,
        loading: false,
        error: "Network error. Try again.",
      }));
    }
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

  const handlePlanAccept = async (finalBlockIds: string[]) => {
    const sessionId = plannerState.session?.id;
    if (!sessionId) return;

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

      if (newTasks.length > 0) {
        if (!supabase || !workspaceId || !authUserId) {
          persistTasks([...tasks, ...newTasks].sort(compareTasks));
        } else {
          const { data, error } = await supabase
            .from("plan_tasks")
            .insert(newTasks.map((task) => toPlanTaskInsert(task, workspaceId, authUserId)))
            .select(planTaskSelectClause);

          if (error || !data) {
            setPlannerState((prev) => ({
              ...prev,
              error: "Plan was accepted, but tasks could not be saved.",
            }));
            return;
          }

          persistTasks([...tasks, ...normalizeTaskList(data)].sort(compareTasks));
        }
      }

      // Switch to task view at the date these tasks were scheduled onto.
      setSelectedDate(targetDate);
      setPlannerState(INITIAL_PLANNER_STATE);
    } catch {
      setPlannerState((prev) => ({ ...prev, error: "Could not accept the plan. Try again." }));
    }
  };

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
                onClick={() => void handlePlanGenerate(window)}
                type="button"
              >
                {label}
              </button>
            ))}
            <button
              className="assistant-quick-chip"
              onClick={() => void sendMessage("What's next?")}
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
            />
          ) : (
            <>
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

        {/* ── RIGHT: Chat column ── */}
        <div className="assistant-chat-col">
          {/* Header */}
          <div className="chat-col-header">
            <div className="relative">
              <button
                className="conv-switcher"
                onClick={() => setHistoryOpen((o) => !o)}
                type="button"
              >
                <span className="conv-switcher-title truncate">
                  {currentConv?.title ?? "New conversation"}
                </span>
                <ChevronDownIcon
                  className={`h-[12px] w-[12px] shrink-0 transition-transform duration-150 ${
                    historyOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              <AnimatePresence>
                {historyOpen ? (
                  <motion.div
                    className="conv-history-popover"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    initial={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.13 }}
                  >
                    <button
                      className="conv-history-new"
                      onClick={newConversation}
                      type="button"
                    >
                      <PlusIcon className="h-[12px] w-[12px]" />
                      New conversation
                    </button>
                    {conversations.length > 0 ? (
                      <div className="conv-history-list">
                        {conversations.map((conv) => (
                          <button
                            className={`conv-history-item${
                              conv.id === currentConvId ? " conv-history-item-active" : ""
                            }`}
                            key={conv.id}
                            onClick={() => {
                              setCurrentConvId(conv.id);
                              saveCurrentConvId(workspaceId, conv.id);
                              setHistoryOpen(false);
                            }}
                            type="button"
                          >
                            <span className="truncate">{conv.title}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            <button
              aria-label="New conversation"
              className="chat-col-new-btn"
              onClick={newConversation}
              title="New conversation"
              type="button"
            >
              <PlusIcon className="h-[13px] w-[13px]" />
            </button>
          </div>

          {/* Thread or starter */}
          <div className="chat-thread shell-scrollbar">
            {messages.length === 0 && !loading ? (
              <div className="chat-starter-state">
                <div className="chat-starter-glyph">
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
                    <circle cx="11" cy="11" r="10.5" stroke="rgba(213,58,71,0.35)" />
                    <circle cx="11" cy="11" r="6" fill="rgba(213,58,71,0.18)" />
                    <circle cx="11" cy="11" r="3" fill="#d53a47" />
                  </svg>
                </div>
                <p className="chat-starter-heading">What are we working on?</p>
                <p className="chat-starter-sub">
                  Ask for a plan, break down a project, or ask what to tackle next.
                </p>
                <div className="chat-starter-prompts">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      className="chat-starter-prompt"
                      key={prompt}
                      onClick={() => void sendMessage(prompt)}
                      type="button"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-messages">
                {messages.map((msg) =>
                  msg.role === "user" ? (
                    <div className="chat-msg-user" key={msg.id}>
                      <p>{msg.body}</p>
                    </div>
                  ) : (
                    <div className="chat-msg-assistant" key={msg.id}>
                      <div className="chat-msg-assistant-card">
                        <AssistantRichText body={msg.body} />
                      </div>
                    </div>
                  ),
                )}
                {loading ? (
                  <div className="chat-msg-assistant">
                    {streamingBody ? (
                      <div className="chat-msg-assistant-card">
                        <AssistantRichText body={streamingBody} />
                      </div>
                    ) : (
                      <div className="chat-msg-assistant-card">
                        <div className="chat-loading-indicator" aria-live="polite">
                          <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">
                            Thinking
                          </span>
                          <span className="chat-loading-dot" />
                          <span className="chat-loading-dot" />
                          <span className="chat-loading-dot" />
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
                {chatError ? (
                  <div className="chat-msg-assistant">
                    <div className="chat-msg-assistant-card">
                      <p className="text-[12px] text-[var(--color-text-secondary)]">{chatError}</p>
                      {lastChatAttempt ? (
                        <button
                          className="assistant-quick-chip mt-3"
                          onClick={() => void sendMessage(lastChatAttempt)}
                          type="button"
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div ref={threadEndRef} />
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="chat-col-composer">
            <div className="chat-composer-row">
              <textarea
                className="chat-composer-input"
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage(chatInput);
                  }
                }}
                placeholder="Ask for a plan, breakdown, or next steps..."
                rows={1}
                value={chatInput}
              />
              <button
                aria-label="Send"
                className="composer-send-button"
                disabled={loading || chatInput.trim().length === 0}
                onClick={() => void sendMessage(chatInput)}
                type="button"
              >
                <ArrowUpIcon className="h-[15px] w-[15px]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
