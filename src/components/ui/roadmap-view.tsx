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

// Urgency tier for an item, used both for the rail dot and the card accent.
type RiskTier = "overdue" | "soon" | "ontrack" | "done";

function riskFor(days: number, completed: boolean): RiskTier {
  if (completed) return "done";
  if (days < 0) return "overdue";
  if (days <= 7) return "soon";
  return "ontrack";
}

// The loud, color-coded countdown that leads each roadmap card. `num` is the
// big figure, `word` the small caption under it.
function countdownFor(days: number, completed: boolean): { num: string; word: string } {
  if (completed) return { num: "✓", word: "done" };
  if (days < 0) return { num: `${Math.abs(days)}d`, word: "late" };
  if (days === 0) return { num: "today", word: "" };
  if (days <= 14) return { num: `${days}d`, word: "left" };
  if (days <= 90) return { num: `${Math.ceil(days / 7)}w`, word: "left" };
  return { num: `${Math.round(days / 30)}mo`, word: "left" };
}

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
        <div className="roadmap-empty-preview" aria-hidden="true">
          <span className="roadmap-empty-bar" data-fill="long" />
          <span className="roadmap-empty-bar" data-fill="mid" />
          <span className="roadmap-empty-bar" data-fill="short" />
        </div>
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
      {buckets.map((bucket) => {
        // Aggregate completion for the bucket header: each item's own status,
        // bucket length as the total. Mirrors the per-card progress signal at
        // the group level so each month reads as a single at-a-glance ratio.
        const bucketDone = bucket.items.filter(
          (it) => it.node.status === "completed",
        ).length;
        const bucketTotal = bucket.items.length;
        const bucketRatio = bucketTotal > 0 ? bucketDone / bucketTotal : 0;
        return (
        <section
          className="roadmap-bucket"
          key={bucket.key}
          data-overdue={bucket.key === "0000-overdue"}
          data-completed={bucket.key === "9999-done"}
        >
          <header className="roadmap-bucket-header">
            <h3 className="roadmap-bucket-label">{bucket.label}</h3>
            <span className="roadmap-bucket-count">{bucket.items.length}</span>
            <div className="roadmap-bucket-progress">
              <div
                className="roadmap-progress-bar"
                data-state={
                  bucketRatio >= 1 ? "done" : bucketRatio === 0 ? "empty" : "partial"
                }
              >
                <div
                  className="roadmap-progress-fill"
                  style={{ width: `${Math.round(bucketRatio * 100)}%` }}
                />
              </div>
              <span className="roadmap-bucket-progress-label">
                {bucketDone}/{bucketTotal}
              </span>
            </div>
          </header>
          <ol className="roadmap-bucket-list">
            {bucket.items.map((item) => {
              const date = item.node.target_date as string;
              const days = item.daysFromNow;
              const ratio = item.progress.total > 0 ? item.progress.done / item.progress.total : 0;
              const completed = item.node.status === "completed";
              const overdue = !completed && days < 0;
              const risk = riskFor(days, completed);
              const countdown = countdownFor(days, completed);
              return (
                <li key={item.node.id}>
                  <button
                    type="button"
                    className="roadmap-item"
                    data-overdue={overdue || undefined}
                    data-completed={completed || undefined}
                    data-risk={risk}
                    data-type={item.node.node_type}
                    onClick={() => onSelectNode(item.node.id)}
                  >
                    <span className="roadmap-deadline" data-risk={risk} aria-hidden="true">
                      <span className="roadmap-deadline-num">{countdown.num}</span>
                      {countdown.word ? (
                        <span className="roadmap-deadline-word">{countdown.word}</span>
                      ) : null}
                      <span className="roadmap-deadline-date">{shortDate(date)}</span>
                    </span>
                    <span className="roadmap-item-body">
                      <div className="roadmap-item-head">
                        <span className="roadmap-item-type">{item.node.node_type}</span>
                        <span className="roadmap-item-title">{item.node.title}</span>
                      </div>
                      {item.node.summary ? (
                        <p className="roadmap-item-summary">{item.node.summary}</p>
                      ) : null}
                      {item.progress.total > 0 ? (
                        <div className="roadmap-progress">
                          <div
                            className="roadmap-progress-bar"
                            data-state={ratio >= 1 ? "done" : ratio === 0 ? "empty" : "partial"}
                          >
                            <div
                              className="roadmap-progress-fill"
                              style={{ width: `${Math.round(ratio * 100)}%` }}
                            />
                          </div>
                          <span className="roadmap-progress-label">
                            <span className="roadmap-progress-pct">{Math.round(ratio * 100)}%</span>
                            <span className="roadmap-progress-fraction">
                              {item.progress.done}/{item.progress.total} done
                            </span>
                          </span>
                        </div>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
        );
      })}
    </div>
  );
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
