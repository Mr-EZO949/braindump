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

function getLocalPositionStorageKey(userId: string, workspaceId: string) {
  return `brain-dump:graph-layout:${userId}:${workspaceId}`;
}

function readLocalPositions(userId: string | null, workspaceId: string | null) {
  if (
    typeof window === "undefined" ||
    !userId ||
    !workspaceId
  ) {
    return {} as Record<string, { x: number; y: number }>;
  }

  try {
    const rawValue = window.localStorage.getItem(
      getLocalPositionStorageKey(userId, workspaceId),
    );

    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue) as Record<
      string,
      { x: number; y: number } | undefined
    >;

    return parsedValue;
  } catch {
    return {};
  }
}

function applyLocalPositions(
  graphData: GraphData,
  userId: string | null,
  workspaceId: string | null,
): GraphData {
  const localPositions = readLocalPositions(userId, workspaceId);

  if (Object.keys(localPositions).length === 0) {
    return graphData;
  }

  return {
    ...graphData,
    nodes: graphData.nodes.map((node) => {
      const localPosition = localPositions[node.id];

      if (
        !localPosition ||
        !Number.isFinite(localPosition.x) ||
        !Number.isFinite(localPosition.y)
      ) {
        return node;
      }

      return {
        ...node,
        manual_position: true,
        position_x: localPosition.x,
        position_y: localPosition.y,
      };
    }),
  };
}

export function persistLocalNodePosition(
  userId: string | null,
  workspaceId: string | null,
  nodeId: string,
  position: { x: number; y: number },
) {
  if (
    typeof window === "undefined" ||
    !userId ||
    !workspaceId
  ) {
    return;
  }

  try {
    const currentPositions = readLocalPositions(userId, workspaceId);
    currentPositions[nodeId] = position;
    window.localStorage.setItem(
      getLocalPositionStorageKey(userId, workspaceId),
      JSON.stringify(currentPositions),
    );
  } catch {
    // Ignore storage failures and keep DB persistence as the primary path.
  }
}

export function removeLocalNodePosition(
  userId: string | null,
  workspaceId: string | null,
  nodeId: string,
) {
  if (
    typeof window === "undefined" ||
    !userId ||
    !workspaceId
  ) {
    return;
  }

  try {
    const currentPositions = readLocalPositions(userId, workspaceId);

    if (!(nodeId in currentPositions)) {
      return;
    }

    delete currentPositions[nodeId];
    window.localStorage.setItem(
      getLocalPositionStorageKey(userId, workspaceId),
      JSON.stringify(currentPositions),
    );
  } catch {
    // Ignore storage failures and keep DB persistence as the primary path.
  }
}

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

function cloneGraphData(
  graphData: GraphData,
  userId?: string | null,
  workspaceId?: string | null,
): GraphData {
  return {
    nodes: normalizeNodes(
      graphData.nodes.map((node) => ({
        ...node,
        user_id: userId ?? node.user_id,
        workspace_id: workspaceId ?? node.workspace_id,
      })),
    ),
    edges: graphData.edges.map((edge) => ({
      ...edge,
      user_id: userId ?? edge.user_id,
      workspace_id: workspaceId ?? edge.workspace_id,
    })),
  };
}

function materializeDemoGraphForWorkspace(
  graphData: GraphData,
  userId: string,
  workspaceId: string,
): GraphData {
  const now = new Date().toISOString();
  const nodeIdMap = new Map<string, string>();

  const nodes = normalizeNodes(
    graphData.nodes.map((node) => {
      const id = crypto.randomUUID();
      nodeIdMap.set(node.id, id);

      return {
        ...node,
        id,
        created_at: now,
        updated_at: now,
        manual_position: false,
        position_x: null,
        position_y: null,
        user_id: userId,
        workspace_id: workspaceId,
      };
    }),
  );

  const edges = graphData.edges.map((edge) => ({
    ...edge,
    id: crypto.randomUUID(),
    created_at: now,
    source_node_id: nodeIdMap.get(edge.source_node_id) ?? edge.source_node_id,
    target_node_id: nodeIdMap.get(edge.target_node_id) ?? edge.target_node_id,
    user_id: userId,
    workspace_id: workspaceId,
  }));

  return { nodes, edges };
}

async function seedGeneralWorkspace(
  userId: string,
  workspaceId: string,
): Promise<GraphData | null> {
  if (!supabase) {
    return null;
  }

  const seededGraphData = materializeDemoGraphForWorkspace(demoGraphData, userId, workspaceId);

  const { data: insertedNodes, error: nodesError } = await supabase
    .from("nodes")
    .insert(seededGraphData.nodes)
    .select("*");

  if (nodesError || !insertedNodes) {
    return null;
  }

  const { data: insertedEdges, error: edgesError } = await supabase
    .from("edges")
    .insert(seededGraphData.edges)
    .select("*");

  if (edgesError || !insertedEdges) {
    return null;
  }

  return {
    nodes: normalizeNodes(insertedNodes as Node[]),
    edges: insertedEdges as Edge[],
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
    return applyLocalPositions(cloneGraphData(demoGraphData, userId), userId, null);
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
      return applyLocalPositions(cloneGraphData(demoGraphData, userId), userId, null);
    }

    return applyLocalPositions({
      nodes: normalizeNodes(nodes as Node[]),
      edges: edges as Edge[],
    }, userId, null);
  } catch {
    return applyLocalPositions(cloneGraphData(demoGraphData, userId), userId, null);
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
      ? applyLocalPositions(
          cloneGraphData(demoGraphData, userId, workspaceId),
          userId,
          workspaceId,
        )
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
        ? applyLocalPositions(
            cloneGraphData(demoGraphData, userId, workspaceId),
            userId,
            workspaceId,
          )
        : emptyGraphData();
    }

    if (nodes.length === 0) {
      if (workspaceName === "General" || workspaceId === "workspace-general") {
        const seededGraphData = await seedGeneralWorkspace(userId, workspaceId);

        return (
          seededGraphData ??
          applyLocalPositions(
            cloneGraphData(demoGraphData, userId, workspaceId),
            userId,
            workspaceId,
          )
        );
      }

      return emptyGraphData();
    }

    return applyLocalPositions({
      nodes: normalizeNodes(nodes as Node[]),
      edges: edges as Edge[],
    }, userId, workspaceId);
  } catch {
    return workspaceName === "General" || workspaceId === "workspace-general"
      ? applyLocalPositions(
          cloneGraphData(demoGraphData, userId, workspaceId),
          userId,
          workspaceId,
        )
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
