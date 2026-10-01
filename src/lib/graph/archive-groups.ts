import type { GraphData, Node } from "@/types/graph";

export type ArchiveGroup = {
  parent: Node | null;
  nodes: Node[];
};

/** Keep archived work findable by the branch it belonged to before archiving. */
export function groupArchivedNodes(graphData: GraphData): ArchiveGroup[] {
  const nodeById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const parentByChild = new Map<string, string>();
  for (const edge of graphData.edges) {
    if (edge.edge_type === "belongs_to" && edge.status !== "user_rejected") {
      parentByChild.set(edge.source_node_id, edge.target_node_id);
    }
  }

  const groups = new Map<string | null, ArchiveGroup>();
  for (const node of graphData.nodes) {
    if (node.status !== "archived") continue;
    const parent = nodeById.get(parentByChild.get(node.id) ?? "") ?? null;
    const key = parent?.id ?? null;
    const group = groups.get(key) ?? { parent, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      nodes: group.nodes.sort(
        (a, b) =>
          (b.archived_at ?? b.updated_at).localeCompare(a.archived_at ?? a.updated_at) ||
          a.title.localeCompare(b.title),
      ),
    }))
    .sort((a, b) => {
      if (!a.parent && !b.parent) return 0;
      if (!a.parent) return 1;
      if (!b.parent) return -1;
      return a.parent.title.localeCompare(b.parent.title);
    });
}
