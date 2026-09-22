// POST /api/entries — intake route for raw brain dumps
// Saves the raw text, runs extraction, returns proposed nodes.
// All AI work happens server-side. Keys are never exposed to the client.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { runExtraction } from "@/lib/ai/extraction";
import { suggestAreas } from "@/lib/ai/areas";
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

  // Run extraction and life-area inference in parallel. Area inference is the
  // same Haiku call the bootstrap wizard uses — so a NORMAL dump gets the same
  // "here are your branches" treatment. It's independent of extraction, so
  // running it concurrently adds no latency. Skipped for suggest-steps
  // roadmaps (default_parent_node_id set) — those already have a home.
  const wantAreaSuggestions = !default_parent_node_id;
  const [result, areaResult] = await Promise.all([
    runExtraction({
      rawEntryId: rawEntry.id,
      rawText: trimmed,
      workspaceId: workspace_id,
      userId: user.id,
      supabase,
    }),
    wantAreaSuggestions
      ? suggestAreas({ dump: trimmed })
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
    const ownedIds = (ownedNodes ?? [])
      .filter((n) => n.status !== "completed" && n.status !== "archived")
      .map((n) => n.id as string);
    if (ownedIds.length > 0) {
      await supabase
        .from("nodes")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .in("id", ownedIds);
      for (const n of ownedNodes ?? []) {
        if (ownedIds.includes(n.id as string)) {
          completedExistingTitles.push(n.title as string);
        }
      }
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

  return NextResponse.json({
    raw_entry_id: rawEntry.id,
    ai_run_id: result.aiRunId,
    status: "completed",
    proposed_nodes: result.proposedNodes,
    proposed_node_count: result.proposedNodes.length,
    clarifying_questions: result.clarifyingQuestions,
    completed_existing_node_titles: completedExistingTitles,
    auto_complete_local_refs: result.autoCompleteLocalRefs,
    // Life-area branches inferred from this dump. The review modal shows the
    // ones that don't already exist so the user can add them as top-level
    // branches (same as the wizard's step 2).
    suggested_areas: areaResult.suggested_areas,
  });
}
