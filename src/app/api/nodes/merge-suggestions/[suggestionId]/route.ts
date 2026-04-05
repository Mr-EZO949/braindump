// PATCH /api/nodes/merge-suggestions/[suggestionId] — Phase 11.3
// Dismiss or suppress a merge suggestion.
//
// Body: { status: 'dismissed' | 'never' }
//   - dismissed: user reviewed and chose to keep both (temporary)
//   - never: suppress this pair forever (stored, never shown again)

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ suggestionId: string }> },
) {
  const { suggestionId } = await params;

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

  const { status } = body as { status?: string };

  if (status !== "dismissed" && status !== "never") {
    return NextResponse.json(
      { error: "status must be 'dismissed' or 'never'" },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("merge_suggestions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status });
}
