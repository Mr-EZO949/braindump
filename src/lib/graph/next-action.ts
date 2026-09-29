// Dead-end detection for the Focus flow.
//
// When Focus surfaces a container node (big task / project / class / goal) that has no
// actionable child, focusing on it dead-ends the user — there's nothing
// concrete to do. The caller uses this to fire ONE light next-action
// suggestion at that moment (demand-driven, only when the user actually picks
// the node in Focus), rather than auto-generating on every project creation.

import type { Edge, Node, NodeType } from "@/types/graph";

// Node types that hold sub-work and can be "empty". A big task with no steps
// is the main case: Focus offers to break it down instead of dead-ending.
const CONTAINER_TYPES = new Set<NodeType>(["big_task", "project", "class", "goal"]);
// Child types that count as a real next step. A note/idea child doesn't
// make a project actionable; a task/big task/sub-project/sub-goal does.
const WORKABLE_TYPES = new Set<NodeType>(["task", "big_task", "project", "goal"]);

// "paused" counts as live on purpose: if every task under a project is paused,
// the user has explicitly parked them — re-suggesting work would nag, not help.
// So a paused child suppresses the next-action offer.
function isLive(status: Node["status"]): boolean {
  const s = status ?? "active";
  return s !== "completed" && s !== "archived";
}

/**
 * True if `nodeId` is a live container with no actionable child — i.e. Focus
 * pointing at it would leave the user with nothing to do. Pure: the caller
 * passes the current graph.
 */
export function needsNextAction(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
): boolean {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || !CONTAINER_TYPES.has(node.node_type)) return false;
  if (!isLive(node.status)) return false; // a finished container needs nothing

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIds = new Set<string>();
  for (const e of edges) {
    // belongs_to is child → parent; a child of `nodeId` points at it as target.
    if (e.edge_type === "belongs_to" && e.target_node_id === nodeId) {
      childIds.add(e.source_node_id);
    }
  }

  for (const cid of childIds) {
    const child = byId.get(cid);
    if (child && WORKABLE_TYPES.has(child.node_type) && isLive(child.status)) {
      return false; // has a real next step already
    }
  }
  return true;
}
