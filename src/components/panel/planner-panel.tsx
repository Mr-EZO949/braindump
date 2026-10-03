"use client";

// PlannerPanel — Phase 10.3
// Renders inside the ContextRail planner tab.
// Lets the user pick a planning window, generate an AI plan, review blocks,
// reorder/delete blocks, and accept or reject the full plan.

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useState } from "react";

import { GripVerticalIcon } from "@/components/ui/icons";
import { DAY_PLAN_END_MINUTE, PLAN_MAX_MINUTES, PLAN_MIN_MINUTES } from "@/lib/planner/plan-window";
import type { PlanBlock, PlanSession, PlanningWindow } from "@/types/ai";
import type { GraphData } from "@/types/graph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerState {
  session: PlanSession | null;
  blocks: PlanBlock[];
  recentlyUnblockedNodeIds: Set<string>;
  loading: boolean;
  error: string | null;
  finalised: boolean; // accepted or rejected
}

export const INITIAL_PLANNER_STATE: PlannerState = {
  session: null,
  blocks: [],
  recentlyUnblockedNodeIds: new Set(),
  loading: false,
  error: null,
  finalised: false,
};

export type GeneratePlanOptions = {
  window: PlanningWindow;
  // "HH:MM" to anchor the plan at a specific clock time, or null = start now.
  start_time: string | null;
  // Total minutes when window === "custom" (clamped 15 min–18 h); null otherwise.
  custom_minutes: number | null;
};

type PlannerPanelProps = {
  graphData: GraphData;
  plannerState: PlannerState;
  onGenerate: (options: GeneratePlanOptions) => void;
  onDeleteBlock: (blockId: string) => void;
  onReorderBlocks: (blockIds: string[]) => void;
  onAccept: (finalBlockIds: string[]) => void;
  onReject: () => void;
  onReset: () => void;
  onCancel: () => void;
  // True while an accept is being written (tasks saved). Disables the
  // Accept/Reject buttons so a second click can't apply the plan twice —
  // which stacked duplicate, overlapping tasks on the day (journal #6a).
  accepting?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WINDOW_OPTIONS: { value: PlanningWindow; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "2h", label: "2 hours" },
  { value: "day", label: "Full day" },
  { value: "custom", label: "Custom" },
];

const CUSTOM_MINUTES_MIN = PLAN_MIN_MINUTES;
const CUSTOM_MINUTES_MAX = PLAN_MAX_MINUTES;
const DAY_END_LABEL = `${String(Math.floor(DAY_PLAN_END_MINUTE / 60)).padStart(2, "0")}:${String(DAY_PLAN_END_MINUTE % 60).padStart(2, "0")}`;
const CUSTOM_MINUTES_DEFAULT = 90;

function clampCustomMinutes(value: number): number {
  if (!Number.isFinite(value)) return CUSTOM_MINUTES_DEFAULT;
  return Math.max(CUSTOM_MINUTES_MIN, Math.min(CUSTOM_MINUTES_MAX, Math.round(value)));
}

const BLOCK_TYPE_LABEL: Record<string, string> = {
  focus: "Focus",
  admin: "Admin",
  break: "Break",
  buffer: "Buffer",
};

const BLOCK_TYPE_COLOR: Record<string, string> = {
  focus: "planner-block-type--focus",
  admin: "planner-block-type--admin",
  break: "planner-block-type--break",
  buffer: "planner-block-type--buffer",
};

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

type SortablePlannerBlockProps = {
  block: PlanBlock;
  linkedNodeTitle: string | null;
  linkedNodeType: string | null;
  isFinalised: boolean;
  isUnblocked: boolean;
  onDeleteBlock: (blockId: string) => void;
};

function SortablePlannerBlock({
  block,
  linkedNodeTitle,
  linkedNodeType,
  isFinalised,
  isUnblocked,
  onDeleteBlock,
}: SortablePlannerBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: block.id,
    disabled: isFinalised,
  });

  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className="planner-block"
      data-dragging={isDragging}
      style={style}
    >
      <div className="planner-block-left">
        {!isFinalised ? (
          <button
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${block.title}`}
            className="planner-block-handle"
            title="Drag to reorder"
            type="button"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="h-[14px] w-[14px]" />
          </button>
        ) : null}

        <span className={`planner-block-type ${BLOCK_TYPE_COLOR[block.block_type] ?? ""}`}>
          {BLOCK_TYPE_LABEL[block.block_type] ?? block.block_type}
        </span>

        <div className="planner-block-body">
          <p className="planner-block-title">
            {block.title}
            {isUnblocked ? (
              <span className="planner-unblocked-badge" title="Dependencies just cleared — ready to start">
                Ready
              </span>
            ) : null}
          </p>
          {linkedNodeTitle && linkedNodeType ? (
            <p className="planner-block-node-link">
              {linkedNodeType} · {linkedNodeTitle}
            </p>
          ) : null}
          {block.reason ? (
            <p className="planner-block-reason">{block.reason}</p>
          ) : null}
        </div>
      </div>

      <div className="planner-block-right">
        <span className="planner-block-duration">{formatDuration(block.duration_minutes)}</span>
        {!isFinalised ? (
          <button
            className="planner-block-delete"
            onClick={() => onDeleteBlock(block.id)}
            title="Remove block"
            type="button"
            aria-label={`Remove ${block.title}`}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlannerPanel({
  graphData,
  plannerState,
  onGenerate,
  onDeleteBlock,
  onReorderBlocks,
  onAccept,
  onReject,
  onReset,
  onCancel,
  accepting = false,
}: PlannerPanelProps) {
  const [selectedWindow, setSelectedWindow] = useState<PlanningWindow>("2h");
  const [startMode, setStartMode] = useState<"now" | "at">("now");
  const [startTime, setStartTime] = useState<string>("09:00");
  const [customMinutes, setCustomMinutes] = useState<string>(String(CUSTOM_MINUTES_DEFAULT));
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const nodeById = new Map(graphData.nodes.map((n) => [n.id, n]));
  const { session, blocks, recentlyUnblockedNodeIds, loading, error, finalised } = plannerState;
  const sortableBlockIds = blocks.map((block) => block.id);

  // Total time accounted for in current block list
  const totalPlanned = blocks.reduce((sum, b) => sum + b.duration_minutes, 0);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || finalised) {
      return;
    }

    const activeIndex = blocks.findIndex((block) => block.id === active.id);
    const overIndex = blocks.findIndex((block) => block.id === over.id);

    if (activeIndex < 0 || overIndex < 0) {
      return;
    }

    const nextOrder = arrayMove(blocks, activeIndex, overIndex).map((block) => block.id);
    onReorderBlocks(nextOrder);
  };

  // ---------------------------------------------------------------------------
  // Empty / generate state
  // ---------------------------------------------------------------------------
  if (!session && !loading) {
    return (
      <div className="planner-empty-state">
        <p className="planner-empty-heading">Plan your session</p>
        <p className="planner-empty-sub">
          AI picks your highest-priority work and schedules a realistic time-blocked plan.
        </p>

        <div className="planner-config-group">
          <span className="planner-config-label">Start</span>
          <div className="planner-config-row">
            <div className="planner-window-strip" role="group" aria-label="Plan start">
              <button
                className="planner-window-btn"
                data-active={startMode === "now"}
                onClick={() => setStartMode("now")}
                type="button"
              >
                Now
              </button>
              <button
                className="planner-window-btn"
                data-active={startMode === "at"}
                onClick={() => setStartMode("at")}
                type="button"
              >
                At a time
              </button>
            </div>
            {startMode === "at" ? (
              <input
                aria-label="Start time"
                className="planner-config-input planner-config-time"
                onChange={(e) => setStartTime(e.target.value)}
                type="time"
                value={startTime}
              />
            ) : null}
          </div>
        </div>

        <div className="planner-config-group">
          <span className="planner-config-label">Length</span>
          <div className="planner-window-strip" role="group" aria-label="Planning window">
            {WINDOW_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                className="planner-window-btn"
                data-active={selectedWindow === value}
                onClick={() => setSelectedWindow(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          {selectedWindow === "custom" ? (
            <div className="planner-config-row planner-custom-duration">
              <input
                aria-label="Custom duration in minutes"
                className="planner-config-input planner-config-minutes"
                max={CUSTOM_MINUTES_MAX}
                min={CUSTOM_MINUTES_MIN}
                onBlur={() => setCustomMinutes(String(clampCustomMinutes(Number(customMinutes))))}
                onChange={(e) => setCustomMinutes(e.target.value)}
                step={5}
                type="number"
                value={customMinutes}
              />
              <span className="planner-config-unit">min</span>
              <span className="planner-config-hint">
                {CUSTOM_MINUTES_MIN} min–{CUSTOM_MINUTES_MAX / 60} h
              </span>
            </div>
          ) : selectedWindow === "day" ? (
            <p className="planner-config-hint planner-day-hint">Plans until {DAY_END_LABEL}</p>
          ) : null}
        </div>

        {error ? (
          <p className="planner-error">{error}</p>
        ) : null}

        <button
          className="planner-generate-btn"
          disabled={loading}
          onClick={() =>
            onGenerate({
              window: selectedWindow,
              start_time: startMode === "at" ? startTime : null,
              custom_minutes:
                selectedWindow === "custom" ? clampCustomMinutes(Number(customMinutes)) : null,
            })
          }
          type="button"
        >
          Generate plan
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="planner-loading">
        <div className="planner-loading-head">
          <span className="ai-status-dot" />
          <div className="planner-loading-copy">
            <p className="planner-loading-title">Building your plan…</p>
            <p className="planner-loading-sub">
              Picking your highest-priority work and time-blocking a realistic session.
            </p>
          </div>
          <button className="planner-loading-cancel" onClick={onCancel} type="button">
            Cancel
          </button>
        </div>
        <div className="planner-loading-skeletons" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div className="planner-loading-skel" key={i} style={{ animationDelay: `${i * 0.12}s` }}>
              <span className="planner-loading-skel-time" />
              <span className="planner-loading-skel-body">
                <span className="planner-loading-skel-line" />
                <span className="planner-loading-skel-line planner-loading-skel-line--short" />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Plan ready (or finalised)
  // ---------------------------------------------------------------------------
  return (
    <div className="planner-plan-view">
      {/* Header row */}
      <div className="planner-plan-header">
        <div>
          <p className="planner-plan-window-label">
            {session?.planning_window === "custom" && session.custom_minutes
              ? formatDuration(session.custom_minutes)
              : WINDOW_OPTIONS.find((w) => w.value === session?.planning_window)?.label ??
                session?.planning_window}
            {" · "}
            {formatDuration(totalPlanned)} scheduled
          </p>
          {finalised ? (
            <p className="planner-plan-finalised-badge">
              {session?.status === "accepted" ? "Accepted" : "Rejected"}
            </p>
          ) : null}
        </div>
        <button
          className="planner-reset-btn"
          onClick={onReset}
          type="button"
          title="Start over"
        >
          New plan
        </button>
      </div>

      {error ? (
        <p className="planner-error planner-error-inline">{error}</p>
      ) : null}

      {/* Block list */}
      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <div className="planner-block-list">
          {!finalised && blocks.length > 1 ? (
            <p className="planner-reorder-hint">Drag blocks to reorder before accepting.</p>
          ) : null}

          <SortableContext items={sortableBlockIds} strategy={verticalListSortingStrategy}>
            {blocks.map((block) => {
              const linkedNode = block.node_id ? nodeById.get(block.node_id) : null;
              const isUnblocked = block.node_id
                ? recentlyUnblockedNodeIds.has(block.node_id)
                : false;

              return (
                <SortablePlannerBlock
                  key={block.id}
                  block={block}
                  isFinalised={finalised}
                  isUnblocked={isUnblocked}
                  linkedNodeTitle={linkedNode?.title ?? null}
                  linkedNodeType={linkedNode?.node_type ?? null}
                  onDeleteBlock={onDeleteBlock}
                />
              );
            })}
          </SortableContext>

          {blocks.length === 0 && !finalised ? (
            <p className="planner-empty-blocks">All blocks removed. Reject or generate a new plan.</p>
          ) : null}
        </div>
      </DndContext>

      {/* Actions */}
      {!finalised ? (
        <div className="planner-actions">
          <button
            className="planner-reject-btn"
            disabled={accepting}
            onClick={onReject}
            type="button"
          >
            Reject
          </button>
          <button
            className="planner-accept-btn"
            data-busy={accepting || undefined}
            disabled={blocks.length === 0 || accepting}
            onClick={() => onAccept(blocks.map((b) => b.id))}
            type="button"
          >
            {accepting ? "Accepting…" : "Accept plan"}
          </button>
        </div>
      ) : (
        <div className="planner-actions">
          <button className="planner-generate-btn" onClick={onReset} type="button">
            Plan another session
          </button>
        </div>
      )}
    </div>
  );
}
