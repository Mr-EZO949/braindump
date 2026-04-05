// POST /api/nodes/embed
// Queues embedding backfills for accepted nodes that are missing them.
// Also accepts an optional node_id to re-embed a single specific node.

import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { drainAIJobsWithAdminClient, enqueueAIJob } from "@/lib/ai/jobs";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { AI_FLAGS } from "@/lib/ai/config";

export async function POST(req: NextRequest) {
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

  let body: { node_id?: string; workspace_id?: string } = {};
  try {
    body = await req.json() as { node_id?: string; workspace_id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Single node re-embed
  if (body.node_id) {
    const { data: node, error } = await supabase
      .from("nodes")
      .select("id, title, summary, workspace_id")
      .eq("id", body.node_id)
      .eq("user_id", user.id)
      .single();

    if (error || !node) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }

    const result = await generateAndStoreEmbedding({
      nodeId: node.id as string,
      title: node.title as string,
      summary: node.summary as string | null,
      workspaceId: node.workspace_id as string,
      userId: user.id,
      supabase,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ embedded: 1, node_id: node.id });
  }

  // Workspace backfill
  if (!body.workspace_id) {
    return NextResponse.json(
      { error: "Provide either node_id or workspace_id" },
      { status: 400 }
    );
  }

  // Verify workspace belongs to this user
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", body.workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  const job = await enqueueAIJob({
    supabase,
    userId: user.id,
    workspaceId: body.workspace_id,
    jobType: "embedding_backfill",
    payload: {
      workspace_id: body.workspace_id,
    },
  });

  after(async () => {
    try {
      await drainAIJobsWithAdminClient();
    } catch (error) {
      console.error("[api/nodes/embed] failed to drain AI jobs:", error);
    }
  });

  return NextResponse.json({
    queued: true,
    job_id: job.id,
    job_status: job.status,
  });
}
