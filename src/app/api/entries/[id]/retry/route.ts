// POST /api/entries/:id/retry — re-run extraction on a failed raw_entry

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { runExtraction } from "@/lib/ai/extraction";
import { AI_FLAGS, AI_INGESTION } from "@/lib/ai/config";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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

  // Fetch the raw entry — RLS ensures it belongs to this user
  const { data: rawEntry, error: fetchError } = await supabase
    .from("raw_entries")
    .select("id, raw_text, workspace_id, status, retry_count")
    .eq("id", id)
    .single();

  if (fetchError || !rawEntry) {
    return NextResponse.json({ error: "Raw entry not found" }, { status: 404 });
  }

  if (rawEntry.status === "processing") {
    return NextResponse.json(
      { error: "Extraction is already in progress" },
      { status: 409 }
    );
  }

  if ((rawEntry.retry_count as number) >= AI_INGESTION.EXTRACTION_MAX_RETRIES) {
    return NextResponse.json(
      {
        error: `Max retries (${AI_INGESTION.EXTRACTION_MAX_RETRIES}) reached for this entry`,
        retry_count: rawEntry.retry_count,
      },
      { status: 429 }
    );
  }

  if (!AI_FLAGS.EXTRACTION_ENABLED) {
    return NextResponse.json(
      { error: "AI extraction is disabled" },
      { status: 503 }
    );
  }

  const result = await runExtraction({
    rawEntryId: rawEntry.id as string,
    rawText: rawEntry.raw_text as string,
    workspaceId: rawEntry.workspace_id as string,
    userId: user.id,
    supabase,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        raw_entry_id: id,
        status: "failed",
        error: result.error,
      },
      { status: 207 }
    );
  }

  return NextResponse.json({
    raw_entry_id: id,
    ai_run_id: result.aiRunId,
    status: "completed",
    proposed_nodes: result.proposedNodes,
    proposed_node_count: result.proposedNodes.length,
    clarifying_questions: result.clarifyingQuestions,
  });
}
