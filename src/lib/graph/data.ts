
import { getImportanceIndex, getImportanceLabel } from "@/lib/graph/importance";
import { supabase } from "@/lib/supabase/client";
import type { ChatNodeContext } from "@/types/chat";
import type { Edge, GraphData, Node, Workspace } from "@/types/graph";

export type LocalGraphCameraView = {
  panX: number;
  panY: number;
  zoom: number;
};

export type LocalGraphViewState = {
  cameraView: LocalGraphCameraView | null;
  selectedNodeId: string | null;
};

const fallbackWorkspaces = (userId: string | null): Workspace[] => [
  {
    id: "workspace-general",
    user_id: userId ?? "demo-user",
    name: "General",
    created_at: "2026-03-16T00:00:00.000Z",
  },
];

function getLocalPositionStorageKey(userId: string, workspaceId: string) {
  return `brain-dump:graph-layout:${userId}:${workspaceId}`;
}

function getLocalViewStateStorageKey(userId: string, workspaceId: string) {
  return `brain-dump:view-state:${userId}:${workspaceId}`;
}

function getLocalWorkspaceStorageKey(userId: string) {
  return `brain-dump:selected-workspace:${userId}`;
}

function defaultLocalViewState(): LocalGraphViewState {
  return {
    cameraView: null,
    selectedNodeId: null,
  };
}

export function readLocalPositions(userId: string | null, workspaceId: string | null) {
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

function readLocalViewState(
  userId: string | null,
  workspaceId: string | null,
): LocalGraphViewState {
  if (typeof window === "undefined" || !userId || !workspaceId) {
    return defaultLocalViewState();
  }

  try {
    const rawValue = window.localStorage.getItem(getLocalViewStateStorageKey(userId, workspaceId));

    if (!rawValue) {
      return defaultLocalViewState();
    }

    const parsedValue = JSON.parse(rawValue) as Partial<LocalGraphViewState>;
    const cameraView = parsedValue.cameraView;

    return {
      cameraView:
        cameraView &&
        Number.isFinite(cameraView.panX) &&
        Number.isFinite(cameraView.panY) &&
        Number.isFinite(cameraView.zoom)
          ? {
              panX: Number(cameraView.panX),
              panY: Number(cameraView.panY),
              zoom: Number(cameraView.zoom),
            }
          : null,
      selectedNodeId:
        typeof parsedValue.selectedNodeId === "string" ? parsedValue.selectedNodeId : null,
    };
  } catch {
    return defaultLocalViewState();
  }
}

function writeLocalViewState(
  userId: string | null,
  workspaceId: string | null,
  patch: Partial<LocalGraphViewState>,
) {
  if (typeof window === "undefined" || !userId || !workspaceId) {
    return;
  }

  try {
    const currentState = readLocalViewState(userId, workspaceId);
    const nextState: LocalGraphViewState = {
      cameraView:
        patch.cameraView === undefined ? currentState.cameraView : patch.cameraView,
      selectedNodeId:
        patch.selectedNodeId === undefined ? currentState.selectedNodeId : patch.selectedNodeId,
    };

    window.localStorage.setItem(
      getLocalViewStateStorageKey(userId, workspaceId),
      JSON.stringify(nextState),
    );
  } catch {
    // Ignore storage failures. The app still works without local view persistence.
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

export function readLocalGraphViewState(
  userId: string | null,
  workspaceId: string | null,
) {
  return readLocalViewState(userId, workspaceId);
}

export function persistLocalSelectedNode(
  userId: string | null,
  workspaceId: string | null,
  selectedNodeId: string | null,
) {
  writeLocalViewState(userId, workspaceId, { selectedNodeId });
}

export function persistLocalCameraView(
  userId: string | null,
  workspaceId: string | null,
  cameraView: LocalGraphCameraView | null,
) {
  writeLocalViewState(userId, workspaceId, {
    cameraView: cameraView
      ? {
          panX: Number(cameraView.panX.toFixed(2)),
          panY: Number(cameraView.panY.toFixed(2)),
          zoom: Number(cameraView.zoom.toFixed(4)),
        }
      : null,
  });
}

export function readLocalSelectedWorkspaceId(userId: string | null) {
  if (typeof window === "undefined" || !userId) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(getLocalWorkspaceStorageKey(userId));
    return rawValue && rawValue.trim().length > 0 ? rawValue : null;
  } catch {
    return null;
  }
}

export function persistLocalSelectedWorkspaceId(
  userId: string | null,
  workspaceId: string | null,
) {
  if (typeof window === "undefined" || !userId) {
    return;
  }

  try {
    const storageKey = getLocalWorkspaceStorageKey(userId);

    if (workspaceId) {
      window.localStorage.setItem(storageKey, workspaceId);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Ignore storage failures. The app still works without local workspace persistence.
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

function emptyGraphData(): GraphData {
  return {
    nodes: [],
    edges: [],
  };
}

export async function loadWorkspaces(userId: string | null): Promise<Workspace[]> {
  if (!supabase || !userId) {
    return fallbackWorkspaces(userId);
  }

  try {
    const defaultWorkspaces = [
      { user_id: userId, name: "General" },
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
    return emptyGraphData();
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
      return emptyGraphData();
    }

    if (nodes.length === 0) {
      return emptyGraphData();
    }

    return applyLocalPositions({
      nodes: normalizeNodes(nodes as Node[]),
      edges: edges as Edge[],
    }, userId, workspaceId);
  } catch {
    return emptyGraphData();
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
  indexes?: {
    nodesById: Map<string, Node>;
    incidentEdgesByNode: Map<string, Edge[]>;
  },
): ChatNodeContext | null {
  if (!nodeId) {
    return null;
  }

  const nodesById =
    indexes?.nodesById ?? new Map(graphData.nodes.map((candidate) => [candidate.id, candidate]));
  const node = nodesById.get(nodeId);

  if (!node) {
    return null;
  }

  const neighboringEdges =
    indexes?.incidentEdgesByNode.get(nodeId) ??
    graphData.edges.filter(
      (edge) => edge.source_node_id === nodeId || edge.target_node_id === nodeId,
    );
  const connectedNodeTitles = neighboringEdges
    .map((edge) =>
      edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id,
    )
    .map(
      (connectedNodeId) => nodesById.get(connectedNodeId)?.title,
    )
    .filter((title): title is string => Boolean(title));

  return {
    id: node.id,
    title: node.title,
    summary: node.summary,
    body: node.body ?? null,
    node_type: node.node_type,
    importance: getImportanceLabel(getImportanceIndex(node)),
    importanceIndex: getImportanceIndex(node),
    currentImportanceScore: node.current_importance_score ?? null,
    importanceReason: node.importance_reason ?? null,
    importanceTopSignals: node.importance_top_signals ?? null,
    stakes: node.stakes ?? null,
    waitingFor: node.waiting_for ?? null,
    resumeOn: node.resume_on ?? null,
    status: node.status ?? null,
    connectedNodeTitles,
    edgeTypes: neighboringEdges.map((edge) => edge.edge_type),
  };
}
