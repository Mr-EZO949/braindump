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
import type { ExtractionOutput, ProposedNode } from "@/types/ai";
import { buildWorkspaceProfileContext } from "./workspace-profile";
import {
  isGenericRootTitle,
  pickExistingParentForNode,
} from "@/lib/graph/anchor-attachment";

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

function isMissingColumnError(message: string | undefined, columnName: string) {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes("column") && normalized.includes(columnName.toLowerCase());
}

function enrichExistingParentAssignments(
  nodes: ExtractionOutput["proposed_nodes"],
  existingNodes: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: ExtractionOutput["proposed_nodes"][number]["proposed_node_type"];
  }>,
) {
  if (existingNodes.length === 0) {
    return nodes;
  }

  const existingNodeMap = new Map(existingNodes.map((node) => [node.id, node]));

  return nodes.map((node) => {
    if (node.primary_parent_local_ref) {
      return node;
    }

    const currentParent = node.existing_parent_node_id
      ? existingNodeMap.get(node.existing_parent_node_id)
      : null;
    const shouldReevaluate =
      !currentParent || isGenericRootTitle(currentParent.title);

    if (!shouldReevaluate) {
      return node;
    }

    const suggestedParentId = pickExistingParentForNode({
      child: {
        title: node.proposed_title,
        summary: node.proposed_summary,
        node_type: node.proposed_node_type,
      },
      existingNodes,
    });

    if (!suggestedParentId) {
      return node;
    }

    if (suggestedParentId === node.existing_parent_node_id) {
      return node;
    }

    return {
      ...node,
      existing_parent_node_id: suggestedParentId,
    };
  });
}

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
  let workspaceProfile: Awaited<ReturnType<typeof buildWorkspaceProfileContext>> = {
    workspaceContext: undefined,
    existingNodes: [],
  };

  // Mark raw_entry as processing
  await supabase
    .from("raw_entries")
    .update({ status: "processing" })
    .eq("id", rawEntryId);

  let providerResult;
  try {
    workspaceProfile = await buildWorkspaceProfileContext({
      workspaceId,
      userId,
      supabase,
    });

    providerResult = await aiProvider().extractNodes({
      raw_text: rawText,
      workspace_id: workspaceId,
      user_id: userId,
      workspace_context: workspaceProfile.workspaceContext,
      existing_nodes: workspaceProfile.existingNodes,
    });
  } catch (err) {
    const errorText =
      err instanceof Error ? err.message : "Unknown extraction error";
    await markFailed(supabase, rawEntryId, errorText);
    return { ok: false, error: errorText };
  }

  const { output, run } = providerResult;
  const validExistingParentIds = new Set(workspaceProfile.existingNodes.map((node) => node.id));

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
  const qualifiedNodes = enrichExistingParentAssignments(
    output.proposed_nodes
    .filter((n) => n.extraction_confidence >= AI_CONFIDENCE.EXTRACTION_MIN)
    .map((node) => ({
      ...node,
      existing_parent_node_id:
        node.existing_parent_node_id && validExistingParentIds.has(node.existing_parent_node_id)
          ? node.existing_parent_node_id
          : null,
    })),
    workspaceProfile.existingNodes,
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
    local_ref: n.local_ref,
    primary_parent_local_ref: n.primary_parent_local_ref,
    existing_parent_node_id: n.existing_parent_node_id,
    depends_on_local_refs: n.depends_on_local_refs ?? [],
    soft_links: n.soft_links ?? [],
    proposed_title: n.proposed_title,
    proposed_summary: n.proposed_summary ?? null,
    proposed_node_type: n.proposed_node_type,
    extraction_confidence: n.extraction_confidence,
    source_span: n.source_span ?? null,
    proposal_status: "pending_review",
  }));

  let { data: savedNodes, error: nodesError } = await supabase
    .from("proposed_nodes")
    .insert(rows)
    .select();

  if (nodesError && isMissingColumnError(nodesError.message, "existing_parent_node_id")) {
    const fallbackRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "existing_parent_node_id")
      )
    );
    const retry = await supabase.from("proposed_nodes").insert(fallbackRows).select();
    savedNodes = retry.data;
    nodesError = retry.error;
  }

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
    proposedNodes: (savedNodes as ProposedNode[]).map((node) => ({
      ...node,
      existing_parent_node_id:
        "existing_parent_node_id" in node ? node.existing_parent_node_id : null,
    })),
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
