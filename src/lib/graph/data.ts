import { demoGraphData } from "@/lib/graph/demo-data";
import { getImportanceIndex, getImportanceLabel } from "@/lib/graph/importance";
import { supabase } from "@/lib/supabase/client";
import type { ChatNodeContext } from "@/types/chat";
import type { Edge, GraphData, Node, Workspace } from "@/types/graph";

const fallbackWorkspaces = (userId: string | null): Workspace[] => [
  {
    id: "workspace-general",
    user_id: userId ?? "demo-user",
    name: "General",
    created_at: "2026-03-16T00:00:00.000Z",
  },
  {
    id: "workspace-personal",
    user_id: userId ?? "demo-user",
    name: "Personal",
    created_at: "2026-03-16T00:00:01.000Z",
  },
];

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

function cloneGraphData(graphData: GraphData, userId?: string | null): GraphData {
  return {
    nodes: normalizeNodes(
      graphData.nodes.map((node) => ({
        ...node,
        user_id: userId ?? node.user_id,
      })),
    ),
    edges: graphData.edges.map((edge) => ({
      ...edge,
      user_id: userId ?? edge.user_id,
    })),
  };
}

function emptyGraphData(): GraphData {
  return {
    nodes: [],
    edges: [],
  };
}

export async function loadGraphData(userId: string | null): Promise<GraphData> {
  if (!supabase || !userId) {
    return cloneGraphData(demoGraphData, userId);
  }

  try {
    const [{ data: nodes, error: nodesError }, { data: edges, error: edgesError }] =
      await Promise.all([
        supabase
          .from("nodes")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: true }),
        supabase
          .from("edges")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: true }),
      ]);

    if (nodesError || edgesError || !nodes || !edges || nodes.length === 0) {
      return cloneGraphData(demoGraphData, userId);
    }

    return {
      nodes: normalizeNodes(nodes as Node[]),
      edges: edges as Edge[],
    };
  } catch {
    return cloneGraphData(demoGraphData, userId);
  }
}

export async function loadWorkspaces(userId: string | null): Promise<Workspace[]> {
  if (!supabase || !userId) {
    return fallbackWorkspaces(userId);
  }

  try {
    const defaultWorkspaces = [
      { user_id: userId, name: "General" },
      { user_id: userId, name: "Personal" },
    ];

    const { error: upsertError } = await supabase
      .from("workspaces")
      .upsert(defaultWorkspaces, { onConflict: "user_id,name" });

    if (upsertError) {
      return fallbackWorkspaces(userId);
    }

    const { data, error } = await supabase
      .from("workspaces")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error || !data || data.length === 0) {
      return fallbackWorkspaces(userId);
    }

    return data as Workspace[];
  } catch {
    return fallbackWorkspaces(userId);
  }
}

export async function loadWorkspaceGraphData(
  userId: string | null,
  workspaceId: string | null,
  workspaceName?: string | null,
): Promise<GraphData> {
  if (!supabase || !userId || !workspaceId) {
    return workspaceName === "General" || workspaceId === "workspace-general"
      ? cloneGraphData(demoGraphData, userId)
      : emptyGraphData();
  }

  try {
    const [{ data: nodes, error: nodesError }, { data: edges, error: edgesError }] =
      await Promise.all([
        supabase
          .from("nodes")
          .select("*")
          .eq("user_id", userId)
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: true }),
        supabase
          .from("edges")
          .select("*")
          .eq("user_id", userId)
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: true }),
      ]);

    if (nodesError || edgesError || !nodes || !edges) {
      return workspaceName === "General" || workspaceId === "workspace-general"
        ? cloneGraphData(demoGraphData, userId)
        : emptyGraphData();
    }

    if (nodes.length === 0) {
      return workspaceName === "General" || workspaceId === "workspace-general"
        ? cloneGraphData(demoGraphData, userId)
        : emptyGraphData();
    }

    return {
      nodes: normalizeNodes(nodes as Node[]),
      edges: edges as Edge[],
    };
  } catch {
    return workspaceName === "General" || workspaceId === "workspace-general"
      ? cloneGraphData(demoGraphData, userId)
      : emptyGraphData();
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
