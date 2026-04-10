import { getImportanceIndex } from "@/lib/graph/importance";
import {
  getEdgeRelationOptionIdForSelection,
  isEdgeHiddenInUi,
  type EdgeRelationOptionId,
} from "@/lib/graph/relationships";
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

const relationshipPriority: Record<EdgeType, number> = {
  belongs_to: 90,
  required_for: 98,
  prerequisite_for: 98,
  supports: 70,
  useful_for: 58,
  blocks: 96,
  inspired_by: 42,
  related_to: 30,
  depends_on: 98,
};

function getPerspectiveForNode(edge: Edge, nodeId: string): Perspective {
  return edge.source_node_id === nodeId ? "source" : "target";
}

export function getDirectionalRelationshipLabel(
  edgeType: EdgeType,
  perspective: Perspective,
): string {
  switch (edgeType) {
    case "belongs_to":
      return perspective === "source" ? "belongs to" : "contains";
    case "required_for":
    case "prerequisite_for":
      return perspective === "source" ? "required for" : "requires";
    case "supports":
      return perspective === "source" ? "supports" : "supported by";
    case "useful_for":
      return perspective === "source" ? "useful for" : "helped by";
    case "blocks":
      return perspective === "source" ? "blocks" : "blocked by";
    case "inspired_by":
      return perspective === "source" ? "inspired by" : "inspires";
    case "related_to":
      return "related to";
    case "depends_on":
      return perspective === "source" ? "depends on" : "depended on by";
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

  graphData.edges.forEach((edge) => {
    if (isEdgeHiddenInUi(edge.edge_type)) {
      return;
    }

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
    const priority =
      relationshipPriority[edge.edge_type] + Math.round(getImportanceIndex(linkedNode) * 0.08);

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
    .flatMap((edge) => {
      if (isEdgeHiddenInUi(edge.edge_type)) {
        return [];
      }

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
          priority:
            relationshipPriority[edge.edge_type] +
            Math.round(getImportanceIndex(linkedNode) * 0.08),
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
  return ["goal", "project", "concept", "class", "habit"].includes(node.node_type);
}

function createChildActionTitle(node: Node) {
  switch (node.node_type) {
    case "task":
      return `Complete ${node.title}`;
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

  graphData.edges.forEach((edge) => {
    if (isEdgeHiddenInUi(edge.edge_type)) {
      return;
    }

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
      case "prerequisite_for":
        if (perspective === "target") {
          upsertFocusItem(
            grouped,
            createFocusItem(
              `${edge.id}-required`,
              `Secure ${linkedNode.title}`,
              `This is a hard dependency before ${selectedNode.title} can move.`,
              linkedNode.id,
              100,
            ),
          );
        }
        break;
      case "belongs_to":
        if (perspective === "target" && ["task", "project", "class", "concept"].includes(linkedNode.node_type)) {
          const priorityBase =
            linkedNode.node_type === "task"
              ? 82
              : linkedNode.node_type === "project"
                ? 74
                : linkedNode.node_type === "class"
                  ? 66
                  : 60;

          upsertFocusItem(
            grouped,
            createFocusItem(
              `${edge.id}-child`,
              createChildActionTitle(linkedNode),
              `${linkedNode.title} is one of the next actionable branches under ${selectedNode.title}.`,
              linkedNode.id,
              priorityBase + Math.round(getImportanceIndex(linkedNode) * 0.08),
            ),
          );
        }
        break;
      case "supports":
        if (perspective === "target") {
          upsertFocusItem(
            grouped,
            createFocusItem(
              `${edge.id}-support`,
              `Pull in ${linkedNode.title}`,
              `${linkedNode.title} adds useful support to this branch.`,
              linkedNode.id,
              58 + Math.round(getImportanceIndex(linkedNode) * 0.05),
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
