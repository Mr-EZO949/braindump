// Which edges an archive takes down and which ones a restore brings back.
// Shared by the server (status-transition.ts) and the client's optimistic
// update (app-shell handleStatusChange) so both agree.
//
// Archiving orphans a node's live edges. Restoring cannot simply revive every
// orphaned edge that touches the node: a move (hierarchy.ts setNodeParent)
// leaves the OLD parent edge orphaned too, so a moved-then-archived node has
// two orphaned belongs_to edges. Reviving both breaks the one-parent rule —
// the DB's unique index (idx_edges_single_parent) then rejects the whole
// update and the node comes back with no edges at all.

export type ArchiveEdge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  status?: string | null;
  created_at?: string | null;
};

/** Live = takes part in the graph (not orphaned, not rejected by the user). */
export function isLiveEdge(edge: Pick<ArchiveEdge, "status">): boolean {
  return edge.status !== "orphaned" && edge.status !== "user_rejected";
}

// The edge statuses an archive turns into "orphaned". Rejected edges stay
// rejected (a restore must not revive them); already-orphaned ones keep theirs.
export const ARCHIVE_ORPHANS_STATUSES = ["active", "decayed"] as const;

function newestFirst(a: ArchiveEdge, b: ArchiveEdge): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

/**
 * The parent a node had when it was archived: its live belongs_to edge if it
 * still has one, else the newest orphaned one (a move inserts a new edge and
 * orphans the old, so the newest is the latest parent).
 */
export function formerParentEdge<E extends ArchiveEdge>(nodeId: string, edges: readonly E[]): E | null {
  const own = edges.filter(
    (edge) =>
      edge.edge_type === "belongs_to" &&
      edge.source_node_id === nodeId &&
      edge.status !== "user_rejected",
  );
  return own.find(isLiveEdge) ?? [...own].sort(newestFirst)[0] ?? null;
}

/**
 * The orphaned edges to revive when `nodeId` is restored from the archive.
 *
 * - Never an edge to a node that is still archived (or unknown).
 * - The node's own parent: only the newest orphaned belongs_to, and none if
 *   it already has a live parent.
 * - Its children: only those that haven't been given another parent since.
 */
export function pickEdgesToRestore(params: {
  nodeId: string;
  /** Every edge touching the node, any status. */
  edges: readonly ArchiveEdge[];
  /** Status of every node at the other end of those edges. */
  statusByNodeId: ReadonlyMap<string, string | null | undefined>;
  /** Nodes other than `nodeId` that already have a live parent. */
  parentedNodeIds: ReadonlySet<string>;
}): string[] {
  const { nodeId, edges, statusByNodeId, parentedNodeIds } = params;
  const otherEnd = (edge: ArchiveEdge) =>
    edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id;
  const candidates = edges
    .filter((edge) => edge.status === "orphaned")
    .filter((edge) => edge.source_node_id !== edge.target_node_id)
    .filter((edge) => {
      if (!statusByNodeId.has(otherEnd(edge))) return false;
      return statusByNodeId.get(otherEnd(edge)) !== "archived";
    })
    .sort(newestFirst);

  const hasLiveParent = edges.some(
    (edge) => edge.edge_type === "belongs_to" && edge.source_node_id === nodeId && isLiveEdge(edge),
  );
  const restored: string[] = [];
  const parentedNow = new Set(parentedNodeIds);
  let ownParentRestored = hasLiveParent;

  for (const edge of candidates) {
    if (edge.edge_type !== "belongs_to") {
      restored.push(edge.id);
      continue;
    }
    if (edge.source_node_id === nodeId) {
      if (ownParentRestored) continue;
      ownParentRestored = true;
      restored.push(edge.id);
      continue;
    }
    // A child of the restored node.
    if (parentedNow.has(edge.source_node_id)) continue;
    parentedNow.add(edge.source_node_id);
    restored.push(edge.id);
  }
  return restored;
}
