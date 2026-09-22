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

/**
 * Given a functional parent map (each child points to at most one parent),
 * returns the set of child IDs whose parent link must be dropped to make the
 * map acyclic.
 *
 * Why this exists: the primary structural tree gives every node a single
 * parent, but that does NOT guarantee a forest — a dependency/hierarchy loop
 * (e.g. `A required_for B` and `B required_for A`) produces a map where A's
 * parent is B and B's parent is A. The recursive layout (`placeNode` /
 * `computeSubtreeWidth`) walks the derived children map and would recurse
 * forever on such a loop. We break each cycle at its lowest-priority edge
 * (tie-break by child id, for determinism) so hierarchy edges survive over
 * weaker dependency edges, and the demoted edge simply renders as a normal
 * semantic link instead of a structural parent.
 */
export function findStructuralCycleBreaks(
  parentCandidates: Map<string, { parentId: string; priority: number }>,
): Set<string> {
  const drop = new Set<string>();
  const settled = new Set<string>();

  parentCandidates.forEach((_candidate, startId) => {
    if (settled.has(startId)) {
      return;
    }

    const path: string[] = [];
    const indexOnPath = new Map<string, number>();
    let current: string | undefined = startId;

    while (current) {
      if (drop.has(current) || settled.has(current)) {
        break;
      }

      const seenAt = indexOnPath.get(current);

      if (seenAt !== undefined) {
        // Found a cycle spanning path[seenAt..end]. Drop its weakest edge.
        const cycle = path.slice(seenAt);
        let victim = cycle[0];
        let victimPriority = parentCandidates.get(victim)?.priority ?? 0;

        for (const nodeId of cycle) {
          const priority = parentCandidates.get(nodeId)?.priority ?? 0;

          if (priority < victimPriority || (priority === victimPriority && nodeId < victim)) {
            victim = nodeId;
            victimPriority = priority;
          }
        }

        drop.add(victim);
        break;
      }

      indexOnPath.set(current, path.length);
      path.push(current);
      current = parentCandidates.get(current)?.parentId;
    }

    // Everything we walked leads into a broken/acyclic chain now — no need to
    // re-trace it from another start node.
    path.forEach((nodeId) => {
      if (!drop.has(nodeId)) {
        settled.add(nodeId);
      }
    });
  });

  return drop;
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

  // Demote cycle-closing edges so the primary tree is a true forest.
  findStructuralCycleBreaks(parentCandidates).forEach((childId) => {
    parentCandidates.delete(childId);
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
