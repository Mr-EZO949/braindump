// POST /api/entries — intake route for raw brain dumps
// Saves the raw text, runs extraction, returns proposed nodes.
// All AI work happens server-side. Keys are never exposed to the client.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { runExtraction } from "@/lib/ai/extraction";
import { AI_INGESTION, AI_FLAGS, AI_RATE_LIMITS } from "@/lib/ai/config";
import { checkEntryRateLimit, rateLimitResponse } from "@/lib/ai/rate-limit";
import type { RawEntrySourceType } from "@/types/ai";

const VALID_SOURCE_TYPES: RawEntrySourceType[] = [
  "brain_dump",
  "assistant_save",
  "voice",
  "planner_convert",
];

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
  } = body as {
    raw_text: string;
    workspace_id: string;
    source_type?: string;
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

  const result = await runExtraction({
    rawEntryId: rawEntry.id,
    rawText: trimmed,
    workspaceId: workspace_id,
    userId: user.id,
    supabase,
  });

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

  return NextResponse.json({
    raw_entry_id: rawEntry.id,
    ai_run_id: result.aiRunId,
    status: "completed",
    proposed_nodes: result.proposedNodes,
    proposed_node_count: result.proposedNodes.length,
    clarifying_questions: result.clarifyingQuestions,
  });
}
