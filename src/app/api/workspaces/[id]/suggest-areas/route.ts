// POST /api/workspaces/[id]/suggest-areas
// Haiku infers 3–6 life/work AREAS from the bootstrap dump (+ role + focus) so
// the wizard's step 2 can pre-fill an editable list. These become the branch
// skeleton the rest of the graph hangs off. The inference itself lives in
// lib/ai/areas.ts so /api/entries can reuse it for normal dumps. Fail-soft:
// any error → empty array, so the user just adds areas manually.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { suggestAreas } from "@/lib/ai/areas";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await params; // workspace id not needed for inference, but keep the route shape
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
  const { bootstrap_dump, role, success_title } = (body ?? {}) as {
    bootstrap_dump?: string | null;
    role?: string | null;
    success_title?: string | null;
  };

  const result = await suggestAreas({
    dump: bootstrap_dump,
    role,
    focus: success_title,
    usageScope: { supabase, userId: user.id, workspaceId: null },
  });
  return NextResponse.json(result);
}
