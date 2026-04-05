// GET /api/nodes/search?q=<query>&workspace_id=<id>&include_completed=false&limit=10
// Semantic node search using pgvector + match_nodes RPC.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { matchNodes } from "@/lib/ai/embeddings";
import { AI_FLAGS, AI_RATE_LIMITS } from "@/lib/ai/config";

export async function GET(req: NextRequest) {
  if (!AI_FLAGS.EMBEDDING_ENABLED) {
    return NextResponse.json({ error: "Embedding is disabled" }, { status: 503 });
  }

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const workspaceId = searchParams.get("workspace_id");
  const excludeNodeId = searchParams.get("exclude_node_id") ?? undefined;
  const includeCompleted = searchParams.get("include_completed") === "true";
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "10", 10), 50);

  if (!q) {
    return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
  }
  if (q.length > AI_RATE_LIMITS.SEARCH_QUERY_MAX_CHARS) {
    return NextResponse.json(
      { error: `Query too long. Maximum ${AI_RATE_LIMITS.SEARCH_QUERY_MAX_CHARS} characters.` },
      { status: 400 },
    );
  }
  if (!workspaceId) {
    return NextResponse.json({ error: "Missing 'workspace_id'" }, { status: 400 });
  }

  try {
    const results = await matchNodes({
      queryText: q,
      workspaceId,
      userId: user.id,
      supabase,
      excludeNodeId,
      includeCompleted,
      limit,
    });

    return NextResponse.json({ results, count: results.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 }
    );
  }
}
