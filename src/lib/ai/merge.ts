// Merge detection — Phase 11
// After a node is accepted, check for near-identical existing nodes.
// Pipeline:
//   1. Embedding similarity filter (AI_DEDUP.SIMILARITY_THRESHOLD)
//   2. Type-compatibility filter (don't suggest merging goal↔task etc.)
//   3. AI merge-check: LLM verifies "same entity?" (when AI_MERGE_SUGGESTIONS_ENABLED)
//   4. Persist passing candidates as merge_suggestions rows
// Never blocks node acceptance. All failures return empty arrays.

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchNodes } from "@/lib/ai/embeddings";
import { aiProvider } from "@/lib/ai/index";
import { AI_DEDUP, AI_FLAGS, AI_MODELS } from "@/lib/ai/config";
import { MERGE_CHECK_PROMPT_VERSION } from "@/lib/ai/prompts/merge-check";
import type { NodeType } from "@/types/graph";
import {
  hashText,
  logFailedAIRun,
  logMalformedOutputFailure,
  normalizeAIError,
  isMalformedAIResponseError,
} from "@/lib/ai/errors";
import { persistAIRun } from "@/lib/ai/telemetry";
import { normalizeNodeType } from "@/lib/graph/node-types";

// ---------------------------------------------------------------------------
// Type compatibility
// Only suggest merging nodes whose types are plausibly the same entity.
// ---------------------------------------------------------------------------

// Old graphs typed the same thing inconsistently ("Pass ML Exam" as task,
// project or goal), so big tasks are compatible with both neighbours; areas
// replaced grouping concepts and notes replaced knowledge concepts.
const COMPATIBLE_TYPES: Record<string, Set<string>> = {
  goal:     new Set(["goal", "project", "big_task", "area"]),
  project:  new Set(["project", "goal", "big_task", "task"]),
  big_task: new Set(["big_task", "task", "project", "goal"]),
  task:     new Set(["task", "big_task", "project", "idea"]),
  area:     new Set(["area", "goal", "class"]),
  class:    new Set(["class", "area"]),
  idea:     new Set(["idea", "note", "task"]),
  note:     new Set(["note", "idea"]),
  habit:    new Set(["habit", "task", "goal"]),
};

function typesAreCompatible(a: string, b: string): boolean {
  return COMPATIBLE_TYPES[a]?.has(b) ?? COMPATIBLE_TYPES[b]?.has(a) ?? true;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MergeCandidate {
  suggestion_id: string;
  new_node_id: string;
  new_node_title: string;
  new_node_summary: string | null;
  new_node_type: string;
  existing_node_id: string;
  existing_node_title: string;
  existing_node_summary: string | null;
  existing_node_type: string;
  similarity: number;
  ai_confidence: number | null;
  ai_reason: string | null;
}

// Finds existing nodes that are near-duplicates of the given new nodes.
// Returns at most one candidate per new node — the highest-similarity verified match.
export async function detectDuplicates(params: {
  newNodes: Array<{ id: string; title: string; summary: string | null; node_type?: NodeType | string }>;
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
      limit: 5,
    }).catch(() => []);

    const topMatch = matches.find(
      (m) =>
        m.similarity >= AI_DEDUP.SIMILARITY_THRESHOLD &&
        typesAreCompatible(normalizeNodeType(node.node_type), normalizeNodeType(m.node_type)),
    );

    if (!topMatch) continue;

    // AI merge check
    let aiConfidence: number | null = null;
    let aiReason: string | null = null;
    let aiRunId: string | null = null;

    try {
      const checkResult = await aiProvider().checkMerge({
        new_node: {
          title: node.title,
          summary: node.summary,
          node_type: normalizeNodeType(node.node_type),
        },
        existing_node: {
          title: topMatch.title,
          summary: topMatch.summary,
          node_type: topMatch.node_type as NodeType,
        },
        similarity: topMatch.similarity,
      });

      const { output, run: runMeta } = checkResult;

      // Only surface if AI also agrees it's the same entity
      if (!output.same_entity) continue;

      aiConfidence = output.confidence;
      aiReason = output.reason;

      // Persist ai_run (best-effort)
      aiRunId = await persistAIRun({
        supabase,
        userId,
        workspaceId,
        source: "merge-check",
        run: {
          run_type: "merge_check",
          provider: "claude",
          model_name: runMeta.model_name,
          prompt_version: MERGE_CHECK_PROMPT_VERSION,
          input_hash: runMeta.input_hash,
          output_hash: runMeta.output_hash,
          input_tokens: runMeta.input_tokens,
          output_tokens: runMeta.output_tokens,
          latency_ms: runMeta.latency_ms,
          // Priced by the provider for the model that actually ran (Haiku).
          estimated_cost: runMeta.estimated_cost,
          status: "success",
          error_text: null,
        },
      });
    } catch (err) {
      const normalized = normalizeAIError(err, "Merge check failed");
      if (isMalformedAIResponseError(err)) {
        void logMalformedOutputFailure({
          supabase,
          userId,
          workspaceId,
          error: err,
          linkedEntityIds: [node.id, topMatch.node_id],
        });
      } else {
        void logFailedAIRun({
          supabase,
          userId,
          workspaceId,
          runType: "merge_check",
          provider: "claude",
          modelName: AI_MODELS.CLAUDE_HAIKU, // checkMerge runs on Haiku
          promptVersion: MERGE_CHECK_PROMPT_VERSION,
          inputHash: hashText(`${node.title}\n${topMatch.title}`),
          error: normalized.message,
        });
      }
      // AI check failed — skip this pair (don't surface unverified suggestions)
      continue;
    }

    // Check if we already have a 'never' suppression for this pair
    const { data: existingSuppression } = await supabase
      .from("merge_suggestions")
      .select("id, status")
      .eq("workspace_id", workspaceId)
      .eq("new_node_id", node.id)
      .eq("existing_node_id", topMatch.node_id)
      .eq("status", "never")
      .maybeSingle();

    if (existingSuppression) continue;

    // Persist suggestion (upsert — if already pending, update ai fields)
    const { data: suggestionRow } = await supabase
      .from("merge_suggestions")
      .upsert(
        {
          workspace_id: workspaceId,
          user_id: userId,
          new_node_id: node.id,
          existing_node_id: topMatch.node_id,
          similarity: topMatch.similarity,
          ai_confidence: aiConfidence,
          ai_reason: aiReason,
          status: "pending",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,new_node_id,existing_node_id" },
      )
      .select("id")
      .single();

    void aiRunId; // referenced for traceability

    results.push({
      suggestion_id: suggestionRow?.id ?? crypto.randomUUID(),
      new_node_id: node.id,
      new_node_title: node.title,
      new_node_summary: node.summary,
      new_node_type: normalizeNodeType(node.node_type),
      existing_node_id: topMatch.node_id,
      existing_node_title: topMatch.title,
      existing_node_summary: topMatch.summary,
      existing_node_type: topMatch.node_type,
      similarity: topMatch.similarity,
      ai_confidence: aiConfidence,
      ai_reason: aiReason,
    });
  }

  return results;
}
