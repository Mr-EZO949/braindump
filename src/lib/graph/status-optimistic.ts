// The client's optimistic side of a status change (complete, reopen, archive,
// restore): what changes on the SAME click, how to put it back if the request
// fails, and how the server's answer lands on top (moved out of AppShell,
// 2026-10-04). The server's rules live in status-transition.ts and
// archive-edges.ts; this mirrors them so the graph doesn't wait a round-trip.

import { isLiveEdge, pickEdgesToRestore } from "@/lib/graph/archive-edges";
import type { Edge, GraphData, Node } from "@/types/graph";

type NodeStatusValue = Node["status"];
type EdgeStatusValue = Edge["status"];

export interface StatusChangePlan {
  nodeId: string;
  // What the belongs_to subtree turns into with the clicked node, if anything.
  cascadeStatus: NodeStatusValue | null;
  cascadeIds: string[];
  cascadeIdSet: Set<string>;
  // Status + completed_at of the clicked node and every cascaded one, before.
  affectedSnapshot: Map<string, { status: NodeStatusValue | null; completed_at: string | null }>;
  // Edges an archive orphans / a restore revives, and their statuses before.
  edgeStatusChanges: Map<string, EdgeStatusValue>;
  edgeStatusSnapshot: Map<string, EdgeStatusValue | null>;
}

const isoNow = () => new Date().toISOString();

/** Every belongs_to descendant of `nodeId` (live child edges only) that matches. */
export function belongsToDescendants(
  graphData: GraphData,
  nodeId: string,
  predicate: (n: Node) => boolean,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const edge of graphData.edges) {
    if (edge.edge_type !== "belongs_to") continue;
    if (edge.status === "orphaned" || edge.status === "user_rejected") continue;
    const arr = childrenByParent.get(edge.target_node_id) ?? [];
    arr.push(edge.source_node_id);
    childrenByParent.set(edge.target_node_id, arr);
  }
  const nodeById = new Map(graphData.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const visited = new Set<string>();
  const stack = [...(childrenByParent.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const node = nodeById.get(id);
    if (node && predicate(node)) out.push(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!visited.has(childId)) stack.push(childId);
    }
  }
  return out;
}

export function planStatusChange(graphData: GraphData, previousNode: Node, status: NodeStatusValue): StatusChangePlan {
  const nodeId = previousNode.id;
  // Client mirror of the server's belongs_to cascade so the whole subtree
  // completes/uncompletes on the SAME click instead of waiting for the
  // round-trip. Anything the server doesn't confirm is rolled back when the
  // response lands (mergeServerStatus).
  const cascadeStatus: NodeStatusValue | null =
    status === "completed"
      ? "completed"
      : status === "active" && previousNode.status === "completed"
        ? "active"
        : null;
  const cascadeIds =
    cascadeStatus === "completed"
      ? belongsToDescendants(graphData, nodeId, (n) => n.status !== "completed" && n.status !== "archived")
      : cascadeStatus === "active"
        ? belongsToDescendants(graphData, nodeId, (n) => n.status === "completed")
        : [];
  const cascadeIdSet = new Set(cascadeIds);
  const affectedSnapshot = new Map(
    graphData.nodes
      .filter((n) => n.id === nodeId || cascadeIdSet.has(n.id))
      .map((n) => [n.id, { status: n.status ?? null, completed_at: n.completed_at ?? null }] as const),
  );

  // Edges only change on archive / unarchive, by the server's own rules
  // (archive-edges.ts). Snapshot them so a failed request can put them back.
  const touchingEdges = graphData.edges.filter((e) => e.source_node_id === nodeId || e.target_node_id === nodeId);
  const edgeStatusChanges = new Map<string, EdgeStatusValue>();
  if (status === "archived") {
    for (const e of touchingEdges) if (isLiveEdge(e)) edgeStatusChanges.set(e.id, "orphaned");
  } else if (previousNode.status === "archived") {
    const restoreIds = pickEdgesToRestore({
      nodeId,
      edges: touchingEdges,
      statusByNodeId: new Map(graphData.nodes.map((n) => [n.id, n.status])),
      parentedNodeIds: new Set(
        graphData.edges.filter((e) => e.edge_type === "belongs_to" && isLiveEdge(e)).map((e) => e.source_node_id),
      ),
    });
    for (const id of restoreIds) edgeStatusChanges.set(id, "active");
  }
  const edgeStatusSnapshot = new Map(
    touchingEdges.filter((e) => edgeStatusChanges.has(e.id)).map((e) => [e.id, e.status ?? null]),
  );

  return { nodeId, cascadeStatus, cascadeIds, cascadeIdSet, affectedSnapshot, edgeStatusChanges, edgeStatusSnapshot };
}

/** The clicked node takes `targetStatus`; the listed edges take theirs. */
export function applyStatusLocally(
  prev: GraphData,
  nodeId: string,
  targetStatus: NodeStatusValue,
  edgeStatuses: ReadonlyMap<string, EdgeStatusValue>,
  now: () => string = isoNow,
): GraphData {
  return {
    ...prev,
    nodes: prev.nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            status: targetStatus,
            completed_at: targetStatus === "completed" ? now() : n.completed_at,
          }
        : n,
    ),
    edges:
      edgeStatuses.size === 0
        ? prev.edges
        : prev.edges.map((e) => (edgeStatuses.has(e.id) ? { ...e, status: edgeStatuses.get(e.id) } : e)),
  };
}

/** What the click shows at once: the node, its subtree and its edges. */
export function applyOptimisticStatus(
  prev: GraphData,
  plan: StatusChangePlan,
  status: NodeStatusValue,
  now: () => string = isoNow,
): GraphData {
  const base = applyStatusLocally(prev, plan.nodeId, status, plan.edgeStatusChanges, now);
  if (!plan.cascadeStatus || plan.cascadeIds.length === 0) return base;
  const cascadeCompletedAt = plan.cascadeStatus === "completed" ? now() : null;
  return {
    ...base,
    nodes: base.nodes.map((n) =>
      plan.cascadeIdSet.has(n.id) ? { ...n, status: plan.cascadeStatus, completed_at: cascadeCompletedAt } : n,
    ),
  };
}

/** A failed request: the clicked node, its edges and every cascaded descendant as they were. */
export function revertOptimisticStatus(
  prev: GraphData,
  plan: StatusChangePlan,
  previousStatus: NodeStatusValue,
  now: () => string = isoNow,
): GraphData {
  const reverted = applyStatusLocally(prev, plan.nodeId, previousStatus, plan.edgeStatusSnapshot, now);
  if (plan.affectedSnapshot.size === 0) return reverted;
  return {
    ...reverted,
    nodes: reverted.nodes.map((n) => {
      const snap = plan.affectedSnapshot.get(n.id);
      return snap ? { ...n, status: snap.status, completed_at: snap.completed_at } : n;
    }),
  };
}

export interface StatusResponse {
  updated_node?: Node | null;
  updated_nodes?: Node[];
  auto_completed_node_ids?: string[];
  auto_reopened_node_ids?: string[];
  recomputed_scores?: Array<{ id: string; current_importance_score: number; importance_index: number; importance: string }>;
  updated_task_ids?: string[];
}

/** The server's answer on top of the optimistic graph: its rows, its cascade, new scores; unconfirmed cascades roll back. */
export function mergeServerStatus(
  prev: GraphData,
  plan: StatusChangePlan,
  data: StatusResponse,
  nowIso: string,
): GraphData {
  const nodeId = plan.nodeId;
  const updatedNode = data.updated_node ?? null;
  const updatedNodeMap = new Map((data.updated_nodes ?? []).map((updated) => [updated.id, updated]));
  // Cascaded belongs_to descendants: completing a parent auto-completes its
  // whole subtree server-side. Apply their status explicitly so the children
  // vanish (hideCompleted) in the same frame.
  const autoCompletedIds = new Set(data.auto_completed_node_ids ?? []);
  const autoReopenedIds = new Set(data.auto_reopened_node_ids ?? []);
  const scoreMap = new Map((data.recomputed_scores ?? []).map((s) => [s.id, s]));

  return {
    ...prev,
    nodes: prev.nodes.map((n) => {
      const nextNodeState = updatedNodeMap.get(n.id) ?? (n.id === nodeId ? updatedNode : null);
      const scoreUpdate = scoreMap.get(n.id);
      const serverCascadeStatus: NodeStatusValue | null = autoCompletedIds.has(n.id)
        ? "completed"
        : autoReopenedIds.has(n.id)
          ? "active"
          : null;
      // We optimistically cascaded this node but the server didn't confirm it
      // (e.g. a child completed independently of this parent) — roll it back.
      const rollback =
        plan.cascadeIdSet.has(n.id) && !serverCascadeStatus && !updatedNodeMap.has(n.id) && n.id !== nodeId
          ? plan.affectedSnapshot.get(n.id)
          : undefined;

      if (!nextNodeState && !scoreUpdate && !serverCascadeStatus && !rollback) {
        return n;
      }

      return {
        ...n,
        ...(nextNodeState ?? {}),
        ...(serverCascadeStatus && !nextNodeState
          ? {
              status: serverCascadeStatus,
              completed_at: serverCascadeStatus === "completed" ? nowIso : null,
            }
          : {}),
        ...(rollback ? { status: rollback.status, completed_at: rollback.completed_at } : {}),
        ...(scoreUpdate
          ? {
              current_importance_score: scoreUpdate.current_importance_score,
              importance_index: scoreUpdate.importance_index,
              importance: scoreUpdate.importance as Node["importance"],
            }
          : {}),
      };
    }),
  };
}
