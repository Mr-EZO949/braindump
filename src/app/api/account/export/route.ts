// GET /api/account/export
//
// Returns the signed-in user's data as a single JSON document, offered as a
// download. Trust + portability: users can take their graph with them. Only
// the user's own rows are returned (RLS + explicit user_id filters).
//
// Scope: workspaces, nodes, edges, and raw brain-dump entries. Excludes
// derived/internal rows (embeddings, ai_runs, telemetry) — not useful to a
// human and potentially large.

import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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

  const [workspaces, nodes, edges, rawEntries] = await Promise.all([
    supabase.from("workspaces").select("*").eq("user_id", user.id),
    supabase.from("nodes").select("*").eq("user_id", user.id),
    supabase.from("edges").select("*").eq("user_id", user.id),
    supabase.from("raw_entries").select("*").eq("user_id", user.id),
  ]);

  const firstError =
    workspaces.error ?? nodes.error ?? edges.error ?? rawEntries.error;
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  const payload = {
    export_version: 1,
    exported_at: new Date().toISOString(),
    account: { id: user.id, email: user.email ?? null },
    workspaces: workspaces.data ?? [],
    nodes: nodes.data ?? [],
    edges: edges.data ?? [],
    raw_entries: rawEntries.data ?? [],
  };

  const filename = `braindump-export-${new Date().toISOString().slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
