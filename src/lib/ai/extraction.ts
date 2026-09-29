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
import { retrieveRelevantNodes, type ContextNodeForPrompt } from "./retrieval";
import { resolveProposalsAgainstGraph, type ResolutionMatch } from "./resolution";
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
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// The extraction rubric is identical for every dump app-wide and the prompt
// cache is shared across the API org, so caching it is a traffic question:
// a 1h cache write costs 2× and every read 0.1×, which wins once dumps arrive
// ~3 an hour. Below that the write is wasted, so the rubric goes uncached.
const RUBRIC_CACHE_MIN_RECENT_EXTRACTIONS = 2;

async function chooseRubricCacheTtl(): Promise<"1h" | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await admin
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("run_type", "extract")
    .like("prompt_version", "extract-v%") // full-rubric runs only, not light ones
    .gte("created_at", since);
  if (error) return null;
  return (count ?? 0) >= RUBRIC_CACHE_MIN_RECENT_EXTRACTIONS ? "1h" : null;
}

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
  // Proposals that closely match an existing node the resolver couldn't rule
  // on (e.g. an abbreviation). Held for review — never auto-applied.
  possibleDuplicates: Array<{ localRef: string; existingNodeId: string; existingTitle: string }>;
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
// rehomeResolvedProposals — after duplicates are dropped, rewrite every
// reference that pointed at a dropped proposal:
//   • dropped as a copy of an EXISTING node → children attach to that node
//     (existing_parent_node_id); deps/links to it are removed
//   • dropped as a copy of another proposal in this dump → references point at
//     the kept copy; a kept node whose parent WAS its dropped twin inherits the
//     twin's place in the tree (never points at itself)
// A node ends with at most one parent (same-dump parent wins), and existing
// parent ids are validated against the workspace's active nodes. Pure.
// ---------------------------------------------------------------------------

type ExtractedProposal = ExtractionOutput["proposed_nodes"][number];

export function rehomeResolvedProposals(params: {
  nodes: ExtractedProposal[];
  droppedProposals: ExtractedProposal[];
  droppedRefToExistingId: Map<string, string>;
  droppedRefToKeptRef: Map<string, string>;
  validExistingParentIds: Set<string>;
}): ExtractedProposal[] {
  const { droppedRefToExistingId, droppedRefToKeptRef, validExistingParentIds } = params;
  const droppedByRef = new Map(
    params.droppedProposals.flatMap((n) => (n.local_ref ? [[n.local_ref, n] as const] : [])),
  );
  const isDropped = (ref: string | null | undefined) =>
    !!ref && (droppedRefToExistingId.has(ref) || droppedRefToKeptRef.has(ref));
  const remapRef = (ref: string, selfRef: string | null): string | null => {
    if (droppedRefToExistingId.has(ref)) return null;
    const target = droppedRefToKeptRef.get(ref) ?? ref;
    return target === selfRef ? null : target;
  };

  return params.nodes.map((node) => {
    let existingParentId = node.existing_parent_node_id;
    let parentLocalRef = node.primary_parent_local_ref;
    if (parentLocalRef && droppedRefToExistingId.has(parentLocalRef)) {
      existingParentId = droppedRefToExistingId.get(parentLocalRef) ?? null;
      parentLocalRef = null;
    } else if (parentLocalRef && droppedRefToKeptRef.has(parentLocalRef)) {
      const droppedTwin = droppedByRef.get(parentLocalRef);
      parentLocalRef = remapRef(parentLocalRef, node.local_ref);
      if (parentLocalRef === null && droppedTwin) {
        parentLocalRef =
          droppedTwin.primary_parent_local_ref &&
          !isDropped(droppedTwin.primary_parent_local_ref) &&
          droppedTwin.primary_parent_local_ref !== node.local_ref
            ? droppedTwin.primary_parent_local_ref
            : null;
        existingParentId = existingParentId ?? droppedTwin.existing_parent_node_id ?? null;
      }
    }
    const dependsOn = [
      ...new Set(
        (node.depends_on_local_refs ?? [])
          .map((ref) => remapRef(ref, node.local_ref))
          .filter((ref): ref is string => ref !== null),
      ),
    ];
    const softLinks = (node.soft_links ?? []).flatMap((link) => {
      const target = remapRef(link.target_local_ref, node.local_ref);
      return target ? [{ ...link, target_local_ref: target }] : [];
    });
    return {
      ...node,
      primary_parent_local_ref: parentLocalRef,
      depends_on_local_refs: dependsOn,
      soft_links: softLinks,
      existing_parent_node_id:
        parentLocalRef === null && existingParentId && validExistingParentIds.has(existingParentId)
          ? existingParentId
          : null,
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
  // The user's local date (YYYY-MM-DD) — resolves relative deadlines.
  today?: string;
  // Client cancel: aborts the provider call and skips retries.
  signal?: AbortSignal;
}): Promise<ExtractionResult> {
  const { rawEntryId, rawText, workspaceId, userId, supabase, today, signal } = params;
  // What the model sees: persona/workspace text + the existing nodes RELEVANT
  // to this dump (retrieval), each with its parent. activeNodes feeds the
  // exact-title dedup + parent validation (whole workspace).
  let context: {
    workspaceContext: string | undefined;
    promptNodes: ContextNodeForPrompt[];
    activeNodes: Array<{ id: string; title: string }>;
    parentOf: Map<string, string>;
  } = { workspaceContext: undefined, promptNodes: [], activeNodes: [], parentOf: new Map() };

  // Mark raw_entry as processing — in the same round trip as the context reads.
  const markProcessing = supabase
    .from("raw_entries")
    .update({ status: "processing" })
    .eq("id", rawEntryId);

  let providerResult;
  try {
    const rubricCacheTtl = chooseRubricCacheTtl().catch(() => null);
    const [, profile, parentOf] = await Promise.all([
      markProcessing,
      buildWorkspaceProfileContext({
        workspaceId,
        userId,
        supabase,
        includeAnchors: false,
      }),
      loadParentMap(supabase, workspaceId, userId),
    ]);
    const retrieval = await retrieveRelevantNodes({
      supabase,
      userId,
      workspaceId,
      rawText,
      nodes: profile.activeNodes,
      parentOf,
      rootNodeId: profile.rootNodeId,
    });
    console.log("[extraction] retrieval", retrieval.stats);
    context = {
      workspaceContext: profile.workspaceContext,
      promptNodes: retrieval.contextNodes,
      activeNodes: profile.activeNodes,
      parentOf,
    };
    // Short update dumps take the light path (slim prompt on Haiku). If its
    // output is malformed, the retry falls back to the full prompt.
    let variant: "full" | "light" =
      rawText.trim().length <= AI_INGESTION.LIGHT_DUMP_MAX_CHARS ? "light" : "full";
    const rubric_cache_ttl = variant === "full" ? await rubricCacheTtl : null;

    providerResult = await executeWithRetry({
      maxRetries: AI_INGESTION.EXTRACTION_MAX_RETRIES,
      operation: () =>
        aiProvider().extractNodes({
          raw_text: rawText,
          workspace_id: workspaceId,
          user_id: userId,
          workspace_context: context.workspaceContext,
          existing_nodes: context.promptNodes,
          today,
          signal,
          rubric_cache_ttl,
          variant,
        }),
      shouldRetry: ({ attempt, error }) => {
        // A user cancel is final — never spend another call retrying it.
        if (signal?.aborted) {
          return false;
        }
        if (!error.retryable) {
          return false;
        }

        if (error.code === "malformed_output") {
          if (variant === "light") {
            variant = "full";
            return true;
          }
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

  // Dedup + parent-reference validation run against ALL active workspace nodes
  // (already loaded with the profile — no second query), not just the nodes the
  // model saw.
  const allActiveNodes = context.activeNodes;
  const validExistingParentIds = new Set(allActiveNodes.map((node) => node.id));

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
  for (const n of allActiveNodes) {
    const fp = normalizeTitle(n.title);
    // First writer wins — stable and good enough for a dedup key.
    if (fp.length > 0 && !existingTitleFingerprints.has(fp)) {
      existingTitleFingerprints.set(fp, n.id);
    }
  }

  // Filter out low-confidence proposals AND near-duplicates of EXISTING nodes
  // (whole workspace, not just anchors). When a proposal's normalized title
  // matches an existing node's, we drop the proposal — the existing node already
  // represents that intent, and a parallel one fragments the graph. We remember
  // each dropped proposal's local_ref → the existing node id, so any child that
  // was going to nest under the duplicate re-homes onto the REAL existing node
  // instead of being orphaned (this is what "add the belongs-to nodes" should do
  // when the parent already exists — journal #20).
  let droppedDuplicateCount = 0;
  const droppedRefToExistingId = new Map<string, string>();

  const confidentSurvivors = output.proposed_nodes
    .filter((n) => n.extraction_confidence >= AI_CONFIDENCE.EXTRACTION_MIN)
    .filter((n) => {
      const fp = normalizeTitle(n.proposed_title);
      if (fp.length === 0) return true; // edge case: empty after stopwords
      const existingId = existingTitleFingerprints.get(fp);
      if (existingId) {
        droppedDuplicateCount++;
        if (n.local_ref) droppedRefToExistingId.set(n.local_ref, existingId);
        return false;
      }
      return true;
    });

  // Semantic resolution: catch PARAPHRASED duplicates the exact-title pass
  // can't ("Maintain Interview Readiness" vs existing "Interview Readiness").
  // Embeddings find candidates; the contrastive rule (resolution.ts, calibrated
  // on real data) decides. Best-effort: without embeddings we keep going.
  let semanticDroppedCount = 0;
  let intraDroppedCount = 0;
  // Same item emitted twice in THIS dump: dropped local_ref → kept local_ref.
  const droppedRefToKeptRef = new Map<string, string>();
  let possibleDuplicates: ExtractionSuccess["possibleDuplicates"] = [];
  // A node's identity is its PATH (parent › title): "Choose Stack…" under
  // Gym App and under Student Tracker are two different tasks.
  const activeTitleById = new Map(allActiveNodes.map((n) => [n.id, n.title]));
  const proposalTitleByRef = new Map(
    confidentSurvivors.flatMap((n) => (n.local_ref ? [[n.local_ref, n.proposed_title] as const] : [])),
  );
  try {
    const resolution = await resolveProposalsAgainstGraph({
      proposals: confidentSurvivors.flatMap((n) =>
        n.local_ref
          ? [
              {
                local_ref: n.local_ref,
                proposed_title: n.proposed_title,
                proposed_summary: n.proposed_summary ?? null,
                proposed_node_type: n.proposed_node_type,
                parent_title:
                  (n.primary_parent_local_ref
                    ? proposalTitleByRef.get(n.primary_parent_local_ref)
                    : n.existing_parent_node_id
                      ? activeTitleById.get(n.existing_parent_node_id)
                      : null) ?? null,
              },
            ]
          : [],
      ),
      userId,
      workspaceId,
      supabase,
      existingParentTitle: (nodeId) => {
        const parentId = context.parentOf.get(nodeId);
        return parentId ? (activeTitleById.get(parentId) ?? null) : null;
      },
    });
    for (const [localRef, match] of resolution.duplicates) {
      droppedRefToExistingId.set(localRef, match.existingId);
      semanticDroppedCount++;
      console.log(
        `[extraction] semantic duplicate: "${confidentSurvivors.find((n) => n.local_ref === localRef)?.proposed_title}" = existing "${match.existingTitle}" (${match.similarity.toFixed(3)}; ${match.reason})`,
      );
    }
    // Intra-dump copies: drop the later one and point its references at the
    // kept one — or at the existing node the kept one already resolved to.
    for (const [droppedRef, keptRef] of resolution.intraDuplicates) {
      if (droppedRefToExistingId.has(droppedRef)) continue;
      const keptExistingId = droppedRefToExistingId.get(keptRef);
      if (keptExistingId) {
        droppedRefToExistingId.set(droppedRef, keptExistingId);
        semanticDroppedCount++;
      } else {
        droppedRefToKeptRef.set(droppedRef, keptRef);
        intraDroppedCount++;
      }
      const byRef = (ref: string) => confidentSurvivors.find((n) => n.local_ref === ref)?.proposed_title;
      console.log(
        `[extraction] intra-dump duplicate: "${byRef(droppedRef)}" = "${byRef(keptRef)}" (kept the earlier)`,
      );
    }
    possibleDuplicates = [...resolution.possibleDuplicates.entries()]
      .filter(([localRef]) => !resolution.duplicates.has(localRef) && !droppedRefToKeptRef.has(localRef))
      .map(([localRef, match]: [string, ResolutionMatch]) => ({
        localRef,
        existingNodeId: match.existingId,
        existingTitle: match.existingTitle,
      }));
  } catch (err) {
    console.warn(
      "[extraction] semantic resolution unavailable — exact-title dedup only:",
      err instanceof Error ? err.message : err,
    );
  }
  const isDropped = (ref: string | null | undefined) =>
    !!ref && (droppedRefToExistingId.has(ref) || droppedRefToKeptRef.has(ref));
  const resolvedSurvivors = confidentSurvivors.filter((n) => !isDropped(n.local_ref));
  // A dropped duplicate the model meant to create as an already-done milestone
  // ("got my first V7 today" when that goal exists) → complete the EXISTING node.
  const completeExistingNodeIds = new Set(output.complete_existing_node_ids ?? []);
  for (const localRef of output.auto_complete_local_refs ?? []) {
    const existingId = droppedRefToExistingId.get(localRef);
    if (existingId) completeExistingNodeIds.add(existingId);
  }

  // enrich first (attaches parent-less nodes to a likely existing anchor), then
  // apply duplicate re-homing LAST so it takes precedence over enrich's guess,
  // and validate every existing-parent reference against the full node set.
  const qualifiedNodes = rehomeResolvedProposals({
    nodes: enrichExistingParentAssignments(resolvedSurvivors, context.promptNodes),
    droppedProposals: confidentSurvivors.filter((n) => isDropped(n.local_ref)),
    droppedRefToExistingId,
    droppedRefToKeptRef,
    validExistingParentIds,
  });

  if (droppedDuplicateCount + semanticDroppedCount + intraDroppedCount > 0) {
    console.log(
      `[extraction] dropped duplicates — ${droppedDuplicateCount} exact + ${semanticDroppedCount} semantic (vs existing nodes), ${intraDroppedCount} within this dump`,
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
      completeExistingNodeIds: [...completeExistingNodeIds],
      autoCompleteLocalRefs: [],
      possibleDuplicates: [],
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
    proposed_body: n.proposed_body ?? null,
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

  // Same fallback for proposed_body — the migration that adds it may not
  // have run yet on every environment, so we drop the column and retry
  // rather than erroring out.
  if (nodesError && isMissingColumnError(nodesError.message, "proposed_body")) {
    const fallbackRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "proposed_body")
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
    completeExistingNodeIds: [...completeExistingNodeIds],
    // Only refs that still exist as proposals (a dropped duplicate's
    // completion was redirected to the existing node above).
    autoCompleteLocalRefs: [
      ...new Set(
        (output.auto_complete_local_refs ?? [])
          .filter((ref) => !droppedRefToExistingId.has(ref))
          .map((ref) => droppedRefToKeptRef.get(ref) ?? ref),
      ),
    ],
    possibleDuplicates,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// child → parent over active belongs_to edges (retrieval uses it to show each
// node's place in the tree). Best-effort: an empty map just means no paths.
async function loadParentMap(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("edge_type", "belongs_to")
    .eq("status", "active");
  const parentOf = new Map<string, string>();
  for (const edge of (data ?? []) as Array<{ source_node_id: string; target_node_id: string }>) {
    if (!parentOf.has(edge.source_node_id)) parentOf.set(edge.source_node_id, edge.target_node_id);
  }
  return parentOf;
}

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
