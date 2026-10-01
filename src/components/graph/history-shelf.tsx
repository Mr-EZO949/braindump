"use client";

import { useMemo, useState } from "react";
import { groupArchivedNodes } from "@/lib/graph/archive-groups";
import { NODE_TYPE_INFO, normalizeNodeType } from "@/lib/graph/node-types";
import type { GraphData, Node } from "@/types/graph";

type HistoryShelfProps = {
  completedNodes: Node[];
  graphData: GraphData;
  onRestoreArchived: (nodeId: string) => void;
  onSelectArchived: (nodeId: string) => void;
  onSelectCompleted: (nodeId: string) => void;
  selectedNodeId: string | null;
};

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HistoryShelf({
  completedNodes,
  graphData,
  onRestoreArchived,
  onSelectArchived,
  onSelectCompleted,
  selectedNodeId,
}: HistoryShelfProps) {
  const [openTab, setOpenTab] = useState<"done" | "archive" | null>(null);
  const [archiveSearch, setArchiveSearch] = useState("");
  const archivedGroups = useMemo(() => groupArchivedNodes(graphData), [graphData]);
  const archivedCount = archivedGroups.reduce((count, group) => count + group.nodes.length, 0);
  const sortedCompleted = useMemo(
    () =>
      [...completedNodes].sort((a, b) =>
        (b.completed_at ?? "").localeCompare(a.completed_at ?? ""),
      ),
    [completedNodes],
  );
  const query = archiveSearch.trim().toLocaleLowerCase();
  const visibleGroups = query
    ? archivedGroups
        .map((group) => ({
          ...group,
          nodes: group.nodes.filter(
            (node) =>
              node.title.toLocaleLowerCase().includes(query) ||
              group.parent?.title.toLocaleLowerCase().includes(query),
          ),
        }))
        .filter((group) => group.nodes.length > 0)
    : archivedGroups;

  if (completedNodes.length === 0 && archivedCount === 0) return null;

  return (
    <div className="history-shelf">
      {openTab ? (
        <section
          className="history-shelf-panel"
          aria-label={openTab === "archive" ? "Archive" : "Completed history"}
        >
          <div className="history-shelf-header">
            <div>
              <span className="history-shelf-kicker">History</span>
              <h2>{openTab === "archive" ? "Archive" : "Finished work"}</h2>
            </div>
            <button
              className="history-shelf-close"
              aria-label="Close history"
              onClick={() => setOpenTab(null)}
              type="button"
            >
              ×
            </button>
          </div>
          <p className="history-shelf-description">
            {openTab === "archive"
              ? "Put aside for now. Everything here can return to your graph."
              : "Older completed items stay here; recent wins remain on the graph."}
          </p>

          {openTab === "archive" ? (
            <>
              <label className="history-shelf-search">
                <span className="sr-only">Search archive</span>
                <input
                  onChange={(event) => setArchiveSearch(event.target.value)}
                  placeholder="Find in archive"
                  type="search"
                  value={archiveSearch}
                />
              </label>
              <div className="history-shelf-scroll">
                {visibleGroups.length > 0 ? (
                  visibleGroups.map((group) => (
                    <div className="history-shelf-group" key={group.parent?.id ?? "unfiled"}>
                      <div className="history-shelf-group-heading">
                        <span>{group.parent ? `From ${group.parent.title}` : "Unfiled"}</span>
                        <span>{group.nodes.length}</span>
                      </div>
                      <ul className="history-shelf-list">
                        {group.nodes.map((node) => (
                          <li
                            className="history-shelf-item history-shelf-item--archived"
                            data-selected={selectedNodeId === node.id}
                            key={node.id}
                          >
                            <button
                              aria-label={`Open archived node ${node.title}`}
                              className="history-shelf-item-main"
                              onClick={() => onSelectArchived(node.id)}
                              type="button"
                            >
                              <span className="history-shelf-archive-type">
                                {NODE_TYPE_INFO[normalizeNodeType(node.node_type)].label}
                              </span>
                              <span className="history-shelf-item-title">{node.title}</span>
                              <span className="history-shelf-item-meta">
                                {node.archived_at
                                  ? `Archived ${shortDate(node.archived_at)}`
                                  : "Archived"}
                              </span>
                            </button>
                            <button
                              aria-label={`Restore ${node.title}`}
                              className="history-shelf-restore"
                              onClick={() => onRestoreArchived(node.id)}
                              title="Restore to graph"
                              type="button"
                            >
                              Restore
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                ) : (
                  <p className="history-shelf-empty">No archived items match that search.</p>
                )}
              </div>
            </>
          ) : (
            <div className="history-shelf-scroll">
              <ul className="history-shelf-list">
                {sortedCompleted.map((node) => (
                  <li
                    className="history-shelf-item history-shelf-item--done"
                    data-selected={selectedNodeId === node.id}
                    key={node.id}
                  >
                    <button
                      className="history-shelf-item-main"
                      onClick={() => onSelectCompleted(node.id)}
                      type="button"
                    >
                      <span className="history-shelf-item-title">{node.title}</span>
                      <span className="history-shelf-item-meta">
                        {shortDate(node.completed_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : null}

      <div className="history-shelf-triggers">
        {completedNodes.length > 0 ? (
          <button
            aria-expanded={openTab === "done"}
            className="history-shelf-trigger history-shelf-trigger--done"
            onClick={() => setOpenTab(openTab === "done" ? null : "done")}
            type="button"
          >
            <span className="history-shelf-trigger-icon" aria-hidden="true">
              ✓
            </span>
            Done <strong>{completedNodes.length}</strong>
          </button>
        ) : null}
        {archivedCount > 0 ? (
          <button
            aria-expanded={openTab === "archive"}
            className="history-shelf-trigger history-shelf-trigger--archive"
            onClick={() => setOpenTab(openTab === "archive" ? null : "archive")}
            type="button"
          >
            <span className="history-shelf-trigger-icon" aria-hidden="true">
              ▤
            </span>
            Archive <strong>{archivedCount}</strong>
          </button>
        ) : null}
      </div>
    </div>
  );
}
