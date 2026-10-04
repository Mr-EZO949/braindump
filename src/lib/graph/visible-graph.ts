// What the graph canvas shows and what it hides, as pure functions over the
// loaded graph (moved out of AppShell, 2026-10-04). The shell memoizes them.

import { isLiveEdge } from "@/lib/graph/archive-edges";
import { getEdgeRelationOptionIdForSelection, isEdgeHiddenInUi, type EdgeRelationOptionId } from "@/lib/graph/relationships";
import { NODE_TYPE_INFO, normalizeNodeType } from "@/lib/graph/node-types";
import type { Edge, GraphData, Node, NodeType } from "@/types/graph";

// How long a completed node stays on the graph board before moving to the
// completed shelf (#17: keep the win visible, without months of clutter).
export const RECENT_COMPLETION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isRecentCompletion(node: Node, cutoffMs: number): boolean {
  if (!node.completed_at) return false;
  const completedMs = Date.parse(node.completed_at);
  return Number.isFinite(completedMs) && completedMs >= cutoffMs;
}

// 32-bit FNV-1a over the fields that change what the user would see: node
// identity/status/edit time/deadline/score and edge identity/status. Cheap
// (one pass over a few KB) and collision-safe enough for a cache key.
export function hashGraphContent(nodes: Node[], edges: Edge[]): string {
  let hash = 0x811c9dc5;
  const feed = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const n of nodes) {
    feed(
      `${n.id}|${n.status ?? ""}|${n.updated_at ?? ""}|${n.target_date ?? ""}|${
        n.current_importance_score ?? ""
      };`,
    );
  }
  for (const e of edges) {
    feed(`${e.id}|${e.status ?? ""};`);
  }
  return `${nodes.length}:${edges.length}:${(hash >>> 0).toString(36)}`;
}

export interface VisibleGraphOptions {
  hideCompleted: boolean;
  nodeTypeFilter: string;
  recentCompletionCutoffMs: number;
}

/** A completed node that lives on the shelf, not the board. */
function isShelvedCompletion(node: Node, hideCompleted: boolean, cutoffMs: number): boolean {
  return node.status === "completed" && (hideCompleted || !isRecentCompletion(node, cutoffMs));
}

// Completed nodes that are NOT on the board (all of them when "Hide done" is
// on, otherwise the ones older than the recency window) — the shelf lists these.
export function shelvedCompletedNodes(
  nodes: Node[],
  hideCompleted: boolean,
  recentCompletionCutoffMs: number,
): Node[] {
  return nodes.filter((node) => isShelvedCompletion(node, hideCompleted, recentCompletionCutoffMs));
}

/** The canvas's graph: no archived nodes, no shelved completions, the type filter, live edges between visible nodes. */
export function visibleGraph(graphData: GraphData, options: VisibleGraphOptions): GraphData {
  const nodes = graphData.nodes.filter((node) => {
    // Archived nodes have orphaned edges, so they live in the grouped
    // History shelf rather than floating loose on the canvas.
    if (node.status === "archived") {
      return false;
    }

    // Completed nodes: on the board only while recent (and "Hide done" is off);
    // everything else lives in the Done section of History.
    if (isShelvedCompletion(node, options.hideCompleted, options.recentCompletionCutoffMs)) {
      return false;
    }

    if (options.nodeTypeFilter !== "all" && node.node_type !== options.nodeTypeFilter) {
      return false;
    }

    return true;
  });
  const visibleNodeIds = new Set(nodes.map((node) => node.id));

  return {
    nodes,
    edges: graphData.edges.filter(
      (edge) =>
        !isEdgeHiddenInUi(edge.edge_type) &&
        edge.status !== "orphaned" &&
        visibleNodeIds.has(edge.source_node_id) &&
        visibleNodeIds.has(edge.target_node_id),
    ),
  };
}

export function formatNodeTypeLabel(nodeType: string): string {
  return NODE_TYPE_INFO[normalizeNodeType(nodeType)].label;
}

export interface NodeTypeCount {
  type: NodeType;
  label: string;
  count: number;
}

/** The filter bar's counts: open (not archived, not completed) nodes per type, by label. */
export function countNodeTypes(nodes: Node[]): NodeTypeCount[] {
  const bucket = new Map<string, number>();
  for (const node of nodes) {
    if (node.status === "archived" || node.status === "completed") continue;
    bucket.set(node.node_type, (bucket.get(node.node_type) ?? 0) + 1);
  }
  return Array.from(bucket.entries())
    .map(([type, count]) => ({
      type: type as NodeType,
      label: formatNodeTypeLabel(type),
      count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface NodeConnection {
  edgeId: string;
  nodeId: string;
  nodeType: NodeType;
  relationId: EdgeRelationOptionId;
  title: string;
}

/** The edit sheet's connection list for a node: its visible edges, by linked title. */
export function nodeConnections(
  nodeId: string | null,
  indexes: { incidentEdgesByNode: Map<string, Edge[]>; nodesById: Map<string, Node> },
): NodeConnection[] {
  if (!nodeId) {
    return [];
  }
  return (indexes.incidentEdgesByNode.get(nodeId) ?? [])
    .flatMap((edge) => {
      if (isEdgeHiddenInUi(edge.edge_type)) {
        return [];
      }

      if (edge.source_node_id !== nodeId && edge.target_node_id !== nodeId) {
        return [];
      }

      const linkedNodeId = edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id;
      const linkedNode = indexes.nodesById.get(linkedNodeId);

      if (!linkedNode) {
        return [];
      }

      return [
        {
          edgeId: edge.id,
          nodeId: linkedNode.id,
          nodeType: linkedNode.node_type,
          relationId: getEdgeRelationOptionIdForSelection(edge, nodeId),
          title: linkedNode.title,
        },
      ];
    })
    .sort((connectionA, connectionB) => connectionA.title.localeCompare(connectionB.title));
}

/** Nodes, edges incident to each node, and by id — built once per graph change. */
export function indexIncidentEdges(graphData: GraphData) {
  const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const incidentEdgesByNode = new Map<string, Edge[]>();
  for (const edge of graphData.edges) {
    for (const nodeId of [edge.source_node_id, edge.target_node_id]) {
      const incident = incidentEdgesByNode.get(nodeId) ?? [];
      incident.push(edge);
      incidentEdgesByNode.set(nodeId, incident);
    }
  }
  return { incidentEdgesByNode, nodesById };
}

/**
 * Focus's context line for a step: its parent's title, unless that parent is
 * the workspace root ("in Life" says nothing).
 */
export function parentContextTitle(
  graphData: GraphData,
  nodeId: string,
  rootNodeId: string | null | undefined,
): string | null {
  const parentEdge = graphData.edges.find(
    (edge) => edge.edge_type === "belongs_to" && edge.source_node_id === nodeId && isLiveEdge(edge),
  );
  if (!parentEdge) return null;
  if (parentEdge.target_node_id === rootNodeId) return null;
  return graphData.nodes.find((node) => node.id === parentEdge.target_node_id)?.title ?? null;
}
