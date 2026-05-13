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
import { AI_CONFIDENCE, AI_INGESTION, AI_MODELS } from "./config";
import type { ExtractionOutput, ProposedNode } from "@/types/ai";
import { buildWorkspaceProfileContext } from "./workspace-profile";
import {
  isGenericRootTitle,
  pickExistingParentForNode,
} from "@/lib/graph/anchor-attachment";
import { EXTRACT_PROMPT_VERSION } from "./prompts/extract";
import {
  executeWithRetry,
  hashText,
  logFailedAIRun,
  logMalformedOutputFailure,
  normalizeAIError,
  isMalformedAIResponseError,
} from "./errors";
import { persistAIRun } from "./telemetry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionSuccess {
  ok: true;
  aiRunId: string;
  proposedNodes: ProposedNode[];
  clarifyingQuestions: string[];
  // Existing workspace nodes the user reported as done in this dump.
  // Caller (entries route) is responsible for applying status → completed.
  completeExistingNodeIds: string[];
  // local_refs of newly-proposed nodes that should be created as
  // already-completed (e.g. milestone the user just hit with no
  // matching pre-existing anchor).
  autoCompleteLocalRefs: string[];
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

    providerResult = await executeWithRetry({
      maxRetries: AI_INGESTION.EXTRACTION_MAX_RETRIES,
      operation: () =>
        aiProvider().extractNodes({
          raw_text: rawText,
          workspace_id: workspaceId,
          user_id: userId,
          workspace_context: workspaceProfile.workspaceContext,
          existing_nodes: workspaceProfile.existingNodes,
        }),
      shouldRetry: ({ attempt, error }) => {
        if (!error.retryable) {
          return false;
        }

        if (error.code === "malformed_output") {
          return attempt < 1;
        }

        return true;
      },
      onRetry: async ({ attempt, error }) => {
        await logFailedAIRun({
          supabase,
          userId,
          workspaceId,
          runType: "extract",
          provider: "claude",
          modelName: AI_MODELS.CLAUDE_SONNET,
          promptVersion: EXTRACT_PROMPT_VERSION,
          inputHash: hashText(rawText),
          status: "retrying",
          error: `Attempt ${attempt + 1} failed: ${error.message}`,
        });
      },
    });
  } catch (err) {
    const normalized = normalizeAIError(err, "Extraction failed");
    const errorText = normalized.message;
    if (isMalformedAIResponseError(err)) {
      await logMalformedOutputFailure({
        supabase,
        userId,
        workspaceId,
        error: err,
        linkedEntityIds: [rawEntryId],
      });
    } else {
      await logFailedAIRun({
        supabase,
        userId,
        workspaceId,
        runType: "extract",
        provider: "claude",
        modelName: AI_MODELS.CLAUDE_SONNET,
        promptVersion: EXTRACT_PROMPT_VERSION,
        inputHash: hashText(rawText),
        status: "failed",
        error: errorText,
      });
    }
    await markFailed(supabase, rawEntryId, errorText);
    return { ok: false, error: normalized.userMessage };
  }

  const { output, run } = providerResult;
  const validExistingParentIds = new Set(workspaceProfile.existingNodes.map((node) => node.id));

  // Persist ai_run
  const aiRunId = await persistAIRun({
    supabase,
    userId,
    workspaceId,
    source: "extraction",
    run,
  });

  if (!aiRunId) {
    const errorText = "Failed to save ai_run";
    await markFailed(supabase, rawEntryId, errorText);
    return { ok: false, error: errorText };
  }

  // Title-normalization helper for dedupe — strips case, punctuation, and
  // common stopwords so "Ship a 3-year team strategy doc" and "Ship 3-Year
  // Team Strategy Doc" land on the same fingerprint. Doesn't catch
  // semantic paraphrases ("V7 climbing goal" vs "Send first V7 outdoor"),
  // those need embedding similarity — but it kills the literal duplicates
  // that the AI keeps inventing despite the prompt's no-duplicate rule.
  const STOPWORDS = new Set([
    "a", "an", "the", "of", "for", "to", "in", "on", "at", "by", "with",
    "and", "or", "my", "this", "that",
  ]);
  const normalizeTitle = (title: string): string => {
    return title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok))
      .sort()
      .join(" ");
  };
  const existingTitleFingerprints = new Map<string, string>(); // fp → existing node id
  for (const n of workspaceProfile.existingNodes) {
    existingTitleFingerprints.set(normalizeTitle(n.title), n.id);
  }

  // Filter out low-confidence proposals AND near-duplicates of existing
  // anchors. When a proposal's normalized title matches an existing node's,
  // we drop the proposal entirely — the existing node already represents
  // that intent, and creating a parallel one fragments the graph.
  let droppedDuplicateCount = 0;
  const qualifiedNodes = enrichExistingParentAssignments(
    output.proposed_nodes
    .filter((n) => n.extraction_confidence >= AI_CONFIDENCE.EXTRACTION_MIN)
    .filter((n) => {
      const fp = normalizeTitle(n.proposed_title);
      if (fp.length === 0) return true; // edge case: empty after stopwords
      const existingId = existingTitleFingerprints.get(fp);
      if (existingId) {
        droppedDuplicateCount++;
        return false;
      }
      return true;
    })
    .map((node) => ({
      ...node,
      existing_parent_node_id:
        node.existing_parent_node_id && validExistingParentIds.has(node.existing_parent_node_id)
          ? node.existing_parent_node_id
          : null,
    })),
    workspaceProfile.existingNodes,
  );

  if (droppedDuplicateCount > 0) {
    console.log(
      `[extraction] dropped ${droppedDuplicateCount} duplicate proposal${droppedDuplicateCount === 1 ? "" : "s"} (matched existing workspace anchor titles)`,
    );
  }

  if (qualifiedNodes.length === 0) {
    // No usable proposals — still mark as completed (not failed)
    await supabase
      .from("raw_entries")
      .update({ status: "completed" })
      .eq("id", rawEntryId);

    return {
      ok: true,
      aiRunId,
      proposedNodes: [],
      clarifyingQuestions: output.clarifying_questions ?? [],
      completeExistingNodeIds: output.complete_existing_node_ids ?? [],
      autoCompleteLocalRefs: output.auto_complete_local_refs ?? [],
    };
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
    proposed_target_date: n.proposed_target_date ?? null,
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
    clarifyingQuestions: output.clarifying_questions ?? [],
    completeExistingNodeIds: output.complete_existing_node_ids ?? [],
    autoCompleteLocalRefs: output.auto_complete_local_refs ?? [],
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
