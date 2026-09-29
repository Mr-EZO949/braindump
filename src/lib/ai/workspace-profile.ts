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
  area: 5,
  goal: 5,
  project: 4,
  class: 3,
  habit: 3,
  big_task: 2,
  task: 1,
  idea: 1,
  note: 1,
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

// Active (non-archived) node row as fetched here — exposed so ingestion can
// run relevance retrieval without querying the workspace's nodes again.
export type WorkspaceNodeRow = AnchorNode;

export async function buildWorkspaceProfileContext(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  // Extraction lists relevant nodes (with ids + parent paths) in its own
  // block, so it passes false to avoid listing the anchors twice.
  includeAnchors?: boolean;
}): Promise<{
  workspaceContext: string | undefined;
  existingNodes: Array<{ id: string; title: string; summary: string | null; node_type: NodeType }>;
  activeNodes: WorkspaceNodeRow[];
  rootNodeId: string | null;
}> {
  const [{ data: workspaceRow }, { data: nodeRows }, { data: userProfileRow }] = await Promise.all([
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
    // User-level "about you" identity — reused across every workspace. Selected
    // by column so a missing table (migration not yet applied) fails soft to
    // null rather than throwing and breaking extraction.
    params.supabase
      .from("profiles")
      .select("full_name, occupation, paralysis_triggers, working_hours, deadline_cadence")
      .eq("user_id", params.userId)
      .maybeSingle(),
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

  const activeNodes: WorkspaceNodeRow[] = typedNodeRows
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
    .filter((node) => node.status !== "archived");

  const anchors = [...activeNodes]
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

  // User-level identity first — it's about the person, not this workspace, so
  // it frames everything below. Each field maps to a documented AI use.
  const userProfile = (userProfileRow ?? null) as {
    full_name?: string | null;
    occupation?: string | null;
    paralysis_triggers?: string | null;
    working_hours?: string | null;
    deadline_cadence?: string | null;
  } | null;
  if (userProfile) {
    const who = [userProfile.full_name, userProfile.occupation]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .join(" — ");
    if (who) {
      lines.push(`Who you are: ${who}`);
    }
    if (typeof userProfile.paralysis_triggers === "string" && userProfile.paralysis_triggers.trim()) {
      lines.push(`What tends to paralyze you: ${truncate(userProfile.paralysis_triggers.trim(), 300)}`);
    }
    if (typeof userProfile.working_hours === "string" && userProfile.working_hours.trim()) {
      lines.push(`Working hours / energy: ${truncate(userProfile.working_hours.trim(), 200)}`);
    }
    if (typeof userProfile.deadline_cadence === "string" && userProfile.deadline_cadence.trim()) {
      lines.push(`How you handle deadlines: ${truncate(userProfile.deadline_cadence.trim(), 200)}`);
    }
  }

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

  if (anchors.length > 0 && params.includeAnchors !== false) {
    lines.push("Existing workspace anchors:");
    lines.push(...anchors.map(formatAnchorLine));
  }

  return {
    workspaceContext: lines.length > 1 ? lines.join("\n") : undefined,
    existingNodes,
    activeNodes,
    rootNodeId,
  };
}
