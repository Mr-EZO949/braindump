// POST /api/workspaces/[id]/areas
// Creates life-area branch nodes the user accepted from a normal brain dump's
// review (the same areas the wizard's step 2 proposes). Each area becomes a
// top-level node anchored to the workspace root via belongs_to, and is embedded
// so connection analysis can attach the dump's nodes under it.
//
// Skips any area whose title already exists (case-insensitive) so re-dumping
// doesn't create duplicate branches.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { ensureWorkspaceRoot } from "@/lib/graph/ensure-workspace-root";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { AREA_TYPES } from "@/lib/ai/areas";
import type { NodeType, WorkspaceProfileAreaType } from "@/types/graph";

export const runtime = "nodejs";

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

interface AreaInput {
  title: string;
  area_type: WorkspaceProfileAreaType;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawAreas = (body as { areas?: unknown })?.areas;
  const areas: AreaInput[] = Array.isArray(rawAreas)
    ? rawAreas
        .filter(
          (a): a is AreaInput =>
            !!a &&
            typeof (a as AreaInput).title === "string" &&
            (a as AreaInput).title.trim().length > 0 &&
            typeof (a as AreaInput).area_type === "string" &&
            AREA_TYPES.has((a as AreaInput).area_type),
        )
        .map((a) => ({ title: a.title.trim().slice(0, 80), area_type: a.area_type }))
        .slice(0, 6)
    : [];

  if (areas.length === 0) {
    return NextResponse.json({ created_areas: [] });
  }

  // Verify workspace ownership.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const rootId = await ensureWorkspaceRoot({ supabase, userId: user.id, workspaceId });

  // Drop areas whose title already exists in the workspace (any status besides
  // deleted) so re-dumping never duplicates a branch.
  const { data: existing } = await supabase
    .from("nodes")
    .select("title")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .neq("status", "deleted");
  const existingTitles = new Set(
    (existing ?? []).map((n) => (n.title as string).trim().toLowerCase()),
  );
  const fresh = areas.filter((a) => !existingTitles.has(a.title.toLowerCase()));
  if (fresh.length === 0) {
    return NextResponse.json({ created_areas: [] });
  }

  const rows = fresh.map((area) => {
    const nodeType = AREA_TYPE_TO_NODE_TYPE[area.area_type];
    const importanceIndex = nodeType === "project" ? 66 : 60;
    return {
      user_id: user.id,
      workspace_id: workspaceId,
      title: area.title,
      summary: null,
      raw_text: null,
      node_type: nodeType,
      importance: getImportanceLabel(importanceIndex),
      importance_index: importanceIndex,
      color: NODE_COLOR_BY_TYPE[nodeType],
      status: "active",
    };
  });

  const { data: created, error: insertError } = await supabase
    .from("nodes")
    .insert(rows)
    .select("*");
  if (insertError || !created) {
    return NextResponse.json(
      { error: "Failed to create areas", detail: insertError?.message },
      { status: 500 },
    );
  }

  // Anchor each area under the workspace root (best-effort) and embed it so
  // connection analysis can link the dump's nodes to it.
  if (rootId) {
    const edgeRows = created.map((node) => ({
      user_id: user.id,
      workspace_id: workspaceId,
      source_node_id: node.id as string,
      target_node_id: rootId,
      edge_type: "belongs_to",
      confidence: 1,
      explanation: `${node.title as string} is a top-level branch.`,
      status: "active",
      user_confirmed: true,
    }));
    await supabase.from("edges").insert(edgeRows);
  }

  await Promise.all(
    created.map((node) =>
      generateAndStoreEmbedding({
        nodeId: node.id as string,
        title: node.title as string,
        summary: (node.summary as string | null) ?? null,
        workspaceId,
        userId: user.id,
        supabase,
      }).catch(() => {
        // Best-effort — a missing embedding falls to the retry queue.
      }),
    ),
  );

  return NextResponse.json({ created_areas: created });
}
