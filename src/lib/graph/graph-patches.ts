// Small, pure updates the shell applies to its loaded graph after a server
// answer: accepted proposals placed near the view, accepted links, a merge,
// and which accepted items to offer steps for (moved out of AppShell, 2026-10-04).

import type { Edge, GraphData, Node } from "@/types/graph";

export interface CameraLike {
  zoom: number;
  panX: number;
  panY: number;
}

// Graph units between nodes placed in a grid.
const SPACING = 220;

/**
 * Accepted nodes, positioned: one with a parent in `acceptedEdges` (belongs_to
 * / required_for) loses any stored position so the tree layout places it; the
 * rest sit in a grid around the viewport centre. `stored` says, in node order,
 * which local position to drop (null) or save.
 */
export function placeAcceptedNodes(
  nodes: Node[],
  acceptedEdges: Edge[],
  camera: CameraLike | null,
): { positioned: Node[]; stored: Array<{ nodeId: string; position: { x: number; y: number } | null }> } {
  const attachedNodeIds = new Set(
    acceptedEdges
      .filter((edge) => edge.edge_type === "belongs_to" || edge.edge_type === "required_for")
      .map((edge) => edge.source_node_id),
  );

  // Viewport center in graph coords = (-panX/zoom, -panY/zoom).
  const zoom = camera?.zoom ?? 1;
  const panX = camera?.panX ?? 0;
  const panY = camera?.panY ?? 0;
  const cx = -panX / zoom;
  const cy = -panY / zoom;

  const unattachedNodes = nodes.filter((node) => !attachedNodeIds.has(node.id));
  const cols = Math.max(1, Math.ceil(Math.sqrt(unattachedNodes.length || 1)));
  const startX = cx - ((cols - 1) * SPACING) / 2;
  const startY = cy - ((Math.ceil((unattachedNodes.length || 1) / cols) - 1) * SPACING) / 2;
  let unattachedIndex = 0;

  const stored: Array<{ nodeId: string; position: { x: number; y: number } | null }> = [];
  const positioned = nodes.map((node) => {
    if (attachedNodeIds.has(node.id)) {
      stored.push({ nodeId: node.id, position: null });
      return { ...node, manual_position: false, position_x: null, position_y: null };
    }

    const col = unattachedIndex % cols;
    const row = Math.floor(unattachedIndex / cols);
    unattachedIndex += 1;

    const px = Math.round(startX + col * SPACING);
    const py = Math.round(startY + row * SPACING);
    stored.push({ nodeId: node.id, position: { x: px, y: py } });
    return { ...node, position_x: px, position_y: py, manual_position: true };
  });

  return { positioned, stored };
}

/**
 * Accepted goals / projects / big tasks / habits with nothing under them yet
 * (in the graph or the accepted edges) — the ones worth breaking into steps.
 */
export function stepCandidates(acceptedNodes: Node[], graphEdges: Edge[], acceptedEdges: Edge[]): Node[] {
  const parentIds = new Set<string>();
  for (const edge of [...graphEdges, ...acceptedEdges]) {
    if (edge.edge_type === "belongs_to") {
      parentIds.add(edge.target_node_id);
    }
  }
  return acceptedNodes.filter(
    (n) =>
      (n.node_type === "goal" || n.node_type === "project" || n.node_type === "big_task" || n.node_type === "habit") &&
      !parentIds.has(n.id),
  );
}

/**
 * Links accepted in review: added, with the nodes the server updated; new
 * edges also clear stored positions so the tree layout reorganizes.
 */
export function withReviewedEdges(prev: GraphData, newEdges: Edge[], updatedNodes: ReadonlyMap<string, Node>): GraphData {
  if (newEdges.length > 0) {
    return {
      ...prev,
      edges: [...prev.edges, ...newEdges],
      nodes: prev.nodes.map((n) => ({
        ...n,
        ...(updatedNodes.get(n.id) ?? {}),
        manual_position: false,
        position_x: null,
        position_y: null,
      })),
    };
  }
  return {
    ...prev,
    nodes: prev.nodes.map((node) => ({
      ...node,
      ...(updatedNodes.get(node.id) ?? {}),
    })),
  };
}

export interface ScoreUpdate {
  id: string;
  current_importance_score: number;
  importance_index: number;
  importance: string;
}

/** A merge: the archived duplicate and its edges leave the graph; new scores land. */
export function withMergedNode(
  prev: GraphData,
  archivedNodeId: string | undefined,
  scores: ScoreUpdate[] | undefined,
): GraphData {
  const scoreMap = new Map((scores ?? []).map((s) => [s.id, s]));
  return {
    ...prev,
    nodes: prev.nodes
      .filter((n) => n.id !== archivedNodeId)
      .map((n) => {
        const scoreUpdate = scoreMap.get(n.id);
        return scoreUpdate
          ? {
              ...n,
              current_importance_score: scoreUpdate.current_importance_score,
              importance_index: scoreUpdate.importance_index,
              importance: scoreUpdate.importance as Node["importance"],
            }
          : n;
      }),
    edges: prev.edges.filter((e) => e.source_node_id !== archivedNodeId && e.target_node_id !== archivedNodeId),
  };
}

/** Nodes removed (an Undo), with every edge that touched them. */
export function withoutNodes(prev: GraphData, removedIds: ReadonlySet<string>): GraphData {
  return {
    ...prev,
    nodes: prev.nodes.filter((n) => !removedIds.has(n.id)),
    edges: prev.edges.filter((e) => !removedIds.has(e.source_node_id) && !removedIds.has(e.target_node_id)),
  };
}

/** New scores from the server (a rescore): node sizes and reasons follow. */
export function withScores(
  prev: GraphData,
  scores: ReadonlyArray<ScoreUpdate & { importance_reason?: string | null }>,
): GraphData {
  if (scores.length === 0) return prev;
  const scoreMap = new Map(scores.map((s) => [s.id, s]));
  return {
    ...prev,
    nodes: prev.nodes.map((n) => {
      const s = scoreMap.get(n.id);
      if (!s) return n;
      return {
        ...n,
        current_importance_score: s.current_importance_score,
        importance_index: s.importance_index,
        importance: s.importance as Node["importance"],
        ...(s.importance_reason !== undefined ? { importance_reason: s.importance_reason } : {}),
      };
    }),
  };
}
