// GET /api/clustering?workspace_id=<uuid>
// Lists this workspace's PENDING cluster suggestions (auto-grouping proposals),
// with each child node's title resolved, so the graph view can render an
// Accept/Dismiss card per group. Backend already runs the clustering pass on
// node-acceptance and persists rows here — this is the surface that was missing.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
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

  const workspaceId = req.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const { data: suggestions, error } = await supabase
    .from("cluster_suggestions")
    .select("id, suggested_title, suggested_node_type, child_node_ids, created_at")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .eq("proposal_status", "pending_review")
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = suggestions ?? [];
  // Resolve child titles in one batched query, then map per suggestion.
  const allChildIds = Array.from(new Set(rows.flatMap((r) => (r.child_node_ids as string[]) ?? [])));
  const titleById = new Map<string, string>();
  if (allChildIds.length > 0) {
    const { data: nodes } = await supabase
      .from("nodes")
      .select("id, title")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .in("id", allChildIds);
    for (const n of nodes ?? []) titleById.set(n.id as string, n.title as string);
  }

  const suggestions_out = rows
    .map((r) => {
      const children = ((r.child_node_ids as string[]) ?? [])
        .map((id) => ({ id, title: titleById.get(id) ?? null }))
        .filter((c): c is { id: string; title: string } => c.title !== null);
      return {
        id: r.id as string,
        suggested_title: r.suggested_title as string,
        suggested_node_type: r.suggested_node_type as string,
        child_count: children.length,
        children,
      };
    })
    .filter((s) => s.child_count >= 2); // a 1-child umbrella is noise

  return NextResponse.json({ suggestions: suggestions_out });
}
