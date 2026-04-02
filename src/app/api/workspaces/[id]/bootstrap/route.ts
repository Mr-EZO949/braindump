// POST /api/workspaces/[id]/bootstrap
// Creates an initial workspace profile plus a connected root/branch skeleton.
// Idempotent guard: if the workspace already has nodes, returns 409.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { pickGoalForArea } from "@/lib/graph/anchor-attachment";
import type {
  NodeType,
  WorkspaceProfile,
  WorkspaceProfileArea,
  WorkspaceProfileAreaType,
} from "@/types/graph";

interface GoalInput {
  title: string;
}

interface AreaInput {
  title: string;
  area_type: WorkspaceProfileAreaType;
}

interface BootstrapBody {
  role?: string;
  current_focus?: string;
  success_title?: string;
  goals?: GoalInput[];
  areas?: AreaInput[];
}

const AREA_TYPE_TO_NODE_TYPE: Record<WorkspaceProfileAreaType, NodeType> = {
  academic: "concept",
  project: "project",
  career: "project",
  health: "concept",
  life_admin: "concept",
  personal: "concept",
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trim();
}

function isMissingColumnError(message: string | undefined, columnName: string) {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes("column") && normalized.includes(columnName.toLowerCase());
}

function normalizeGoals(goals: BootstrapBody["goals"]) {
  return Array.isArray(goals)
    ? goals
        .filter((goal) => typeof goal.title === "string" && goal.title.trim())
        .map((goal) => ({ title: truncate(goal.title.trim(), 80) }))
        .slice(0, 4)
    : [];
}

function normalizeAreas(areas: BootstrapBody["areas"]): WorkspaceProfileArea[] {
  return Array.isArray(areas)
    ? areas
        .filter(
          (area) =>
            typeof area.title === "string" &&
            area.title.trim() &&
            typeof area.area_type === "string" &&
            area.area_type in AREA_TYPE_TO_NODE_TYPE,
        )
        .map((area) => ({
          title: truncate(area.title.trim(), 80),
          area_type: area.area_type,
        }))
        .slice(0, 6)
    : [];
}

function buildRootSummary(params: {
  role: string | null;
  currentFocus: string | null;
  goalCount: number;
  areaCount: number;
}) {
  const fragments = [
    params.role ? `${params.role} workspace` : null,
    params.currentFocus ? params.currentFocus : null,
    params.goalCount > 0 ? `${params.goalCount} top goal${params.goalCount === 1 ? "" : "s"}` : null,
    params.areaCount > 0
      ? `${params.areaCount} active area${params.areaCount === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean) as string[];

  if (fragments.length === 0) {
    return "North-star node for this workspace.";
  }

  return truncate(fragments.join(". "), 240);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (workspaceError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  const { count } = await supabase
    .from("nodes")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id);

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: "Workspace already has nodes — bootstrap only works on empty workspaces" },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    role: rawRole,
    current_focus: rawCurrentFocus,
    success_title: rawSuccessTitle,
    goals,
    areas,
  } = (body ?? {}) as BootstrapBody;

  const role =
    typeof rawRole === "string" && rawRole.trim() ? truncate(rawRole.trim(), 140) : null;
  const currentFocus =
    typeof rawCurrentFocus === "string" && rawCurrentFocus.trim()
      ? truncate(rawCurrentFocus.trim(), 320)
      : null;
  const successTitle =
    typeof rawSuccessTitle === "string" && rawSuccessTitle.trim()
      ? truncate(rawSuccessTitle.trim(), 80)
      : "Success";
  const validGoals = normalizeGoals(goals);
  const validAreas = normalizeAreas(areas);

  const profilePayload: WorkspaceProfile = {
    version: 1,
    role,
    current_focus: currentFocus,
    success_title: successTitle,
    goals: validGoals.map((goal) => goal.title),
    areas: validAreas,
  };

  const rootSummary = buildRootSummary({
    role,
    currentFocus,
    goalCount: validGoals.length,
    areaCount: validAreas.length,
  });
  const rollbackBootstrap = async () => {
    await supabase
      .from("nodes")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id);
  };

  const { data: rootNode, error: rootError } = await supabase
    .from("nodes")
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      title: successTitle,
      summary: rootSummary,
      raw_text: null,
      node_type: "goal" as NodeType,
      importance: getImportanceLabel(92),
      importance_index: 92,
      color: NODE_COLOR_BY_TYPE.goal,
      status: "active",
    })
    .select("*")
    .single();

  if (rootError || !rootNode) {
    return NextResponse.json(
      { error: "Failed to create root node", detail: rootError?.message },
      { status: 500 },
    );
  }

  const goalRows = validGoals.map((goal) => ({
    user_id: user.id,
    workspace_id: workspaceId,
    title: goal.title,
    summary: null,
    raw_text: null,
    node_type: "goal" as NodeType,
    importance: getImportanceLabel(76),
    importance_index: 76,
    color: NODE_COLOR_BY_TYPE.goal,
    status: "active",
  }));

  const createdGoals =
    goalRows.length > 0
      ? await supabase.from("nodes").insert(goalRows).select("*")
      : { data: [], error: null };

  if (createdGoals.error) {
    await rollbackBootstrap();
    return NextResponse.json(
      { error: "Failed to create bootstrap goals", detail: createdGoals.error.message },
      { status: 500 },
    );
  }

  const goalNodes = (createdGoals.data ?? []) as Array<Record<string, unknown>>;
  const goalCandidates = goalNodes
    .filter((node) => typeof node.id === "string" && typeof node.title === "string")
    .map((node) => ({
      id: node.id as string,
      title: node.title as string,
    }));

  const areaRows = validAreas.map((area) => {
    const nodeType = AREA_TYPE_TO_NODE_TYPE[area.area_type];
    return {
      user_id: user.id,
      workspace_id: workspaceId,
      title: area.title,
      summary: null,
      raw_text: null,
      node_type: nodeType,
      importance: getImportanceLabel(nodeType === "project" ? 66 : 60),
      importance_index: nodeType === "project" ? 66 : 60,
      color: NODE_COLOR_BY_TYPE[nodeType],
      status: "active",
    };
  });

  const createdAreas =
    areaRows.length > 0
      ? await supabase.from("nodes").insert(areaRows).select("*")
      : { data: [], error: null };

  if (createdAreas.error) {
    await rollbackBootstrap();
    return NextResponse.json(
      { error: "Failed to create bootstrap areas", detail: createdAreas.error.message },
      { status: 500 },
    );
  }

  const areaNodes = (createdAreas.data ?? []) as Array<Record<string, unknown>>;
  const childNodes = [...goalNodes, ...areaNodes];

  if (childNodes.length > 0) {
    const goalEdgeRows = goalNodes.map((node) => ({
      user_id: user.id,
      workspace_id: workspaceId,
      source_node_id: node.id as string,
      target_node_id: rootNode.id as string,
      edge_type: "belongs_to",
      confidence: 1,
      explanation: `${node.title as string} is a top-level branch of ${rootNode.title as string}.`,
      status: "active",
      user_confirmed: true,
    }));

    const areaEdgeRows = areaNodes.map((node, index) => {
      const matchedGoalId = pickGoalForArea({
        areaTitle: validAreas[index]?.title ?? (node.title as string),
        areaType: validAreas[index]?.area_type ?? "personal",
        goals: goalCandidates,
      });
      const targetNodeId = matchedGoalId ?? (rootNode.id as string);
      const targetTitle =
        goalCandidates.find((goal) => goal.id === matchedGoalId)?.title ?? (rootNode.title as string);

      return {
        user_id: user.id,
        workspace_id: workspaceId,
        source_node_id: node.id as string,
        target_node_id: targetNodeId,
        edge_type: "belongs_to",
        confidence: 1,
        explanation: `${node.title as string} is a branch of ${targetTitle}.`,
        status: "active",
        user_confirmed: true,
      };
    });

    const edgeRows = [...goalEdgeRows, ...areaEdgeRows];
    const { error: edgeError } = await supabase.from("edges").insert(edgeRows);

    if (edgeError) {
      await rollbackBootstrap();
      return NextResponse.json(
        { error: "Failed to create bootstrap edges", detail: edgeError.message },
        { status: 500 },
      );
    }
  }

  const { error: updateWorkspaceError } = await supabase
    .from("workspaces")
    .update({
      profile_role: role,
      profile_summary: currentFocus,
      profile_payload: profilePayload,
      bootstrap_root_node_id: rootNode.id,
      bootstrap_completed_at: new Date().toISOString(),
    })
    .eq("id", workspaceId)
    .eq("user_id", user.id);

  if (updateWorkspaceError) {
    const canFallback =
      isMissingColumnError(updateWorkspaceError.message, "profile_role") ||
      isMissingColumnError(updateWorkspaceError.message, "profile_summary") ||
      isMissingColumnError(updateWorkspaceError.message, "profile_payload") ||
      isMissingColumnError(updateWorkspaceError.message, "bootstrap_root_node_id") ||
      isMissingColumnError(updateWorkspaceError.message, "bootstrap_completed_at");

    if (canFallback) {
      return NextResponse.json({
        created_root: rootNode,
        created_children: childNodes.length,
        created_edges: childNodes.length,
        profile: profilePayload,
        profile_persisted: false,
      });
    }

    await rollbackBootstrap();
    return NextResponse.json(
      { error: "Failed to save workspace profile", detail: updateWorkspaceError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    created_root: rootNode,
    created_children: childNodes.length,
    created_edges: childNodes.length,
    profile: profilePayload,
  });
}
