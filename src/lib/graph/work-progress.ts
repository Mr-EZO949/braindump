// How much of each big task / project is done: its direct work children
// (belongs_to, not archived), counted from the FULL graph — the canvas hides
// completed nodes by default, but a finished step still counts.

import type { GraphData, NodeType } from "@/types/graph";

import { CHECKABLE_TYPES } from "./node-types";

export type WorkProgress = { done: number; total: number };

const PROGRESS_PARENTS: ReadonlySet<NodeType> = new Set(["big_task", "project"]);

export function computeWorkProgress(graph: GraphData): Map<string, WorkProgress> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const progress = new Map<string, WorkProgress>();
  for (const edge of graph.edges) {
    // belongs_to is child → parent.
    if (edge.edge_type !== "belongs_to" || (edge.status ?? "active") === "user_rejected") continue;
    const parent = byId.get(edge.target_node_id);
    const child = byId.get(edge.source_node_id);
    if (!parent || !child || !PROGRESS_PARENTS.has(parent.node_type)) continue;
    if (child.status === "archived") continue;
    if (!CHECKABLE_TYPES.has(child.node_type) && child.node_type !== "project") continue;
    const entry = progress.get(parent.id) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (child.status === "completed") entry.done += 1;
    progress.set(parent.id, entry);
  }
  return progress;
}
