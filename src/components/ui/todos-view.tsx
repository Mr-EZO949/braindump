"use client";

import { useMemo, useState } from "react";
import type { GraphData, Node } from "@/types/graph";
import { buildPrimaryStructuralTree } from "@/lib/graph/structure";

type TodosViewProps = {
  graphData: GraphData;
  onSelectNode: (nodeId: string) => void;
  onToggleStatus: (nodeId: string, status: Node["status"]) => void;
};

type SortKey = "score" | "recent" | "deadline";

function scoreOf(n: Node): number {
  return n.current_importance_score ?? n.importance_index ?? 0;
}

// Tier mapping mirrors getScoreTier() in context-rail.tsx — kept in sync so
// the list-row chip color matches the tier label in the details panel.
function scoreTier(score: number): "critical" | "high" | "normal" | "low" {
  if (score >= 90) return "critical";
  if (score >= 74) return "high";
  if (score >= 40) return "normal";
  return "low";
}

type GroupStatus = "active" | "paused" | "completed" | "archived";

function statusRank(status: string | null | undefined): number {
  switch (status) {
    case "active":
    case null:
    case undefined:
      return 0;
    case "paused":
      return 1;
    case "completed":
      return 2;
    case "archived":
      return 3;
    default:
      return 4;
  }
}

// Bucket a task into one of the four list groups. Unset/unknown status falls
// back to "active" so a freshly captured task always lands somewhere visible.
function groupStatus(status: string | null | undefined): GroupStatus {
  switch (status) {
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "archived":
      return "archived";
    default:
      return "active";
  }
}

const GROUP_ORDER: GroupStatus[] = ["active", "paused", "completed", "archived"];

const GROUP_LABEL: Record<GroupStatus, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

export function TodosView({ graphData, onSelectNode, onToggleStatus }: TodosViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [showCompleted, setShowCompleted] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  // Completed/archived start collapsed — they are review surfaces, not the
  // working set. Toggling a group header flips its membership here.
  const [collapsed, setCollapsed] = useState<Set<GroupStatus>>(
    () => new Set<GroupStatus>(["completed", "archived"]),
  );

  const toggleCollapsed = (status: GroupStatus) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const { parentByChild } = useMemo(() => {
    const tree = buildPrimaryStructuralTree(graphData);
    const parentByChild = new Map<string, string>();
    tree.parentCandidates.forEach((cand, childId) => {
      parentByChild.set(childId, cand.parentId);
    });
    return { parentByChild };
  }, [graphData]);

  const { groups, total, summary } = useMemo(() => {
    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));
    const lower = search.trim().toLowerCase();

    const filtered = graphData.nodes.filter((n) => {
      // Tasks only — this is the Todos lens.
      if (n.node_type !== "task") return false;
      if (!showArchived && n.status === "archived") return false;
      if (!showCompleted && n.status === "completed") return false;
      if (lower) {
        const hay = `${n.title} ${n.summary ?? ""}`.toLowerCase();
        if (!hay.includes(lower)) return false;
      }
      return true;
    });

    const items = filtered.map((node) => {
      const parentId = parentByChild.get(node.id) ?? null;
      const parent = parentId ? nodeMap.get(parentId) ?? null : null;
      return { node, parent };
    });

    items.sort((a, b) => {
      const sr = statusRank(a.node.status) - statusRank(b.node.status);
      if (sr !== 0) return sr;
      switch (sortKey) {
        case "score":
          return scoreOf(b.node) - scoreOf(a.node);
        case "recent":
          return (b.node.updated_at ?? "").localeCompare(a.node.updated_at ?? "");
        case "deadline": {
          const ad = a.node.target_date ?? null;
          const bd = b.node.target_date ?? null;
          if (ad && bd) return ad.localeCompare(bd);
          if (ad) return -1;
          if (bd) return 1;
          return scoreOf(b.node) - scoreOf(a.node);
        }
      }
    });

    // Bucket the sorted list into the four status groups, preserving the
    // sort order within each group (the array is already ordered).
    const groups: Record<GroupStatus, typeof items> = {
      active: [],
      paused: [],
      completed: [],
      archived: [],
    };
    for (const item of items) {
      groups[groupStatus(item.node.status)].push(item);
    }

    // Tier breakdown of the active group — the colored dots in the summary.
    let activeCritical = 0;
    let activeHigh = 0;
    for (const { node } of groups.active) {
      const tier = scoreTier(Math.round(scoreOf(node)));
      if (tier === "critical") activeCritical += 1;
      else if (tier === "high") activeHigh += 1;
    }

    const summary = {
      active: groups.active.length,
      paused: groups.paused.length,
      completed: groups.completed.length,
      archived: groups.archived.length,
      activeCritical,
      activeHigh,
    };

    return { groups, total: items.length, summary };
  }, [graphData, search, sortKey, showCompleted, showArchived, parentByChild]);

  return (
    <div className="list-view">
      <div className="list-view-header">
        <h2 className="list-view-title">Todos</h2>
        {total > 0 ? (
          <div className="list-view-summary">
            <span className="list-view-chip" aria-label={`${summary.active} active`}>
              <span className="list-view-chip-dot" style={{ background: "var(--color-accent-primary)" }} />
              Active
              <span className="list-view-chip-count">{summary.active}</span>
              {summary.activeCritical > 0 ? (
                <span
                  className="list-view-chip-dot"
                  data-tier="critical"
                  title={`${summary.activeCritical} critical`}
                />
              ) : null}
              {summary.activeHigh > 0 ? (
                <span
                  className="list-view-chip-dot"
                  data-tier="high"
                  title={`${summary.activeHigh} high`}
                />
              ) : null}
            </span>
            {summary.paused > 0 ? (
              <span className="list-view-chip">
                ⏸ Paused
                <span className="list-view-chip-count">{summary.paused}</span>
              </span>
            ) : null}
            {summary.completed > 0 ? (
              <span className="list-view-chip">
                ✓ Done
                <span className="list-view-chip-count">{summary.completed}</span>
              </span>
            ) : null}
            {summary.archived > 0 ? (
              <span className="list-view-chip">
                Archived
                <span className="list-view-chip-count">{summary.archived}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="list-view-toolbar">
        <input
          type="search"
          className="list-view-search"
          placeholder="Search task title or summary…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="list-view-sort">
          <label className="list-view-sort-label">Sort</label>
          <select
            className="list-view-sort-select"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="score">Score</option>
            <option value="recent">Recent</option>
            <option value="deadline">Deadline</option>
          </select>
        </div>
        <label className="list-view-toggle">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          <span>Show completed</span>
        </label>
        <label className="list-view-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>Show archived</span>
        </label>
      </div>

      {total === 0 ? (
        <div className="list-view-empty">
          {search
            ? "No matches."
            : "No active tasks. Add one with +, or enable Show completed / Show archived to review past work."}
        </div>
      ) : (
        <div className="list-view-groups">
          {GROUP_ORDER.map((status) => {
            const items = groups[status];
            // A group that is empty while others have rows simply renders
            // nothing — no empty section headers cluttering the list.
            if (items.length === 0) return null;
            const isCollapsed = collapsed.has(status);
            return (
              <section
                key={status}
                className="list-view-group"
                data-status={status}
              >
                <button
                  type="button"
                  className="list-view-group-header"
                  data-collapsed={isCollapsed || undefined}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollapsed(status)}
                >
                  <span>{GROUP_LABEL[status]}</span>
                  <span className="list-view-group-count">{items.length}</span>
                  <svg
                    className="list-view-group-chevron"
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    aria-hidden="true"
                  >
                    <path
                      d="m4 6 4 4 4-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {isCollapsed ? null : (
                  <ul className="list-view-rows">
                    {items.map(({ node, parent }) => {
                      const score = Math.round(scoreOf(node));
                      const completed = node.status === "completed";
                      const archived = node.status === "archived";
                      return (
                        <li key={node.id} className="todos-row-wrap">
                          <button
                            type="button"
                            className="todos-row-check"
                            data-checked={completed || undefined}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleStatus(node.id, completed ? "active" : "completed");
                            }}
                            aria-label={completed ? "Mark as not done" : "Mark done"}
                            title={completed ? "Mark as not done" : "Mark done"}
                          >
                            {completed ? (
                              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                                <path
                                  d="m4 8.2 2.8 2.8 5.2-6"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            ) : null}
                          </button>
                          <button
                            type="button"
                            className="list-view-row"
                            data-completed={completed || undefined}
                            data-archived={archived || undefined}
                            data-tier={scoreTier(score)}
                            title={node.importance_reason ?? undefined}
                            onClick={() => onSelectNode(node.id)}
                          >
                            <span className="list-view-row-main">
                              <span className="list-view-row-title">{node.title}</span>
                              {parent ? (
                                <span className="list-view-row-parent">{parent.title}</span>
                              ) : null}
                            </span>
                            <span className="list-view-row-meta">
                              {node.target_date ? (
                                <span className="list-view-row-date">{node.target_date}</span>
                              ) : null}
                              <span
                                className="list-view-row-score"
                                data-tier={scoreTier(score)}
                              >
                                {score}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
