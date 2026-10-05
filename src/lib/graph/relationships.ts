import type { Edge } from "@/types/graph";
import { normalizeEdge, normalizeEdgeType, type LinkKind } from "@/lib/graph/edge-types";

export type EdgeRelationOptionId =
  | "contains"
  | "belongs_to"
  | "requires"
  | "required_for"
  | "supports"
  | "supported_by"
  | "related_to";

type EdgeRelationDirection = "selected-source" | "selected-target" | "selected-either";

export type EdgeRelationOption = {
  description: string;
  direction: EdgeRelationDirection;
  edgeType: LinkKind;
  id: EdgeRelationOptionId;
  label: string;
};

// The four link kinds (lib/graph/edge-types.ts), each from both ends.
export const edgeRelationOptions: EdgeRelationOption[] = [
  {
    id: "contains",
    label: "Contains",
    description: "Make the selected node the parent of another node.",
    edgeType: "belongs_to",
    direction: "selected-target",
  },
  {
    id: "belongs_to",
    label: "Belongs to",
    description: "Attach the selected node under another parent node.",
    edgeType: "belongs_to",
    direction: "selected-source",
  },
  {
    id: "requires",
    label: "Needs",
    description: "The other node has to be done before the selected one can move.",
    edgeType: "required_for",
    direction: "selected-target",
  },
  {
    id: "required_for",
    label: "Needed for",
    description: "The selected node has to be done before the other one can move.",
    edgeType: "required_for",
    direction: "selected-source",
  },
  {
    id: "supports",
    label: "Helps",
    description: "The selected node helps the other node along.",
    edgeType: "supports",
    direction: "selected-source",
  },
  {
    id: "supported_by",
    label: "Helped by",
    description: "The other node helps the selected node along.",
    edgeType: "supports",
    direction: "selected-target",
  },
  {
    id: "related_to",
    label: "Related",
    description: "The two nodes are about the same thing.",
    edgeType: "related_to",
    direction: "selected-either",
  },
];

export const visibleEdgeRelationOptions = edgeRelationOptions;

export function getEdgeRelationOption(
  relationId: EdgeRelationOptionId,
): EdgeRelationOption {
  return (
    edgeRelationOptions.find((option) => option.id === relationId) ??
    edgeRelationOptions[0]
  );
}

export function buildEdgePayloadFromSelection(
  selectedNodeId: string,
  targetNodeId: string,
  relationId: EdgeRelationOptionId,
) {
  const relation = getEdgeRelationOption(relationId);

  if (relation.direction === "selected-target") {
    return {
      edge_type: relation.edgeType,
      source_node_id: targetNodeId,
      target_node_id: selectedNodeId,
    };
  }

  return {
    edge_type: relation.edgeType,
    source_node_id: selectedNodeId,
    target_node_id: targetNodeId,
  };
}

export function getEdgeRelationOptionIdForSelection(
  edge: Edge,
  selectedNodeId: string,
): EdgeRelationOptionId {
  const link = normalizeEdge(edge);
  const selectedIsSource = link.source_node_id === selectedNodeId;

  switch (normalizeEdgeType(link.edge_type)) {
    case "belongs_to":
      return selectedIsSource ? "belongs_to" : "contains";
    case "required_for":
      return selectedIsSource ? "required_for" : "requires";
    case "supports":
      return selectedIsSource ? "supports" : "supported_by";
    case "related_to":
      return "related_to";
  }
}
