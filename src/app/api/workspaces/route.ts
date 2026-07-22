// POST /api/workspaces
// Creates a new workspace for the authenticated user.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { ensureWorkspaceRoot } from "@/lib/graph/ensure-workspace-root";

export async function POST(req: NextRequest) {
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
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = ((body as { name?: unknown }).name as string | undefined)?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (name.length > 80) {
    return NextResponse.json({ error: "name must be 80 characters or fewer" }, { status: 400 });
  }

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .insert({ user_id: user.id, name })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Give the workspace a root immediately. The bootstrap wizard would create a
  // richer one, but it's skippable — and a rootless workspace silently loses
  // clustering and leaves every accepted node orphaned. The wizard reuses this
  // node rather than creating a second root.
  const rootId = await ensureWorkspaceRoot({
    supabase,
    userId: user.id,
    workspaceId: workspace.id as string,
  });

  return NextResponse.json(
    { ...workspace, bootstrap_root_node_id: rootId ?? null },
    { status: 201 },
  );
}
