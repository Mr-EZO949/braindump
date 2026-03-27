// Merge detection — Phase 6
// After a node is accepted, check if a near-identical node already exists.
// Uses cosine similarity via the match_nodes RPC — same infra as connection engine.
// Never blocks node acceptance. Failures return empty arrays.

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchNodes } from "@/lib/ai/embeddings";
import { AI_DEDUP, AI_FLAGS } from "@/lib/ai/config";

export interface MergeCandidate {
  new_node_id: string;
  new_node_title: string;
  existing_node_id: string;
  existing_node_title: string;
  existing_node_type: string;
  similarity: number;
}

// Finds existing nodes that are near-duplicates of the given new nodes.
// Returns one candidate per new node — the highest-similarity match above threshold.
export async function detectDuplicates(params: {
  newNodes: Array<{ id: string; title: string; summary: string | null }>;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<MergeCandidate[]> {
  if (!AI_FLAGS.MERGE_SUGGESTIONS_ENABLED) return [];

  const { newNodes, workspaceId, userId, supabase } = params;
  const results: MergeCandidate[] = [];

  for (const node of newNodes) {
    const queryText = [node.title, node.summary].filter(Boolean).join("\n");
    const matches = await matchNodes({
      queryText,
      workspaceId,
      userId,
      supabase,
      excludeNodeId: node.id,
      includeCompleted: false,
      limit: 3,
    }).catch(() => []);

    const topMatch = matches.find(
      (m) => m.similarity >= AI_DEDUP.SIMILARITY_THRESHOLD
    );

    if (topMatch) {
      results.push({
        new_node_id: node.id,
        new_node_title: node.title,
        existing_node_id: topMatch.node_id,
        existing_node_title: topMatch.title,
        existing_node_type: topMatch.node_type,
        similarity: topMatch.similarity,
      });
    }
  }

  return results;
}
