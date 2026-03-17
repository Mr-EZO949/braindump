import type { Edge, GraphData } from "@/types/graph";

export type StructuralParentCandidate = {
  childId: string;
  parentId: string;
  priority: number;
};

export type StructuralSubtree = {
  descendantCount: number;
  edgeIds: string[];
  nodeIds: string[];
};

export function getStructuralParentCandidate(edge: Edge): StructuralParentCandidate | null {
  switch (edge.edge_type) {
    case "belongs_to":
      return {
        childId: edge.source_node_id,
        parentId: edge.target_node_id,
        priority: 100,
      };
    case "required_for":
    case "prerequisite_for":
      return {
        childId: edge.target_node_id,
        parentId: edge.source_node_id,
        priority: 70,
      };
    default:
      return null;
  }
}

export function buildPrimaryStructuralTree(graphData: GraphData) {
  const parentCandidates = new Map<string, StructuralParentCandidate & { edgeId: string }>();
  const childrenByParent = new Map<string, string[]>();

  graphData.nodes.forEach((node) => {
    childrenByParent.set(node.id, []);
  });

  graphData.edges.forEach((edge) => {
    const candidate = getStructuralParentCandidate(edge);

    if (!candidate) {
      return;
    }

    const current = parentCandidates.get(candidate.childId);

    if (!current || candidate.priority > current.priority) {
      parentCandidates.set(candidate.childId, {
        ...candidate,
        edgeId: edge.id,
      });
    }
  });

  parentCandidates.forEach(({ parentId }, childId) => {
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  });

  return {
    childrenByParent,
    parentCandidates,
  };
}

export function getStructuralSubtree(graphData: GraphData, rootNodeId: string): StructuralSubtree {
  const { childrenByParent } = buildPrimaryStructuralTree(graphData);
  const visited = new Set<string>();
  const stack = [rootNodeId];

  while (stack.length > 0) {
    const nodeId = stack.pop();

    if (!nodeId || visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);

    (childrenByParent.get(nodeId) ?? []).forEach((childId) => {
      if (!visited.has(childId)) {
        stack.push(childId);
      }
    });
  }

  const nodeIds = Array.from(visited);
  const subtreeSet = new Set(nodeIds);
  const edgeIds = graphData.edges
    .filter(
      (edge) =>
        subtreeSet.has(edge.source_node_id) || subtreeSet.has(edge.target_node_id),
    )
    .map((edge) => edge.id);

  return {
    descendantCount: Math.max(nodeIds.length - 1, 0),
    edgeIds,
    nodeIds,
  };
}
