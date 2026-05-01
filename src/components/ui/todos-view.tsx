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

export function TodosView({ graphData, onSelectNode, onToggleStatus }: TodosViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [showCompleted, setShowCompleted] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");

  const { parentByChild } = useMemo(() => {
    const tree = buildPrimaryStructuralTree(graphData);
    const parentByChild = new Map<string, string>();
    tree.parentCandidates.forEach((cand, childId) => {
      parentByChild.set(childId, cand.parentId);
    });
    return { parentByChild };
  }, [graphData]);

  const rows = useMemo(() => {
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

    return items;
  }, [graphData, search, sortKey, showCompleted, showArchived, parentByChild]);

  return (
    <div className="list-view">
      <div className="list-view-header">
        <h2 className="list-view-title">Todos</h2>
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

      {rows.length === 0 ? (
        <div className="list-view-empty">
          {search ? "No matches." : "No tasks match your filters."}
        </div>
      ) : (
        <ul className="list-view-rows">
          {rows.map(({ node, parent }) => {
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
                    <span className="list-view-row-score">{score}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
