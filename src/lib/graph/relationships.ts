import type { Edge, EdgeType } from "@/types/graph";

export type EdgeRelationOptionId =
  | "contains"
  | "belongs_to"
  | "requires"
  | "required_for"
  | "supports"
  | "supported_by"
  | "related_to"
  | "blocks"
  | "blocked_by"
  | "useful_for"
  | "helped_by"
  | "inspired_by"
  | "inspires";

type EdgeRelationDirection = "selected-source" | "selected-target" | "selected-either";

export type EdgeRelationOption = {
  description: string;
  direction: EdgeRelationDirection;
  edgeType: EdgeType;
  id: EdgeRelationOptionId;
  label: string;
};

const hiddenEdgeTypesInUi = new Set<EdgeType>(["blocks"]);

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
    label: "Requires",
    description: "The selected node depends on the other node first.",
    edgeType: "required_for",
    direction: "selected-target",
  },
  {
    id: "required_for",
    label: "Required for",
    description: "The selected node is a requirement for the other node.",
    edgeType: "required_for",
    direction: "selected-source",
  },
  {
    id: "supports",
    label: "Supports",
    description: "The selected node strengthens the other node.",
    edgeType: "supports",
    direction: "selected-source",
  },
  {
    id: "supported_by",
    label: "Supported by",
    description: "The selected node is supported by the other node.",
    edgeType: "supports",
    direction: "selected-target",
  },
  {
    id: "related_to",
    label: "Related to",
    description: "Create a weak associative link between the nodes.",
    edgeType: "related_to",
    direction: "selected-either",
  },
  {
    id: "blocks",
    label: "Blocks",
    description: "The selected node blocks progress on the other node.",
    edgeType: "blocks",
    direction: "selected-source",
  },
  {
    id: "blocked_by",
    label: "Blocked by",
    description: "The selected node is blocked by the other node.",
    edgeType: "blocks",
    direction: "selected-target",
  },
  {
    id: "useful_for",
    label: "Useful for",
    description: "The selected node is helpful for the other node.",
    edgeType: "useful_for",
    direction: "selected-source",
  },
  {
    id: "helped_by",
    label: "Helped by",
    description: "The selected node benefits from the other node.",
    edgeType: "useful_for",
    direction: "selected-target",
  },
  {
    id: "inspired_by",
    label: "Inspired by",
    description: "The selected node draws inspiration from the other node.",
    edgeType: "inspired_by",
    direction: "selected-source",
  },
  {
    id: "inspires",
    label: "Inspires",
    description: "The selected node inspires the other node.",
    edgeType: "inspired_by",
    direction: "selected-target",
  },
];

export const visibleEdgeRelationOptions = edgeRelationOptions.filter(
  (option) => !hiddenEdgeTypesInUi.has(option.edgeType),
);

export function isEdgeHiddenInUi(edgeType: EdgeType) {
  return hiddenEdgeTypesInUi.has(edgeType);
}

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
  const selectedIsSource = edge.source_node_id === selectedNodeId;

  switch (edge.edge_type) {
    case "belongs_to":
      return selectedIsSource ? "belongs_to" : "contains";
    case "required_for":
    case "prerequisite_for":
      return selectedIsSource ? "required_for" : "requires";
    case "supports":
      return selectedIsSource ? "supports" : "supported_by";
    case "related_to":
      return "related_to";
    case "blocks":
      return selectedIsSource ? "blocks" : "blocked_by";
    case "useful_for":
      return selectedIsSource ? "useful_for" : "helped_by";
    case "inspired_by":
      return selectedIsSource ? "inspired_by" : "inspires";
    case "depends_on":
      return selectedIsSource ? "required_for" : "requires";
  }
}
