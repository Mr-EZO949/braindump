// POST /api/entries — intake route for raw brain dumps
// Saves the raw text, runs extraction, returns proposed nodes.
// All AI work happens server-side. Keys are never exposed to the client.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestToday } from "@/lib/time/request-date";
import { runExtraction } from "@/lib/ai/extraction";
import { loadCalibrationStats, selectAutoApply } from "@/lib/ai/auto-apply";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { suggestAreas } from "@/lib/ai/areas";
import { classifyDumpSize } from "@/lib/ai/dump-size";
import { AI_INGESTION, AI_FLAGS, AI_RATE_LIMITS } from "@/lib/ai/config";
import { checkEntryRateLimit, rateLimitResponse } from "@/lib/ai/rate-limit";
import type { RawEntrySourceType } from "@/types/ai";

const VALID_SOURCE_TYPES: RawEntrySourceType[] = [
  "brain_dump",
  "assistant_save",
  "voice",
  "planner_convert",
];

// GET /api/entries/history?workspace_id=<uuid> — list a workspace's past brain
// dumps, newest first, for the dump-history view. raw_text is stored in full.
export async function GET(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaceId = req.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  // RLS gates user_id; this verifies the workspace belongs to the user too.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("raw_entries")
    .select("id, raw_text, source_type, status, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }

  return NextResponse.json({ entries: data ?? [] });
}

export async function POST(req: NextRequest) {
  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ---------------------------------------------------------------------------
  // Parse and validate body
  // ---------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).raw_text !== "string" ||
    typeof (body as Record<string, unknown>).workspace_id !== "string"
  ) {
    return NextResponse.json(
      { error: "Body must include raw_text (string) and workspace_id (string)" },
      { status: 400 }
    );
  }

  const {
    raw_text,
    workspace_id,
    source_type = "brain_dump",
    default_parent_node_id,
    auto_apply = true,
  } = body as {
    raw_text: string;
    workspace_id: string;
    source_type?: string;
    // Optional: when set, any extracted proposal that has no parent
    // assignment (neither existing_parent_node_id nor a primary_parent_local_ref
    // pointing at a same-dump sibling) gets this node as its parent. Used
    // by the "suggest steps" flow so the generated subtasks anchor under
    // the source node instead of falling back to the workspace root.
    default_parent_node_id?: string | null;
    // The user's "Auto-add confident items" preference (default on).
    auto_apply?: boolean;
  };

  // Empty input guard
  const trimmed = raw_text.trim();
  if (!trimmed) {
    return NextResponse.json({ error: "raw_text is empty" }, { status: 400 });
  }

  // Source type guard
  if (!VALID_SOURCE_TYPES.includes(source_type as RawEntrySourceType)) {
    return NextResponse.json(
      { error: `source_type must be one of: ${VALID_SOURCE_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  // Input size guard — reject if over limit (chunking is a future optimisation)
  if (trimmed.length > AI_INGESTION.MAX_CHARS) {
    return NextResponse.json(
      {
        error: `Input too long. Maximum ${AI_INGESTION.MAX_CHARS} characters. Got ${trimmed.length}.`,
        max_chars: AI_INGESTION.MAX_CHARS,
        received_chars: trimmed.length,
      },
      { status: 422 }
    );
  }

  // ---------------------------------------------------------------------------
  // Verify workspace belongs to user
  // ---------------------------------------------------------------------------
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json(
      { error: "Workspace not found or access denied" },
      { status: 404 }
    );
  }

  // Rate limit: max N brain dumps per hour
  const rl = await checkEntryRateLimit({
    supabase,
    userId: user.id,
    maxPerHour: AI_RATE_LIMITS.EXTRACTIONS_PER_HOUR,
  });
  if (!rl.allowed) return rateLimitResponse(rl);

  // ---------------------------------------------------------------------------
  // Save raw_entry
  // ---------------------------------------------------------------------------
  const { data: rawEntry, error: rawError } = await supabase
    .from("raw_entries")
    .insert({
      user_id: user.id,
      workspace_id,
      raw_text: trimmed,
      source_type,
      status: "pending",
    })
    .select("id")
    .single();

  if (rawError || !rawEntry) {
    return NextResponse.json(
      { error: "Failed to save raw entry", detail: rawError?.message },
      { status: 500 }
    );
  }

  // ---------------------------------------------------------------------------
  // Extraction — skip if flag is off (returns the raw_entry_id immediately)
  // ---------------------------------------------------------------------------
  if (!AI_FLAGS.EXTRACTION_ENABLED) {
    return NextResponse.json({
      raw_entry_id: rawEntry.id,
      status: "pending",
      message: "AI extraction is disabled. Enable AI_EXTRACTION_ENABLED to process.",
      proposed_nodes: [],
    });
  }

  // Depth comes from extraction itself: the Depth + project-with-parts +
  // semantic-clustering rules (prompts/extract.ts) build a real area→project→
  // task tree from the dump's own structure. We DON'T inject areas into
  // extraction — doing so made it emit the induced area AND its own parent for
  // the same domain, leaving empty area shells. Instead we infer areas in
  // PARALLEL (cheap Haiku, no added latency) purely to offer as optional review
  // chips for domains the dump didn't structure. Skipped for suggest-steps
  // roadmaps (default_parent_node_id set) — those already have a home.
  const wantAreaSuggestions = !default_parent_node_id;
  const [result, areaResult] = await Promise.all([
    runExtraction({
      rawEntryId: rawEntry.id,
      rawText: trimmed,
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
      // User's local date for "by Friday"-style deadlines (bd_tz cookie).
      today: await getRequestToday(),
      // Client cancel (e.g. the Cancel on "Generating steps…") stops the
      // Sonnet call instead of billing for it.
      signal: req.signal,
    }),
    wantAreaSuggestions
      ? suggestAreas({
          dump: trimmed,
          usageScope: { supabase, userId: user.id, workspaceId: workspace_id },
        })
      : Promise.resolve({ suggested_areas: [], suggestion_error: null }),
  ]);

  // Apply the default-parent override (e.g. from suggest-steps). Any
  // extracted proposal that ended up parent-less gets pinned under the
  // caller-supplied node. Mirrors the bootstrap orphan-anchor pattern.
  if (default_parent_node_id && result.ok) {
    await supabase
      .from("proposed_nodes")
      .update({ existing_parent_node_id: default_parent_node_id })
      .eq("raw_entry_id", rawEntry.id)
      .eq("workspace_id", workspace_id)
      .eq("user_id", user.id)
      .is("existing_parent_node_id", null)
      .is("primary_parent_local_ref", null);
    // Refresh the returned proposals so the client sees the parent set.
    const { data: refreshed } = await supabase
      .from("proposed_nodes")
      .select("*")
      .eq("raw_entry_id", rawEntry.id)
      .order("local_ref", { ascending: true });
    if (refreshed) {
      result.proposedNodes = refreshed as typeof result.proposedNodes;
    }
  }

  // Life-area chips help ONLY when extraction produced a FLAT result — a loose
  // dump with no parent/child structure that needs grouping. When extraction
  // already built a hierarchy (any node has a parent), the graph is structured
  // in the user's own words (e.g. "Get in Shape", "Make Money Fast"), and
  // offering generic area chips on top would just let the user create empty
  // duplicate branches ("Health & Fitness" next to "Get in Shape"). So we
  // suppress the chips whenever the dump already came out with depth.
  let clientAreas: typeof areaResult.suggested_areas = [];
  if (result.ok && areaResult.suggested_areas.length > 0) {
    const hasHierarchy = result.proposedNodes.some((p) => p.primary_parent_local_ref);
    if (!hasHierarchy) {
      const createdTitles = new Set(
        result.proposedNodes.map((p) => p.proposed_title.trim().toLowerCase()),
      );
      clientAreas = areaResult.suggested_areas.filter(
        (a) => !createdTitles.has(a.title.trim().toLowerCase()),
      );
    }
  }

  if (!result.ok) {
    // Extraction failed — entry is saved, user can retry
    return NextResponse.json(
      {
        raw_entry_id: rawEntry.id,
        status: "failed",
        error: result.error,
        message: "Extraction failed. You can retry via POST /api/entries/:id/retry",
      },
      { status: 207 } // 207 = partial success (entry saved, extraction failed)
    );
  }

  // Completion-detection apply step. The AI listed existing workspace
  // nodes the user reported as DONE in this dump ("did the 14k long run",
  // "shipped the redesign"). We mark each as completed via a direct
  // status update — keeps the AI from inventing retrospective event nodes.
  //
  // For auto_complete_local_refs (newly-proposed milestones to create as
  // already-done), the entries route can't apply them yet because the
  // proposed_nodes are still pending review. Instead, we stash the local
  // refs in the proposed_nodes' source_span field with a marker so the
  // acceptance route can complete them on accept. Cleaner: a dedicated
  // column, but local_ref marker keeps the migration footprint small.
  const completedExistingTitles: string[] = [];
  if (result.completeExistingNodeIds.length > 0) {
    // Verify ownership + same workspace before applying status changes —
    // the AI could (theoretically) emit a UUID from another workspace.
    const { data: ownedNodes } = await supabase
      .from("nodes")
      .select("id, title, status")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .in("id", result.completeExistingNodeIds);
    const candidates = (ownedNodes ?? []).filter(
      (n) => n.status !== "completed" && n.status !== "archived",
    );
    // Same transition as the Details button (cascades, planner sync, lifecycle
    // events) — and a HABIT the user says they did logs today instead of being
    // marked done forever. This used to be a raw status update, so "did my
    // workout today" in a dump completed the whole habit (#13 via braindump).
    const today = await getRequestToday();
    let anyStatusChanged = false;
    for (const n of candidates) {
      const outcome = await transitionNodeStatus({
        supabase,
        userId: user.id,
        workspaceId: workspace_id,
        nodeId: n.id as string,
        newStatus: "completed",
        today,
        habitSource: "dump",
        recomputeScores: false,
      });
      if (outcome.kind === "changed") anyStatusChanged = true;
      if (outcome.kind === "changed" || outcome.kind === "habit_logged") {
        completedExistingTitles.push(n.title as string);
      }
    }
    if (anyStatusChanged) {
      await computeWorkspaceScores({ workspaceId: workspace_id, userId: user.id, supabase }).catch(
        (err: unknown) => console.warn("[entries] score recompute failed:", err),
      );
    }
  }

  // Mark auto-complete proposed nodes so the acceptance route knows to
  // create them with status = completed. We piggyback on source_span:
  // the AI uses it for provenance, but we append a marker the
  // acceptance route detects + strips before persisting.
  if (result.autoCompleteLocalRefs.length > 0) {
    for (const localRef of result.autoCompleteLocalRefs) {
      await supabase
        .from("proposed_nodes")
        .update({
          source_span: "[[AUTO_COMPLETE]]",
        })
        .eq("raw_entry_id", rawEntry.id)
        .eq("local_ref", localRef);
    }
  }

  // Note: clustering runs AFTER acceptance (in proposals/nodes/review)
  // rather than here. At this point the new nodes are still proposals
  // without embeddings, so clustering wouldn't see them and would miss
  // exactly the groupings the user just dumped about.

  // Proposals that closely match an existing node the resolver couldn't rule
  // on — the review shows the hint, and they're never auto-applied.
  const possibleDuplicates = result.possibleDuplicates.flatMap((dup) => {
    const proposal = result.proposedNodes.find((p) => p.local_ref === dup.localRef);
    return proposal
      ? [
          {
            proposal_id: proposal.id,
            existing_node_id: dup.existingNodeId,
            existing_title: dup.existingTitle,
          },
        ]
      : [];
  });

  // Calibrated auto-apply (src/lib/ai/auto-apply.ts): proposals this user
  // reliably accepts skip the review modal; the client accepts them through the
  // normal review route and offers a one-tap Undo. Best-effort — on any error
  // everything simply goes to review, as before.
  let autoApplyProposalIds: string[] = [];
  if (auto_apply !== false && result.proposedNodes.length > 0) {
    try {
      const stats = await loadCalibrationStats(supabase, user.id);
      autoApplyProposalIds = selectAutoApply({
        proposals: result.proposedNodes.map((p) => ({
          id: p.id,
          local_ref: p.local_ref ?? null,
          primary_parent_local_ref: p.primary_parent_local_ref ?? null,
          existing_parent_node_id: p.existing_parent_node_id ?? null,
          proposed_node_type: p.proposed_node_type,
          extraction_confidence: p.extraction_confidence,
        })),
        heldIds: new Set(possibleDuplicates.map((d) => d.proposal_id)),
        stats,
      });
    } catch (err) {
      console.warn("[entries] auto-apply selection failed — everything goes to review:", err);
    }
  }

  return NextResponse.json({
    raw_entry_id: rawEntry.id,
    ai_run_id: result.aiRunId,
    auto_apply_proposal_ids: autoApplyProposalIds,
    status: "completed",
    proposed_nodes: result.proposedNodes,
    proposed_node_count: result.proposedNodes.length,
    clarifying_questions: result.clarifyingQuestions,
    completed_existing_node_titles: completedExistingTitles,
    auto_complete_local_refs: result.autoCompleteLocalRefs,
    // Life-area branches inferred from this dump that extraction did NOT already
    // turn into nodes — offered as optional chips in the review so the user can
    // add them as top-level branches (same as the wizard's step 2).
    suggested_areas: clientAreas,
    possible_duplicates: possibleDuplicates,
    // Dump size (by extracted node count) — surfaced to the user and available
    // for per-plan usage metering later. Detection only; no limits enforced yet.
    dump_size: {
      tier: classifyDumpSize(result.proposedNodes.length),
      node_count: result.proposedNodes.length,
    },
  });
}
