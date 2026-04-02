// POST /api/nodes/analyze
// Triggers connection analysis for a set of newly-accepted nodes.
// Runs runConnectionAnalysis for each node in parallel, then returns
// the pending proposed edges involving those nodes for immediate review.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { runConnectionAnalysis, fetchPendingEdges } from "@/lib/ai/connection";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { detectDuplicates } from "@/lib/ai/merge";
import { AI_FLAGS } from "@/lib/ai/config";

export async function POST(req: NextRequest) {
  if (!AI_FLAGS.EDGE_INFERENCE_ENABLED) {
    return NextResponse.json({ proposed_edges: [], skipped: true });
  }

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { node_ids, workspace_id } = body as { node_ids?: string[]; workspace_id?: string };

  if (!Array.isArray(node_ids) || node_ids.length === 0) {
    return NextResponse.json({ error: "node_ids must be a non-empty array" }, { status: 400 });
  }
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  // Step 1: Fetch all node titles/summaries and embed them — sequentially so each
  // node is in node_embeddings before matchNodes runs on any sibling.
  // This ensures "neural nets" can find "ML class" even though both were just accepted.
  const { data: nodeRows } = await supabase
    .from("nodes")
    .select("id, title, summary")
    .in("id", node_ids)
    .eq("user_id", user.id);

  for (const node of nodeRows ?? []) {
    await generateAndStoreEmbedding({
      nodeId: node.id as string,
      title: node.title as string,
      summary: node.summary as string | null,
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
    }).catch(() => {});
  }

  // Step 2: Run connection analysis for each node in parallel — failures are per-node.
  const results = await Promise.all(
    node_ids.map((nodeId) =>
      runConnectionAnalysis({
        nodeId,
        excludeNodeIds: node_ids.filter((candidateId) => candidateId !== nodeId),
        workspaceId: workspace_id,
        userId: user.id,
        supabase,
      })
        .catch(() => ({ proposed: 0, skipped: 0, failed: 1 }))
    )
  );

  const totals = results.reduce(
    (acc, r) => ({ proposed: acc.proposed + r.proposed, skipped: acc.skipped + r.skipped, failed: acc.failed + r.failed }),
    { proposed: 0, skipped: 0, failed: 0 }
  );

  const proposed_edges = await fetchPendingEdges({
    workspaceId: workspace_id,
    userId: user.id,
    nodeIds: node_ids,
    supabase,
  });

  // Phase 6 — detect near-duplicate nodes among the newly accepted batch
  const merge_candidates = await detectDuplicates({
    newNodes: (nodeRows ?? []).map((n) => ({
      id: n.id as string,
      title: n.title as string,
      summary: n.summary as string | null,
    })),
    workspaceId: workspace_id,
    userId: user.id,
    supabase,
  });

  return NextResponse.json({ proposed_edges, merge_candidates, ...totals });
}
