import { demoGraphData } from "@/lib/graph/demo-data";
import { getImportanceIndex, getImportanceLabel } from "@/lib/graph/importance";
import { supabase } from "@/lib/supabase/client";
import type { ChatNodeContext } from "@/types/chat";
import type { Edge, GraphData, Node } from "@/types/graph";

function normalizeNodes(nodes: Node[]) {
  return nodes.map((node) => {
    const importanceIndex = getImportanceIndex(node);

    return {
      ...node,
      importance: getImportanceLabel(importanceIndex),
      importance_index: importanceIndex,
    };
  });
}

function cloneGraphData(graphData: GraphData): GraphData {
  return {
    nodes: normalizeNodes(graphData.nodes),
    edges: graphData.edges.map((edge) => ({ ...edge })),
  };
}

export async function loadGraphData(): Promise<GraphData> {
  if (!supabase) {
    return cloneGraphData(demoGraphData);
  }

  try {
    const [{ data: nodes, error: nodesError }, { data: edges, error: edgesError }] =
      await Promise.all([
        supabase
          .from("nodes")
          .select("*")
          .order("created_at", { ascending: true }),
        supabase
          .from("edges")
          .select("*")
          .order("created_at", { ascending: true }),
      ]);

    if (nodesError || edgesError || !nodes || !edges || nodes.length === 0) {
      return cloneGraphData(demoGraphData);
    }

    return {
      nodes: normalizeNodes(nodes as Node[]),
      edges: edges as Edge[],
    };
  } catch {
    return cloneGraphData(demoGraphData);
  }
}

export function findFirstMatchingNode(graphData: GraphData, query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return null;
  }

  return (
    graphData.nodes.find((node) => node.title.toLowerCase() === normalizedQuery) ??
    graphData.nodes.find((node) => node.title.toLowerCase().includes(normalizedQuery)) ??
    null
  );
}

export function buildChatNodeContext(
  graphData: GraphData,
  nodeId: string | null,
): ChatNodeContext | null {
  if (!nodeId) {
    return null;
  }

  const node = graphData.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return null;
  }

  const neighboringEdges = graphData.edges.filter(
    (edge) => edge.source_node_id === nodeId || edge.target_node_id === nodeId,
  );
  const connectedNodeTitles = neighboringEdges
    .map((edge) =>
      edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id,
    )
    .map(
      (connectedNodeId) =>
        graphData.nodes.find((candidate) => candidate.id === connectedNodeId)?.title,
    )
    .filter((title): title is string => Boolean(title));

  return {
    id: node.id,
    title: node.title,
    summary: node.summary,
    node_type: node.node_type,
    importance: getImportanceLabel(getImportanceIndex(node)),
    importanceIndex: getImportanceIndex(node),
    connectedNodeTitles,
    edgeTypes: neighboringEdges.map((edge) => edge.edge_type),
  };
}
