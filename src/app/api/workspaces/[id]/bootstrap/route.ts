// POST /api/workspaces/[id]/bootstrap
// Creates an initial workspace profile plus a connected root/branch skeleton.
// Idempotent guard: if the workspace already has nodes, returns 409.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestToday } from "@/lib/time/request-date";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { pickGoalForArea } from "@/lib/graph/anchor-attachment";
import { runExtraction } from "@/lib/ai/extraction";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { AI_FLAGS } from "@/lib/ai/config";
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
  // Optional free-form "anything else on your mind" textarea — pipes
  // through the extraction pipeline to produce proposed_nodes the user
  // reviews after the wizard finishes. Lets us split multi-intent text
  // ("ship X, lose 15lb, learn rust") into proper nodes with target_dates.
  bootstrap_dump?: string;
}

// Life domains are areas (node types v2); the "project" category names one
// specific venture ("BrainDump"), so it stays a project.
// A top-level branch is where things LIVE, so it is always an area — also for
// the "project" flavour. Typed as a project, a branch like "Money Projects"
// could not hold the projects inside it (a project holds work, not projects),
// and extraction flattened their parts straight into it (2026-09-30).
const AREA_TYPE_TO_NODE_TYPE: Record<WorkspaceProfileAreaType, NodeType> = {
  academic: "area",
  project: "area",
  career: "area",
  health: "area",
  life_admin: "area",
  personal: "area",
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
    .select("id, name, bootstrap_root_node_id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (workspaceError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  // "Empty" means no USER content yet. But workspace creation already seeds a
  // single root node (ensureWorkspaceRoot), and the reuse logic further down
  // expects exactly that. Exclude the seeded root from the count — otherwise
  // the lone root makes count === 1 and bootstrap 409s on every freshly
  // created workspace, so the wizard could never run.
  const seededRootId = workspace.bootstrap_root_node_id as string | null | undefined;
  let nodeCountQuery = supabase
    .from("nodes")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id);
  if (seededRootId) {
    nodeCountQuery = nodeCountQuery.neq("id", seededRootId);
  }
  const { count } = await nodeCountQuery;

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
    bootstrap_dump: rawBootstrapDump,
  } = (body ?? {}) as BootstrapBody;

  const role =
    typeof rawRole === "string" && rawRole.trim() ? truncate(rawRole.trim(), 140) : null;
  const currentFocus =
    typeof rawCurrentFocus === "string" && rawCurrentFocus.trim()
      ? truncate(rawCurrentFocus.trim(), 320)
      : null;
  // The "Main focus" sentence the user typed. With the rework, this becomes
  // the root node's SUMMARY (description), not its title — so we no longer
  // truncate to 80 chars (a node title limit). Keep it readable but allow
  // the full sentence.
  const focusSummary =
    typeof rawSuccessTitle === "string" && rawSuccessTitle.trim()
      ? truncate(rawSuccessTitle.trim(), 320)
      : null;
  const bootstrapDump =
    typeof rawBootstrapDump === "string" && rawBootstrapDump.trim()
      ? rawBootstrapDump.trim()
      : null;
  const validGoals = normalizeGoals(goals);
  const validAreas = normalizeAreas(areas);

  // Root title: workspace name (so the graph isn't anchored on a generic
  // "Personal success"-style node, but on the user's actual workspace).
  const rootTitle = truncate(workspace.name?.trim() || "My workspace", 80);

  const profilePayload: WorkspaceProfile = {
    version: 1,
    role,
    current_focus: currentFocus,
    // Persist the original focus sentence under success_title for back-compat
    // with anything that reads workspaces.profile_payload.success_title.
    success_title: focusSummary ?? "",
    goals: validGoals.map((goal) => goal.title),
    areas: validAreas,
  };

  // Root summary = the user's "Main focus" sentence as-typed when present;
  // otherwise fall back to the auto-generated descriptor. The whole point
  // of the rework is that this sentence lives as descriptive metadata on
  // the root, NOT as a node title.
  const rootSummary =
    focusSummary ??
    buildRootSummary({
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

  // Root: the workspace anchor. Title = workspace name, summary = focus
  // sentence. Importance is intentionally medium (55) — not 92 — so the
  // root doesn't visually dominate the canvas as the biggest sphere. It's
  // structural anchor first, "thing to look at" second.
  // Importance is locked low via manual_weight — the scoring pipeline
  // would otherwise push the root to the top of the workspace because
  // its centrality (degree / total nodes) becomes ~1.0 once everything
  // anchors to it. manual_weight bypasses the formula entirely so the
  // root stays visually subtle on the canvas no matter how large the
  // graph grows.
  const ROOT_IMPORTANCE = 30;

  // Workspace creation already seeds a root node. Reuse it — upgrading its
  // title/summary to the richer wizard values — so completing the wizard never
  // leaves a second, stray root floating on the canvas with the first one's
  // children still anchored to it.
  let resolvedRoot: Record<string, unknown> | null = null;
  const existingRootId = workspace.bootstrap_root_node_id as string | null | undefined;
  if (existingRootId) {
    const { data: reusedRoot } = await supabase
      .from("nodes")
      .update({ title: rootTitle, summary: rootSummary })
      .eq("id", existingRootId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (reusedRoot) resolvedRoot = reusedRoot;
  }

  if (!resolvedRoot) {
    const { data: createdRoot, error: rootError } = await supabase
      .from("nodes")
      .insert({
        user_id: user.id,
        workspace_id: workspaceId,
        title: rootTitle,
        summary: rootSummary,
        raw_text: null,
        // The root is the user's whole life, never a goal (node types v2).
        node_type: "area" as NodeType,
        importance: getImportanceLabel(ROOT_IMPORTANCE),
        importance_index: ROOT_IMPORTANCE,
        manual_weight: ROOT_IMPORTANCE,
        manual_weight_set_at: new Date().toISOString(),
        color: NODE_COLOR_BY_TYPE.area,
        status: "active",
      })
      .select("*")
      .single();

    if (rootError || !createdRoot) {
      return NextResponse.json(
        { error: "Failed to create root node", detail: rootError?.message },
        { status: 500 },
      );
    }
    resolvedRoot = createdRoot;
  }

  // Both branches above either assign or return, but Supabase rows come back
  // as `any`, so TS can't prove it — this guard makes the invariant explicit.
  // Binding to a const also keeps the narrowing alive inside the .map()
  // closures below, which would widen a `let` back to nullable.
  if (!resolvedRoot) {
    return NextResponse.json({ error: "Failed to create root node" }, { status: 500 });
  }
  const rootNode = resolvedRoot;

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

  // Embed the skeleton branches (goals + areas). Without embeddings these
  // nodes are invisible to semantic search — so connection analysis on the
  // first dump can't link the user's new tasks to their life-areas, and the
  // retroactive clustering pass skips them. Awaited + best-effort per node so
  // a flaky embedding call never fails the wizard.
  await Promise.all(
    childNodes
      .filter((node) => typeof node.id === "string" && typeof node.title === "string")
      .map((node) =>
        generateAndStoreEmbedding({
          nodeId: node.id as string,
          title: node.title as string,
          summary: (node.summary as string | null) ?? null,
          workspaceId,
          userId: user.id,
          supabase,
        }).catch(() => {
          // Node is created regardless; a missing embedding falls to the retry queue.
        }),
      ),
  );

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
      // Bootstrap_dump path is intentionally skipped on this fallback — if
      // the workspace's profile columns are missing, the schema is older
      // than this feature; we still return a working workspace.
      return NextResponse.json({
        created_root: rootNode,
        created_children: childNodes.length,
        created_edges: childNodes.length,
        profile: profilePayload,
        profile_persisted: false,
        bootstrap_dump: { raw_entry_id: null, proposed_node_count: 0, extraction_error: null },
      });
    }

    await rollbackBootstrap();
    return NextResponse.json(
      { error: "Failed to save workspace profile", detail: updateWorkspaceError.message },
      { status: 500 },
    );
  }

  // ---------------------------------------------------------------------
  // Optional: pipe the bootstrap dump through extraction.
  //
  // If the user wrote a freeform "anything else on your mind" textarea,
  // we save it as a raw_entry and run the standard extraction pipeline.
  // The resulting proposed_nodes hit the review modal on next refresh.
  // We do NOT roll the workspace back if extraction fails — the wizard
  // succeeded, the dump's just a bonus pass.
  // ---------------------------------------------------------------------
  // The dump output the client uses to auto-open the review modal.
  type BootstrapDumpResult = {
    raw_entry_id: string | null;
    proposed_node_count: number;
    proposed_nodes: unknown[];
    clarifying_questions: unknown[];
    extraction_error: string | null;
  };
  const bootstrapDumpResult: BootstrapDumpResult = {
    raw_entry_id: null,
    proposed_node_count: 0,
    proposed_nodes: [],
    clarifying_questions: [],
    extraction_error: null,
  };

  if (bootstrapDump && AI_FLAGS.EXTRACTION_ENABLED) {
    const { data: rawEntry, error: rawError } = await supabase
      .from("raw_entries")
      .insert({
        user_id: user.id,
        workspace_id: workspaceId,
        raw_text: bootstrapDump,
        source_type: "brain_dump",
        status: "pending",
      })
      .select("id")
      .single();

    if (rawError || !rawEntry) {
      bootstrapDumpResult.extraction_error = rawError?.message ?? "Failed to save bootstrap dump";
    } else {
      bootstrapDumpResult.raw_entry_id = rawEntry.id;
      const result = await runExtraction({
        rawEntryId: rawEntry.id,
        rawText: bootstrapDump,
        workspaceId,
        userId: user.id,
        supabase,
        today: await getRequestToday(),
      });
      if (result.ok) {
        // Anchor any orphan proposals (no existing parent + no proposed
        // parent_local_ref pointing at a sibling) to the workspace root.
        // Without this the graph ends up with floating clusters — "Call
        // Mom this weekend" or "Renew passport" don't naturally hang off
        // a goal, and the AI leaves them parentless. Forcing the root
        // anchor keeps the graph connected on first dump.
        await supabase
          .from("proposed_nodes")
          .update({ existing_parent_node_id: rootNode.id })
          .eq("raw_entry_id", rawEntry.id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", user.id)
          .is("existing_parent_node_id", null)
          .is("primary_parent_local_ref", null);

        // Re-fetch so the response reflects the anchoring.
        const { data: anchored } = await supabase
          .from("proposed_nodes")
          .select("*")
          .eq("raw_entry_id", rawEntry.id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", user.id)
          .order("local_ref", { ascending: true });

        bootstrapDumpResult.proposed_node_count = (anchored ?? result.proposedNodes).length;
        bootstrapDumpResult.proposed_nodes = anchored ?? result.proposedNodes;
        bootstrapDumpResult.clarifying_questions = result.clarifyingQuestions ?? [];
      } else {
        bootstrapDumpResult.extraction_error = result.error;
      }
    }
  } else if (bootstrapDump && !AI_FLAGS.EXTRACTION_ENABLED) {
    // User wrote a dump but extraction is disabled — surface this so the
    // client can tell them their notes are saved but weren't processed,
    // rather than silently swallowing the dump.
    bootstrapDumpResult.extraction_error = "extraction_disabled";
  }

  return NextResponse.json({
    created_root: rootNode,
    created_children: childNodes.length,
    created_edges: childNodes.length,
    profile: profilePayload,
    bootstrap_dump: bootstrapDumpResult,
  });
}
