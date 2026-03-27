// Extraction service — Phase 3
// Runs the full extraction pipeline for a single raw_entry:
//   1. Call Gemini to extract proposed nodes
//   2. Write ai_run record
//   3. Write proposed_nodes
//   4. Update raw_entry status
// Returns the saved proposed nodes on success.
// On failure, marks the raw_entry as failed and stores the error — never throws to the caller.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProvider } from "./index";
import { AI_CONFIDENCE, AI_INGESTION } from "./config";
import type { ProposedNode } from "@/types/ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionSuccess {
  ok: true;
  aiRunId: string;
  proposedNodes: ProposedNode[];
}

export interface ExtractionFailure {
  ok: false;
  error: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

// ---------------------------------------------------------------------------
// runExtraction
// ---------------------------------------------------------------------------

export async function runExtraction(params: {
  rawEntryId: string;
  rawText: string;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  retryCount?: number;
}): Promise<ExtractionResult> {
  const { rawEntryId, rawText, workspaceId, userId, supabase } = params;

  // Mark raw_entry as processing
  await supabase
    .from("raw_entries")
    .update({ status: "processing" })
    .eq("id", rawEntryId);

  let providerResult;
  try {
    providerResult = await aiProvider().extractNodes({
      raw_text: rawText,
      workspace_id: workspaceId,
      user_id: userId,
    });
  } catch (err) {
    const errorText =
      err instanceof Error ? err.message : "Unknown extraction error";
    await markFailed(supabase, rawEntryId, errorText);
    return { ok: false, error: errorText };
  }

  const { output, run } = providerResult;

  // Persist ai_run
  const { data: aiRunRow, error: aiRunError } = await supabase
    .from("ai_runs")
    .insert({
      ...run,
      user_id: userId,
      workspace_id: workspaceId,
    })
    .select("id")
    .single();

  if (aiRunError || !aiRunRow) {
    const errorText = aiRunError?.message ?? "Failed to save ai_run";
    await markFailed(supabase, rawEntryId, errorText);
    return { ok: false, error: errorText };
  }

  const aiRunId: string = aiRunRow.id;

  // Filter out low-confidence proposals
  const qualifiedNodes = output.proposed_nodes.filter(
    (n) => n.extraction_confidence >= AI_CONFIDENCE.EXTRACTION_MIN
  );

  if (qualifiedNodes.length === 0) {
    // No usable proposals — still mark as completed (not failed)
    await supabase
      .from("raw_entries")
      .update({ status: "completed" })
      .eq("id", rawEntryId);

    return { ok: true, aiRunId, proposedNodes: [] };
  }

  // Persist proposed_nodes
  const rows = qualifiedNodes.map((n) => ({
    raw_entry_id: rawEntryId,
    workspace_id: workspaceId,
    user_id: userId,
    ai_run_id: aiRunId,
    proposed_title: n.proposed_title,
    proposed_summary: n.proposed_summary ?? null,
    proposed_node_type: n.proposed_node_type,
    extraction_confidence: n.extraction_confidence,
    source_span: n.source_span ?? null,
    proposal_status: "pending_review",
  }));

  const { data: savedNodes, error: nodesError } = await supabase
    .from("proposed_nodes")
    .insert(rows)
    .select();

  if (nodesError || !savedNodes) {
    const errorText = nodesError?.message ?? "Failed to save proposed_nodes";
    await markFailed(supabase, rawEntryId, errorText);
    return { ok: false, error: errorText };
  }

  // Mark raw_entry completed
  await supabase
    .from("raw_entries")
    .update({ status: "completed" })
    .eq("id", rawEntryId);

  return {
    ok: true,
    aiRunId,
    proposedNodes: savedNodes as ProposedNode[],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function markFailed(
  supabase: SupabaseClient,
  rawEntryId: string,
  errorText: string
) {
  const { data } = await supabase
    .from("raw_entries")
    .select("retry_count")
    .eq("id", rawEntryId)
    .single();

  await supabase
    .from("raw_entries")
    .update({
      status: "failed",
      error_message: errorText.slice(0, 1000),
      retry_count: ((data?.retry_count as number) ?? 0) + 1,
    })
    .eq("id", rawEntryId);
}

// ---------------------------------------------------------------------------
// Chunk large inputs
// ---------------------------------------------------------------------------

export function chunkText(
  text: string,
  maxChars = AI_INGESTION.MAX_CHARS
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  // Split on paragraph boundaries where possible
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}
