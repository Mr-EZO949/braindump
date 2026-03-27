// Embedding service for Phase 4.
// Generates, stores, and retrieves node embeddings.
// Failures are caught per-node — never block node acceptance.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider } from "@/lib/ai/index";
import { AI_FLAGS, AI_MODELS, AI_CANDIDATES } from "@/lib/ai/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbedNodeParams {
  nodeId: string;
  title: string;
  summary: string | null;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}

export interface MatchNodesParams {
  queryText: string;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  excludeNodeId?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export interface MatchedNode {
  node_id: string;
  title: string;
  node_type: string;
  summary: string | null;
  similarity: number;
}

export type EmbedResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// generateAndStoreEmbedding
// Embeds a node's title + summary and upserts into node_embeddings.
// Safe to call after node acceptance — catches all errors internally.
// ---------------------------------------------------------------------------

export async function generateAndStoreEmbedding(
  params: EmbedNodeParams
): Promise<EmbedResult> {
  if (!AI_FLAGS.EMBEDDING_ENABLED) {
    return { ok: false, error: "Embedding disabled" };
  }

  const { nodeId, title, summary, workspaceId, userId, supabase } = params;

  const inputText = [title, summary].filter(Boolean).join("\n").trim();
  if (!inputText) {
    return { ok: false, error: "Empty input text" };
  }

  let embeddingVector: number[];
  try {
    const result = await aiProvider().generateEmbedding({ text: inputText });
    embeddingVector = result.output.embedding;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Embedding generation failed",
    };
  }

  const { error: upsertError } = await supabase
    .from("node_embeddings")
    .upsert(
      {
        node_id: nodeId,
        user_id: userId,
        workspace_id: workspaceId,
        embedding: JSON.stringify(embeddingVector),
        model: AI_MODELS.GEMINI_EMBEDDING,
        embedded_at: new Date().toISOString(),
      },
      { onConflict: "node_id" }
    );

  if (upsertError) {
    return { ok: false, error: upsertError.message };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// matchNodes
// Embeds a query string then calls the match_nodes RPC.
// Returns similar nodes sorted by cosine similarity descending.
// ---------------------------------------------------------------------------

export async function matchNodes(
  params: MatchNodesParams
): Promise<MatchedNode[]> {
  const {
    queryText,
    workspaceId,
    userId,
    supabase,
    excludeNodeId,
    includeCompleted = false,
    limit = AI_CANDIDATES.RETRIEVAL_K,
  } = params;

  const result = await aiProvider().generateEmbedding({ text: queryText });

  const { data, error } = await supabase.rpc("match_nodes", {
    query_embedding: JSON.stringify(result.output.embedding),
    match_user_id: userId,
    match_workspace_id: workspaceId,
    match_count: limit,
    exclude_node_id: excludeNodeId ?? null,
    include_completed: includeCompleted,
  });

  if (error) throw new Error(`match_nodes RPC failed: ${error.message}`);

  return (data ?? []) as MatchedNode[];
}

// ---------------------------------------------------------------------------
// backfillEmbeddings
// Finds accepted nodes in a workspace with no embedding and embeds them.
// Returns counts of successes and failures.
// ---------------------------------------------------------------------------

export async function backfillEmbeddings(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  limit?: number;
}): Promise<{ embedded: number; failed: number; skipped: number }> {
  if (!AI_FLAGS.EMBEDDING_ENABLED) {
    return { embedded: 0, failed: 0, skipped: 0 };
  }

  const { workspaceId, userId, supabase, limit = 50 } = params;

  // Find which nodes already have embeddings
  const { data: existing } = await supabase
    .from("node_embeddings")
    .select("node_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);

  const alreadyEmbedded = new Set((existing ?? []).map((r) => r.node_id as string));

  // Find active nodes in this workspace
  const { data: nodes, error } = await supabase
    .from("nodes")
    .select("id, title, summary")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(limit);

  if (error || !nodes) return { embedded: 0, failed: 0, skipped: 0 };

  const toEmbed = nodes.filter((n) => !alreadyEmbedded.has(n.id as string));
  if (toEmbed.length === 0) return { embedded: 0, failed: 0, skipped: nodes.length };

  let embedded = 0;
  let failed = 0;

  for (const node of toEmbed) {
    const result = await generateAndStoreEmbedding({
      nodeId: node.id as string,
      title: node.title as string,
      summary: node.summary as string | null,
      workspaceId,
      userId,
      supabase,
    });
    if (result.ok) embedded++;
    else failed++;
  }

  return { embedded, failed, skipped: 0 };
}
