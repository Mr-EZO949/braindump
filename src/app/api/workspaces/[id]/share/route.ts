// PATCH /api/workspaces/[id]/share
// Publish / unpublish a workspace. Body: { isPublic: boolean }.
// On publish, mints a stable public_slug (kept on unpublish so re-sharing reuses
// the same URL). RLS scopes the update to the owner.

import { NextRequest, NextResponse } from "next/server";

import { buildPublicSlug } from "@/lib/graph/public-share";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const isPublic = (payload as { isPublic?: unknown })?.isPublic;
  if (typeof isPublic !== "boolean") {
    return NextResponse.json({ error: "isPublic must be a boolean" }, { status: 400 });
  }

  const { data: workspace, error: fetchError } = await supabase
    .from("workspaces")
    .select("id, name, public_slug, shared_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const row = workspace as {
    id: string;
    name: string;
    public_slug: string | null;
    shared_at: string | null;
  };

  if (!isPublic) {
    const { error } = await supabase
      .from("workspaces")
      .update({ is_public: false })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ is_public: false, slug: row.public_slug });
  }

  // Publishing: ensure a slug, retrying once on the (improbable) unique clash.
  let slug = row.public_slug ?? buildPublicSlug(row.name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await supabase
      .from("workspaces")
      .update({
        is_public: true,
        public_slug: slug,
        shared_at: row.shared_at ?? new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id);

    if (!error) {
      return NextResponse.json({ is_public: true, slug, path: `/p/${slug}` });
    }
    // 23505 = unique_violation on public_slug
    if ((error as { code?: string }).code === "23505" && !row.public_slug) {
      slug = buildPublicSlug(row.name);
      continue;
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ error: "Could not allocate a share link" }, { status: 500 });
}
