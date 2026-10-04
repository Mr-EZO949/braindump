// A planner entry on a bigger thing — a class, goal or project, or a big task
// that has steps — is a block of TIME on it ("Italian Crash Course — 2h",
// lib/ai/planner.ts time blocks). Ticking it marks the session done; it never
// completes the node. A task, a habit, or a big task with no steps (one
// sitting finishes it) completes its node as before.

const SESSION_TYPES = new Set(["class", "goal", "project", "area", "idea", "note"]);

export function planTaskCompletesNode(nodeType: string | null | undefined, hasOpenSteps: boolean): boolean {
  if (!nodeType) return true;
  if (SESSION_TYPES.has(nodeType)) return false;
  if (nodeType === "big_task") return !hasOpenSteps;
  return true;
}

/** Does this node have an open (not completed / archived) child in the graph? */
export function hasOpenSteps(
  nodeId: string,
  graph: {
    nodes: Array<{ id: string; status?: string | null }>;
    edges: Array<{ source_node_id: string; target_node_id: string; edge_type: string; status?: string | null }>;
  },
): boolean {
  const open = new Set(
    graph.nodes
      .filter((n) => (n.status ?? "active") !== "completed" && (n.status ?? "active") !== "archived")
      .map((n) => n.id),
  );
  return graph.edges.some(
    (e) =>
      e.edge_type === "belongs_to" &&
      e.target_node_id === nodeId &&
      open.has(e.source_node_id) &&
      e.status !== "orphaned" &&
      e.status !== "user_rejected",
  );
}
