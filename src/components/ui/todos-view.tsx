"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GraphData, Node } from "@/types/graph";
import { NODE_TYPE_INFO } from "@/lib/graph/node-types";
import {
  TODOS_GROUPINGS,
  buildTodos,
  dueLabel,
  todoScore,
  type TodoItem,
  type TodoSection,
  type TodosGrouping,
} from "@/lib/graph/todos";
import { computeWorkProgress } from "@/lib/graph/work-progress";
import { localDateISO } from "@/lib/time/local-date";

type TodosViewProps = {
  graphData: GraphData;
  onSelectNode: (nodeId: string) => void;
  onToggleStatus: (nodeId: string, status: Node["status"]) => void;
};

const GROUPING_LABEL: Record<TodosGrouping, string> = {
  project: "Project",
  priority: "Priority",
  due: "Due",
};

const GROUPING_STORAGE_KEY = "braindump:todos-grouping";

// How long a just-checked task stays in place (struck through) before it
// moves to Done — long enough to see it land, short enough not to linger.
const SETTLE_MS = 1600;

// Done can grow without end; show the most recent ones.
const DONE_SHOWN = 30;

// Same thresholds as getScoreTier() in context-rail.tsx: only the two top
// tiers get a colored checkbox, everything else stays quiet.
function priorityTier(node: Node): "critical" | "high" | undefined {
  const score = Math.round(todoScore(node));
  if (score >= 90) return "critical";
  if (score >= 74) return "high";
  return undefined;
}

function readGrouping(): TodosGrouping {
  try {
    const stored = window.localStorage.getItem(GROUPING_STORAGE_KEY);
    if (stored && (TODOS_GROUPINGS as readonly string[]).includes(stored)) return stored as TodosGrouping;
  } catch {
    // storage unavailable — default grouping
  }
  return "project";
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TodosView({ graphData, onSelectNode, onToggleStatus }: TodosViewProps) {
  // Todos only mounts after a click in the dock (never server-rendered), so
  // the stored choice can be read on the first render.
  const [grouping, setGrouping] = useState<TodosGrouping>(readGrouping);
  const [search, setSearch] = useState("");
  // Section keys the user folded. Paused and Done start folded — they're for
  // review, not the working set.
  const [folded, setFolded] = useState<Set<string>>(() => new Set(["paused", "done"]));
  // Big tasks whose steps are hidden (steps show by default — they're the
  // actionable part).
  const [hiddenSteps, setHiddenSteps] = useState<Set<string>>(() => new Set());
  const [settling, setSettling] = useState<Set<string>>(() => new Set());
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = settleTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  const chooseGrouping = (next: TodosGrouping) => {
    setGrouping(next);
    try {
      window.localStorage.setItem(GROUPING_STORAGE_KEY, next);
    } catch {
      // storage unavailable — the choice lasts for this visit
    }
  };

  const toggleIn = (setter: typeof setFolded, key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const today = localDateISO();
  const model = useMemo(
    () => buildTodos(graphData, { grouping, today, search, settling }),
    [graphData, grouping, today, search, settling],
  );
  const progress = useMemo(() => computeWorkProgress(graphData), [graphData]);

  const endSettle = (nodeId: string) => {
    const timer = settleTimers.current.get(nodeId);
    if (timer) clearTimeout(timer);
    settleTimers.current.delete(nodeId);
    setSettling((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
  };

  const toggleDone = (node: Node) => {
    const completed = node.status === "completed";
    if (completed) {
      endSettle(node.id);
      onToggleStatus(node.id, "active");
      return;
    }
    setSettling((prev) => new Set(prev).add(node.id));
    settleTimers.current.set(
      node.id,
      setTimeout(() => endSettle(node.id), SETTLE_MS),
    );
    onToggleStatus(node.id, "completed");
  };

  // The line under a title says only what its place in the list doesn't:
  // the parent unless the section names it (or it's a nested step), why
  // something is paused, a big task that still needs breaking down.
  function metaFor(entry: TodoItem, section: TodoSection | null, depth: number): string[] {
    const { node, parent } = entry;
    const parts: string[] = [];
    if (node.status === "paused") {
      parts.push(node.waiting_for ? `Waiting for ${node.waiting_for}` : "Paused");
      if (node.resume_on) parts.push(`back ${dueLabel(node.resume_on, today).text}`);
    }
    const sectionNamesParent = section?.kind === "parent" && section.parent?.id === parent?.id;
    if (parent && depth === 0 && !sectionNamesParent) parts.push(parent.title);
    if (node.node_type === "big_task" && !progress.get(node.id)?.total && node.status !== "completed") {
      parts.push("No steps yet");
    }
    return parts;
  }

  function renderItem(entry: TodoItem, section: TodoSection | null, depth = 0): ReactNode {
    const { node } = entry;
    const completed = node.status === "completed";
    const isBigTask = node.node_type === "big_task";
    const stepProgress = isBigTask ? progress.get(node.id) : undefined;
    const stepsShown = entry.steps.length > 0 && !hiddenSteps.has(node.id);
    // In Project grouping the section header carries the project's deadline;
    // repeat an inherited one only where the row stands alone.
    const due =
      entry.due && !completed && !(grouping === "project" && !search && entry.due.from) ? entry.due : null;
    const label = due ? dueLabel(due.date, today) : null;
    const meta = metaFor(entry, section, depth);

    return (
      <li key={node.id} className="todo-item" data-depth={depth || undefined}>
        <div
          className="todo-row"
          data-big={isBigTask || undefined}
          data-done={completed || undefined}
          data-paused={node.status === "paused" || undefined}
        >
          <button
            type="button"
            className="todo-check"
            data-checked={completed || undefined}
            data-tier={priorityTier(node)}
            onClick={() => toggleDone(node)}
            aria-label={completed ? `Mark "${node.title}" as not done` : `Mark "${node.title}" done`}
            title={completed ? "Mark as not done" : "Mark done"}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path d="m4 8.2 2.8 2.8 5.2-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="todo-main"
            onClick={() => onSelectNode(node.id)}
            title={node.importance_reason ?? "Open in the graph"}
          >
            <span className="todo-title">{node.title}</span>
            {meta.length > 0 ? <span className="todo-meta">{meta.join(" · ")}</span> : null}
          </button>
          <span className="todo-trail">
            {label ? (
              <span
                className="todo-due"
                data-tone={label.tone}
                data-inherited={due?.from ? true : undefined}
                title={due?.from ? `Deadline of ${due.from.title}` : "Deadline"}
              >
                {label.text}
              </span>
            ) : null}
            {stepProgress && stepProgress.total > 0 ? (
              <span className="todo-progress" title={`${stepProgress.done} of ${stepProgress.total} steps done`}>
                <span className="todo-progress-bar" aria-hidden="true">
                  <span style={{ width: `${(stepProgress.done / stepProgress.total) * 100}%` }} />
                </span>
                {stepProgress.done}/{stepProgress.total}
              </span>
            ) : null}
            {entry.steps.length > 0 ? (
              <button
                type="button"
                className="todo-steps-toggle"
                data-open={stepsShown || undefined}
                aria-expanded={stepsShown}
                aria-label={stepsShown ? "Hide steps" : "Show steps"}
                title={stepsShown ? "Hide steps" : "Show steps"}
                onClick={() => toggleIn(setHiddenSteps, node.id)}
              >
                <Chevron />
              </button>
            ) : (
              <span className="todo-steps-slot" aria-hidden="true" />
            )}
          </span>
        </div>
        {stepsShown ? (
          <ul className="todo-steps">{entry.steps.map((step) => renderItem(step, section, depth + 1))}</ul>
        ) : null}
      </li>
    );
  }

  function renderSection(
    key: string,
    head: ReactNode,
    count: number,
    items: TodoItem[],
    section: TodoSection | null,
    opts: { quiet?: boolean; footer?: ReactNode } = {},
  ) {
    const isFolded = folded.has(key);
    return (
      <section key={key} className="todo-section" data-quiet={opts.quiet || undefined} data-tone={section?.tone}>
        <button
          type="button"
          className="todo-section-head"
          aria-expanded={!isFolded}
          onClick={() => toggleIn(setFolded, key)}
        >
          <Chevron className="todo-section-chevron" />
          {head}
          <span className="todo-section-count">{count}</span>
        </button>
        {isFolded ? null : (
          <>
            <ul className="todo-list">{items.map((entry) => renderItem(entry, section))}</ul>
            {opts.footer}
          </>
        )}
      </section>
    );
  }

  function sectionHead(section: TodoSection) {
    if (section.kind !== "parent" || !section.parent) {
      return <span className="todo-section-title">{section.title}</span>;
    }
    const parent = section.parent;
    const label = parent.target_date ? dueLabel(parent.target_date, today) : null;
    return (
      <>
        <span className="todo-section-title">{section.title}</span>
        <span className="todo-section-type">{NODE_TYPE_INFO[parent.node_type]?.label ?? parent.node_type}</span>
        {label ? (
          <span className="todo-due" data-tone={label.tone} title="Deadline">
            {label.text}
          </span>
        ) : null}
      </>
    );
  }

  const nothingOpen = model.openCount === 0 && !search;
  const doneShown = model.done.slice(0, DONE_SHOWN);

  return (
    <div className="todos-view">
      <header className="todos-header">
        <h2 className="todos-title">Todos</h2>
        <span className="todos-counts">
          {model.openCount} open
          {model.doneCount > 0 ? ` · ${model.doneCount} done` : ""}
        </span>
      </header>

      <div className="todos-toolbar">
        <input
          type="search"
          className="todos-search"
          placeholder="Search tasks"
          aria-label="Search tasks"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="habits-segment" role="tablist" aria-label="Group by">
          {TODOS_GROUPINGS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              className="habits-segment-btn"
              data-active={grouping === g}
              aria-selected={grouping === g}
              onClick={() => chooseGrouping(g)}
            >
              {GROUPING_LABEL[g]}
            </button>
          ))}
        </div>
      </div>

      {nothingOpen ? (
        <div className="todos-empty">
          <p className="todos-empty-title">Nothing open.</p>
          <p>New tasks show up here when you dump or add them in the graph.</p>
        </div>
      ) : null}

      <div className="todos-sections">
        {model.sections.map((section) => {
          if (section.kind !== "search" && section.kind !== "flat") {
            return renderSection(section.key, sectionHead(section), section.count, section.items, section);
          }
          // One list (Priority, or search results) needs no foldable header.
          if (section.items.length === 0) {
            return section.kind === "search" ? (
              <div key={section.key} className="todos-empty">
                No tasks match “{search.trim()}”.
              </div>
            ) : null;
          }
          return (
            <section key={section.key} className="todo-section" data-plain>
              {section.kind === "search" ? <p className="todo-section-caption">{section.title}</p> : null}
              <ul className="todo-list">{section.items.map((entry) => renderItem(entry, section))}</ul>
            </section>
          );
        })}

        {model.paused.length > 0
          ? renderSection(
              "paused",
              <span className="todo-section-title">Paused</span>,
              model.paused.length,
              model.paused,
              null,
              { quiet: true },
            )
          : null}

        {model.done.length > 0
          ? renderSection(
              "done",
              <span className="todo-section-title">Done</span>,
              model.done.length,
              doneShown,
              null,
              {
                quiet: true,
                footer:
                  model.done.length > DONE_SHOWN ? (
                    <p className="todo-section-more">
                      {model.done.length - DONE_SHOWN} older — search to find one.
                    </p>
                  ) : null,
              },
            )
          : null}
      </div>
    </div>
  );
}
