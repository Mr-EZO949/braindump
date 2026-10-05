import { getImportanceIndex } from "@/lib/graph/importance";
import {
  getEdgeRelationOptionIdForSelection,
  type EdgeRelationOptionId,
} from "@/lib/graph/relationships";
import { isReversedEdgeType, normalizeEdge, normalizeEdgeType, type LinkKind } from "@/lib/graph/edge-types";
import type { ChatNodeContext } from "@/types/chat";
import type { Edge, EdgeType, GraphData, Node } from "@/types/graph";

export interface LinkedNodePerspective {
  edgeTypes: EdgeType[];
  labels: string[];
  node: Node;
  priority: number;
}

export interface NodeConnection {
  edge: Edge;
  label: string;
  node: Node;
  priority: number;
  relationId: EdgeRelationOptionId;
}

export interface FocusItem {
  detail: string;
  id: string;
  nodeId: string | null;
  priority: number;
  title: string;
}

type Perspective = "source" | "target";

// ─── Relationship-priority calibration ───────────────────────────────────
//
// All tunables for "how important is a related node" live here. The numbers
// encode product intent ("hard dependencies outrank structural children
// outrank loose associations"), not historical tuning. To re-tune: change a
// number HERE, not in arithmetic somewhere downstream.

/**
 * Per-edge-type base priority when ranking linked nodes. The ordering matters
 * more than the exact values — three semantic tiers:
 *
 *   STRUCTURAL (95–98) — hard dependencies and explicit blockers
 *   HIERARCHICAL (90) — parent/child via belongs_to
 *   SUPPORTIVE (~70) — soft "helps with" relationships
 *   ASSOCIATIVE (30–60) — loose "related to" / "inspired by" links
 *
 * Legacy stored types read as their kind (lib/graph/edge-types.ts).
 */
const RELATIONSHIP_PRIORITY: Record<LinkKind, number> = {
  required_for: 98,
  belongs_to: 90,
  supports: 70,
  related_to: 30,
};

/**
 * When two related nodes share the same tier, their importance scores break
 * the tie. The bonus is intentionally small (0–8 points on a 100-point
 * importance) so it never lets a low-tier high-importance node leapfrog a
 * higher-tier node — it only orders within a tier.
 */
const IMPORTANCE_BONUS_DEFAULT = 0.08;
/**
 * Auxiliary version for "supports" relationships in the focus picker
 * (`getFocusItems`). A high-importance support shouldn't outrank a child —
 * importance matters less when the relationship is auxiliary, so we use a
 * gentler multiplier (≈ 5 points max instead of 8).
 */
const IMPORTANCE_BONUS_AUXILIARY = 0.05;

/**
 * Focus-picker priority bases. These are separate from RELATIONSHIP_PRIORITY
 * because the focus picker has different intent: "what should I do next?",
 * which weights direct-children differently from the general "what's
 * related?" view.
 *
 *   HARD_PREREQ outranks every child type (you can't act on a child until
 *   the prereq clears).
 *
 *   CHILD_BY_TYPE orders by how *actionable* the child is — tasks first,
 *   then big tasks and projects, then containers (class), with everything
 *   else (area, note, idea) as the fallback.
 *
 *   SUPPORT comes last because supports are auxiliary by definition.
 */
const FOCUS_PRIORITY = {
  HARD_PREREQ: 100,
  CHILD_BY_TYPE: {
    task: 82,
    big_task: 78,
    project: 74,
    class: 66,
    other: 60,
  },
  SUPPORT: 58,
} as const;

// Static design invariants. Caught at module load if a future tuner inverts
// the ordering by accident.
if (RELATIONSHIP_PRIORITY.required_for <= RELATIONSHIP_PRIORITY.belongs_to) {
  throw new Error(
    "[insights] required_for must outrank belongs_to — dependencies are more urgent than hierarchy",
  );
}
if (RELATIONSHIP_PRIORITY.belongs_to <= RELATIONSHIP_PRIORITY.supports) {
  throw new Error("[insights] belongs_to must outrank supports");
}
if (RELATIONSHIP_PRIORITY.supports <= RELATIONSHIP_PRIORITY.related_to) {
  throw new Error("[insights] supports must outrank related_to");
}
if (
  FOCUS_PRIORITY.HARD_PREREQ <=
  Math.max(...Object.values(FOCUS_PRIORITY.CHILD_BY_TYPE))
) {
  throw new Error("[insights] HARD_PREREQ must outrank every child type");
}

// ─── Priority calculation helpers ────────────────────────────────────────
//
// Each helper computes the priority for one situation. Splitting them out
// lets callers read intention, not arithmetic, and makes each piece testable
// in isolation.

/**
 * Priority for ranking a node related to the selected node (used by
 * `getLinkedNodePerspectives` + `getNodeConnections`).
 */
export function calculateLinkedNodePriority(
  edgeType: EdgeType,
  linkedNode: Node,
): number {
  return (
    RELATIONSHIP_PRIORITY[normalizeEdgeType(edgeType)] +
    Math.round(getImportanceIndex(linkedNode) * IMPORTANCE_BONUS_DEFAULT)
  );
}

/** Focus-picker priority for a direct child (belongs_to target). */
function calculateChildFocusPriority(linkedNode: Node): number {
  const base =
    FOCUS_PRIORITY.CHILD_BY_TYPE[
      linkedNode.node_type as keyof typeof FOCUS_PRIORITY.CHILD_BY_TYPE
    ] ?? FOCUS_PRIORITY.CHILD_BY_TYPE.other;
  return (
    base + Math.round(getImportanceIndex(linkedNode) * IMPORTANCE_BONUS_DEFAULT)
  );
}

/** Focus-picker priority for a supports edge — gentler importance bonus. */
function calculateSupportFocusPriority(linkedNode: Node): number {
  return (
    FOCUS_PRIORITY.SUPPORT +
    Math.round(getImportanceIndex(linkedNode) * IMPORTANCE_BONUS_AUXILIARY)
  );
}

function getPerspectiveForNode(edge: Edge, nodeId: string): Perspective {
  return edge.source_node_id === nodeId ? "source" : "target";
}

export function getDirectionalRelationshipLabel(
  edgeType: EdgeType,
  perspective: Perspective,
): string {
  // `depends_on` is stored from the other end; read it as its kind.
  const fromSource =
    isReversedEdgeType(edgeType) ? perspective === "target" : perspective === "source";
  switch (normalizeEdgeType(edgeType)) {
    case "belongs_to":
      return fromSource ? "belongs to" : "contains";
    case "required_for":
      return fromSource ? "needed for" : "needs";
    case "supports":
      return fromSource ? "helps" : "helped by";
    case "related_to":
      return "related to";
  }
}

export function getLinkedNodePerspectives(
  graphData: GraphData,
  selectedNodeId: string | null,
): LinkedNodePerspective[] {
  if (!selectedNodeId) {
    return [];
  }

  const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const grouped = new Map<
    string,
    {
      edgeTypes: Set<EdgeType>;
      labels: Set<string>;
      node: Node;
      priority: number;
    }
  >();

  graphData.edges.map(normalizeEdge).forEach((edge) => {

    if (edge.source_node_id !== selectedNodeId && edge.target_node_id !== selectedNodeId) {
      return;
    }

    const perspective = getPerspectiveForNode(edge, selectedNodeId);
    const linkedNodeId =
      perspective === "source" ? edge.target_node_id : edge.source_node_id;
    const linkedNode = nodesById.get(linkedNodeId);

    if (!linkedNode) {
      return;
    }

    const existing = grouped.get(linkedNodeId);
    const label = getDirectionalRelationshipLabel(edge.edge_type, perspective);
    const priority = calculateLinkedNodePriority(edge.edge_type, linkedNode);

    if (existing) {
      existing.edgeTypes.add(edge.edge_type);
      existing.labels.add(label);
      existing.priority = Math.max(existing.priority, priority);
      return;
    }

    grouped.set(linkedNodeId, {
      edgeTypes: new Set([edge.edge_type]),
      labels: new Set([label]),
      node: linkedNode,
      priority,
    });
  });

  return Array.from(grouped.values())
    .map((entry) => ({
      edgeTypes: Array.from(entry.edgeTypes),
      labels: Array.from(entry.labels),
      node: entry.node,
      priority: entry.priority,
    }))
    .sort((entryA, entryB) => {
      return entryB.priority - entryA.priority || entryA.node.title.localeCompare(entryB.node.title);
    });
}

export function getNodeConnections(
  graphData: GraphData,
  selectedNodeId: string | null,
): NodeConnection[] {
  if (!selectedNodeId) {
    return [];
  }

  const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));

  return graphData.edges
    .map(normalizeEdge)
    .flatMap((edge) => {

      if (edge.source_node_id !== selectedNodeId && edge.target_node_id !== selectedNodeId) {
        return [];
      }

      const perspective = getPerspectiveForNode(edge, selectedNodeId);
      const linkedNodeId =
        perspective === "source" ? edge.target_node_id : edge.source_node_id;
      const linkedNode = nodesById.get(linkedNodeId);

      if (!linkedNode) {
        return [];
      }

      return [
        {
          edge,
          label: getDirectionalRelationshipLabel(edge.edge_type, perspective),
          node: linkedNode,
          priority: calculateLinkedNodePriority(edge.edge_type, linkedNode),
          relationId: getEdgeRelationOptionIdForSelection(edge, selectedNodeId),
        },
      ];
    })
    .sort((connectionA, connectionB) => {
      return (
        connectionB.priority - connectionA.priority ||
        connectionA.node.title.localeCompare(connectionB.node.title)
      );
    });
}

function createFocusItem(
  id: string,
  title: string,
  detail: string,
  nodeId: string | null,
  priority: number,
): FocusItem {
  return {
    detail,
    id,
    nodeId,
    priority,
    title,
  };
}

function upsertFocusItem(grouped: Map<string, FocusItem>, item: FocusItem) {
  const existing = grouped.get(item.nodeId ?? item.id);

  if (!existing || item.priority > existing.priority) {
    grouped.set(item.nodeId ?? item.id, item);
  }
}

function allowsFocusPlan(node: ChatNodeContext) {
  return ["goal", "project", "big_task", "area", "class", "habit"].includes(node.node_type);
}

function createChildActionTitle(node: Node) {
  switch (node.node_type) {
    case "task":
      return `Complete ${node.title}`;
    case "big_task":
      return `Take the next step on ${node.title}`;
    case "project":
      return `Advance ${node.title}`;
    case "class":
      return `Review ${node.title}`;
    case "goal":
      return `Clarify ${node.title}`;
    case "habit":
      return `Practice ${node.title}`;
    default:
      return `Develop ${node.title}`;
  }
}

export function getFocusItems(
  graphData: GraphData,
  selectedNode: ChatNodeContext | null,
): FocusItem[] {
  if (!selectedNode || !allowsFocusPlan(selectedNode)) {
    return [];
  }

  const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, FocusItem>();

  graphData.edges.map(normalizeEdge).forEach((edge) => {

    if (edge.source_node_id !== selectedNode.id && edge.target_node_id !== selectedNode.id) {
      return;
    }

    const perspective = getPerspectiveForNode(edge, selectedNode.id);
    const linkedNodeId =
      perspective === "source" ? edge.target_node_id : edge.source_node_id;
    const linkedNode = nodesById.get(linkedNodeId);

    if (!linkedNode) {
      return;
    }

    switch (edge.edge_type) {
      case "required_for":
        // Hard dependency from this node's perspective — must clear before
        // the focus node can move. Ranks above every child type.
        if (perspective === "target") {
          upsertFocusItem(
            grouped,
            createFocusItem(
              `${edge.id}-required`,
              `Secure ${linkedNode.title}`,
              `This is a hard dependency before ${selectedNode.title} can move.`,
              linkedNode.id,
              FOCUS_PRIORITY.HARD_PREREQ,
            ),
          );
        }
        break;
      case "belongs_to":
        // Direct child under the focus node. Type-tiered: tasks first, then
        // projects, classes, then anything-else as fallback.
        if (
          perspective === "target" &&
          linkedNode.node_type in FOCUS_PRIORITY.CHILD_BY_TYPE
        ) {
          upsertFocusItem(
            grouped,
            createFocusItem(
              `${edge.id}-child`,
              createChildActionTitle(linkedNode),
              `${linkedNode.title} is one of the next actionable branches under ${selectedNode.title}.`,
              linkedNode.id,
              calculateChildFocusPriority(linkedNode),
            ),
          );
        }
        break;
      case "supports":
        // Auxiliary "helps with" node — gentler importance bonus so a
        // high-importance support doesn't outrank a child.
        if (perspective === "target") {
          upsertFocusItem(
            grouped,
            createFocusItem(
              `${edge.id}-support`,
              `Pull in ${linkedNode.title}`,
              `${linkedNode.title} adds useful support to this branch.`,
              linkedNode.id,
              calculateSupportFocusPriority(linkedNode),
            ),
          );
        }
        break;
    }
  });

  return Array.from(grouped.values())
    .sort((itemA, itemB) => itemB.priority - itemA.priority || itemA.title.localeCompare(itemB.title))
    .slice(0, 5);
}
