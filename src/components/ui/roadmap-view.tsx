"use client";

import { useMemo } from "react";
import type { GraphData, Node } from "@/types/graph";
import { buildPrimaryStructuralTree } from "@/lib/graph/structure";

type RoadmapViewProps = {
  graphData: GraphData;
  onSelectNode: (nodeId: string) => void;
};

const ROADMAP_TYPES = new Set(["goal", "project"]);

type RoadmapItem = {
  node: Node;
  daysFromNow: number;
  progress: { done: number; total: number };
};

type Bucket = {
  label: string;
  // Sort key — yyyy-mm or "overdue" / "later" sentinel that sorts correctly
  key: string;
  items: RoadmapItem[];
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function diffInDays(targetISO: string, todayISO_: string): number {
  // Parse as UTC midnight to avoid TZ drift in the day-difference calc.
  const [ty, tm, td] = targetISO.split("-").map((s) => parseInt(s, 10));
  const [ny, nm, nd] = todayISO_.split("-").map((s) => parseInt(s, 10));
  const target = Date.UTC(ty, tm - 1, td);
  const now = Date.UTC(ny, nm - 1, nd);
  return Math.round((target - now) / (1000 * 60 * 60 * 24));
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map((s) => parseInt(s, 10));
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

// Walks belongs_to descendants and tallies completion. The progress is
// (completed descendants / total descendants). If a node has no descendants
// we report 0/0 — the UI hides the bar in that case.
function progressFor(
  rootId: string,
  childrenByParent: Map<string, string[]>,
  nodeMap: Map<string, Node>,
): { done: number; total: number } {
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  let done = 0;
  let total = 0;
  while (stack.length > 0) {
    const id = stack.pop()!;
    const child = nodeMap.get(id);
    if (!child) continue;
    total++;
    if (child.status === "completed") done++;
    const grandchildren = childrenByParent.get(id);
    if (grandchildren) stack.push(...grandchildren);
  }
  return { done, total };
}

export function RoadmapView({ graphData, onSelectNode }: RoadmapViewProps) {
  const buckets = useMemo<Bucket[]>(() => {
    const today = todayISO();
    const dated = graphData.nodes.filter(
      (n) =>
        ROADMAP_TYPES.has(n.node_type) &&
        typeof n.target_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(n.target_date) &&
        n.status !== "archived",
    );

    const { childrenByParent } = buildPrimaryStructuralTree(graphData);
    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));

    const items: RoadmapItem[] = dated.map((node) => ({
      node,
      daysFromNow: diffInDays(node.target_date as string, today),
      progress: progressFor(node.id, childrenByParent, nodeMap),
    }));

    // Sort by date ascending so each bucket renders in chronological order
    items.sort(
      (a, b) =>
        (a.node.target_date as string).localeCompare(b.node.target_date as string),
    );

    // Group: overdue (past + not completed) → calendar months → done.
    const overdueBucket: Bucket = { label: "Overdue", key: "0000-overdue", items: [] };
    const monthBuckets = new Map<string, Bucket>();
    const completedBucket: Bucket = { label: "Completed", key: "9999-done", items: [] };

    for (const item of items) {
      const isCompleted = item.node.status === "completed";
      if (isCompleted) {
        completedBucket.items.push(item);
        continue;
      }
      if (item.daysFromNow < 0) {
        overdueBucket.items.push(item);
        continue;
      }
      const key = monthKey(item.node.target_date as string);
      let bucket = monthBuckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          label: monthLabel(item.node.target_date as string),
          items: [],
        };
        monthBuckets.set(key, bucket);
      }
      bucket.items.push(item);
    }

    const ordered: Bucket[] = [];
    if (overdueBucket.items.length > 0) ordered.push(overdueBucket);
    ordered.push(...[...monthBuckets.values()].sort((a, b) => a.key.localeCompare(b.key)));
    if (completedBucket.items.length > 0) ordered.push(completedBucket);
    return ordered;
  }, [graphData]);

  if (buckets.length === 0) {
    return (
      <div className="roadmap-empty">
        <h2 className="roadmap-empty-title">No deadlined items yet</h2>
        <p className="roadmap-empty-body">
          Add a target date to a goal or project (in the create / edit form, or by
          asking the assistant — &ldquo;set deadline for X to August 1&rdquo;).
          Anything with a date shows up here grouped by month.
        </p>
      </div>
    );
  }

  return (
    <div className="roadmap-view">
      {buckets.map((bucket) => (
        <section className="roadmap-bucket" key={bucket.key} data-overdue={bucket.key === "0000-overdue"}>
          <header className="roadmap-bucket-header">
            <h3 className="roadmap-bucket-label">{bucket.label}</h3>
            <span className="roadmap-bucket-count">{bucket.items.length}</span>
          </header>
          <ol className="roadmap-bucket-list">
            {bucket.items.map((item) => {
              const date = item.node.target_date as string;
              const days = item.daysFromNow;
              const dateDisplay = formatDateDisplay(date, days);
              const ratio = item.progress.total > 0 ? item.progress.done / item.progress.total : 0;
              const completed = item.node.status === "completed";
              const overdue = !completed && days < 0;
              return (
                <li key={item.node.id}>
                  <button
                    type="button"
                    className="roadmap-item"
                    data-overdue={overdue || undefined}
                    data-completed={completed || undefined}
                    data-type={item.node.node_type}
                    onClick={() => onSelectNode(item.node.id)}
                  >
                    <div className="roadmap-item-head">
                      <span className="roadmap-item-type">{item.node.node_type}</span>
                      <span className="roadmap-item-title">{item.node.title}</span>
                      <span className="roadmap-item-date">{dateDisplay}</span>
                    </div>
                    {item.node.summary ? (
                      <p className="roadmap-item-summary">{item.node.summary}</p>
                    ) : null}
                    {item.progress.total > 0 ? (
                      <div className="roadmap-progress">
                        <div className="roadmap-progress-bar">
                          <div
                            className="roadmap-progress-fill"
                            style={{ width: `${Math.round(ratio * 100)}%` }}
                          />
                        </div>
                        <span className="roadmap-progress-label">
                          {item.progress.done}/{item.progress.total} subtasks done
                        </span>
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function formatDateDisplay(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  const formatted = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  if (days === 0) return `${formatted} · today`;
  if (days === 1) return `${formatted} · tomorrow`;
  if (days === -1) return `${formatted} · yesterday`;
  if (days > 0 && days <= 14) return `${formatted} · ${days}d`;
  if (days < 0) return `${formatted} · ${Math.abs(days)}d late`;
  return formatted;
}
