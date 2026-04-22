import type { NodeType, WorkspaceProfile } from "@/types/graph";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

type AnchorNode = {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  importance_index: number | null;
  current_importance_score: number | null;
  status: string | null;
};

const ANCHOR_TYPE_PRIORITY: Record<NodeType, number> = {
  goal: 5,
  project: 4,
  class: 3,
  concept: 2,
  task: 1,
  idea: 1,
  habit: 3,
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function normalizeProfile(raw: unknown): WorkspaceProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const profile = raw as Partial<WorkspaceProfile>;

  return {
    version: typeof profile.version === "number" ? profile.version : 1,
    role: typeof profile.role === "string" && profile.role.trim() ? profile.role.trim() : null,
    current_focus:
      typeof profile.current_focus === "string" && profile.current_focus.trim()
        ? profile.current_focus.trim()
        : null,
    success_title:
      typeof profile.success_title === "string" && profile.success_title.trim()
        ? profile.success_title.trim()
        : null,
    goals: Array.isArray(profile.goals)
      ? profile.goals
          .filter((goal): goal is string => typeof goal === "string" && goal.trim().length > 0)
          .map((goal) => goal.trim())
      : [],
    areas: Array.isArray(profile.areas)
      ? profile.areas.flatMap((area) => {
          if (!area || typeof area !== "object" || Array.isArray(area)) {
            return [];
          }

          const title =
            typeof area.title === "string" && area.title.trim() ? area.title.trim() : null;
          const areaType =
            typeof area.area_type === "string" && area.area_type.trim()
              ? area.area_type.trim()
              : null;

          if (!title || !areaType) {
            return [];
          }

          return [{ title, area_type: areaType }] as WorkspaceProfile["areas"];
        })
      : [],
  };
}

function formatAnchorLine(node: AnchorNode) {
  const summary = node.summary ? ` — ${truncate(node.summary, 140)}` : "";
  return `- ${node.id}: ${node.title} [${node.node_type}]${summary}`;
}

export async function buildWorkspaceProfileContext(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<{
  workspaceContext: string | undefined;
  existingNodes: Array<{ id: string; title: string; summary: string | null; node_type: NodeType }>;
}> {
  const [{ data: workspaceRow }, { data: nodeRows }] = await Promise.all([
    params.supabase
      .from("workspaces")
      .select("*")
      .eq("id", params.workspaceId)
      .eq("user_id", params.userId)
      .maybeSingle(),
    params.supabase
      .from("nodes")
      .select("*")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .order("created_at", { ascending: true }),
  ]);

  const workspaceName =
    typeof workspaceRow?.name === "string" && workspaceRow.name.trim()
      ? workspaceRow.name.trim()
      : "Workspace";
  const profile = normalizeProfile(workspaceRow?.profile_payload);
  const rootNodeId =
    typeof workspaceRow?.bootstrap_root_node_id === "string"
      ? workspaceRow.bootstrap_root_node_id
      : null;
  const typedNodeRows = (nodeRows ?? []) as Array<Record<string, unknown>>;

  const anchors = typedNodeRows
    .flatMap((row) => {
      if (
        typeof row.id !== "string" ||
        typeof row.title !== "string" ||
        typeof row.node_type !== "string"
      ) {
        return [];
      }

      return [
        {
          id: row.id,
          title: row.title,
          summary: typeof row.summary === "string" ? row.summary : null,
          node_type: row.node_type as NodeType,
          importance_index:
            typeof row.importance_index === "number" ? row.importance_index : null,
          current_importance_score:
            typeof row.current_importance_score === "number"
              ? row.current_importance_score
              : null,
          status: typeof row.status === "string" ? row.status : null,
        } satisfies AnchorNode,
      ];
    })
    .filter((node) => node.status !== "archived")
    .sort((nodeA, nodeB) => {
      const rootDelta = Number(nodeB.id === rootNodeId) - Number(nodeA.id === rootNodeId);
      if (rootDelta !== 0) {
        return rootDelta;
      }

      const typeDelta =
        (ANCHOR_TYPE_PRIORITY[nodeB.node_type] ?? 0) - (ANCHOR_TYPE_PRIORITY[nodeA.node_type] ?? 0);
      if (typeDelta !== 0) {
        return typeDelta;
      }

      const scoreA = nodeA.current_importance_score ?? nodeA.importance_index ?? 0;
      const scoreB = nodeB.current_importance_score ?? nodeB.importance_index ?? 0;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }

      return nodeA.title.localeCompare(nodeB.title);
    })
    .slice(0, 14);

  const existingNodes = anchors.map((node) => ({
    id: node.id,
    title: node.title,
    summary: node.summary,
    node_type: node.node_type,
  }));

  const lines = [`Workspace: ${workspaceName}`];

  if (typeof workspaceRow?.profile_role === "string" && workspaceRow.profile_role.trim()) {
    lines.push(`Identity context: ${workspaceRow.profile_role.trim()}`);
  } else if (profile?.role) {
    lines.push(`Identity context: ${profile.role}`);
  }

  if (typeof workspaceRow?.profile_summary === "string" && workspaceRow.profile_summary.trim()) {
    lines.push(`Current situation: ${truncate(workspaceRow.profile_summary.trim(), 220)}`);
  } else if (profile?.current_focus) {
    lines.push(`Current situation: ${truncate(profile.current_focus, 220)}`);
  }

  if (profile?.success_title) {
    lines.push(`North star: ${profile.success_title}`);
  }

  if (profile?.goals.length) {
    lines.push(`Big goals: ${profile.goals.join("; ")}`);
  }

  if (profile?.areas.length) {
    lines.push(
      `Main areas: ${profile.areas
        .map((area) => `${area.title} (${area.area_type.replaceAll("_", " ")})`)
        .join("; ")}`,
    );
  }

  if (anchors.length > 0) {
    lines.push("Existing workspace anchors:");
    lines.push(...anchors.map(formatAnchorLine));
  }

  return {
    workspaceContext: lines.length > 1 ? lines.join("\n") : undefined,
    existingNodes,
  };
}
