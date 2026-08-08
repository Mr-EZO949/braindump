// POST /api/p/[slug]/fork
// Copies a public graph into the signed-in user's own account: a fresh
// workspace, every node re-created under new ids, and every edge remapped to
// those new ids. Requires auth (the public reading view sends anon visitors to
// /login first). RLS lets the caller read the public source and write their own
// rows.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { Edge, Node } from "@/types/graph";

const NODE_COPY_COLUMNS = [
  "title",
  "summary",
  "body",
  "raw_text",
  "node_type",
  "importance",
  "importance_index",
  "color",
  "status",
  "target_date",
  "reading_order",
  "position_x",
  "position_y",
  "manual_position",
] as const;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to fork this graph." }, { status: 401 });
  }

  const { data: source } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .maybeSingle();

  if (!source) {
    return NextResponse.json({ error: "This graph is not available." }, { status: 404 });
  }
  const sourceWorkspace = source as { id: string; name: string };

  const [{ data: nodeRows }, { data: edgeRows }] = await Promise.all([
    supabase.from("nodes").select("*").eq("workspace_id", sourceWorkspace.id),
    supabase.from("edges").select("*").eq("workspace_id", sourceWorkspace.id),
  ]);

  const sourceNodes = (nodeRows ?? []) as Node[];
  const sourceEdges = (edgeRows ?? []) as Edge[];

  // New workspace.
  const { data: newWorkspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .insert({
      user_id: user.id,
      name: `${sourceWorkspace.name} (forked)`,
      is_public: false,
    })
    .select("id")
    .single();

  if (workspaceError || !newWorkspaceRow) {
    return NextResponse.json(
      { error: workspaceError?.message ?? "Could not create workspace" },
      { status: 500 },
    );
  }
  const newWorkspaceId = (newWorkspaceRow as { id: string }).id;

  // Re-create nodes with fresh ids, remembering the old→new mapping for edges.
  const idMap = new Map<string, string>();
  const nodeInserts = sourceNodes.map((node) => {
    const newId = crypto.randomUUID();
    idMap.set(node.id, newId);
    const copy: Record<string, unknown> = {
      id: newId,
      user_id: user.id,
      workspace_id: newWorkspaceId,
    };
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const column of NODE_COPY_COLUMNS) {
      copy[column] = nodeRecord[column] ?? null;
    }
    return copy;
  });

  if (nodeInserts.length > 0) {
    const { error: nodesError } = await supabase.from("nodes").insert(nodeInserts);
    if (nodesError) {
      // Best-effort cleanup so a half-fork doesn't linger.
      await supabase.from("workspaces").delete().eq("id", newWorkspaceId).eq("user_id", user.id);
      return NextResponse.json({ error: nodesError.message }, { status: 500 });
    }
  }

  // Remap edges; drop any whose endpoints didn't come across.
  const edgeInserts = sourceEdges
    .map((edge) => {
      const source_node_id = idMap.get(edge.source_node_id);
      const target_node_id = idMap.get(edge.target_node_id);
      if (!source_node_id || !target_node_id) return null;
      return {
        id: crypto.randomUUID(),
        user_id: user.id,
        workspace_id: newWorkspaceId,
        source_node_id,
        target_node_id,
        edge_type: edge.edge_type,
        status: edge.status ?? "active",
        confidence: edge.confidence ?? null,
        explanation: edge.explanation ?? null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (edgeInserts.length > 0) {
    const { error: edgesError } = await supabase.from("edges").insert(edgeInserts);
    if (edgesError) {
      return NextResponse.json({ error: edgesError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ workspace_id: newWorkspaceId });
}
