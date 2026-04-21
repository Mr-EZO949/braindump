// POST /api/command — unified command-bar classifier.
// Takes a free-form message and decides which surface should handle it
// (brain dump, chat, planner, edit, or ask for clarification). The client
// dispatches based on the returned intent — this route does not do any
// writes besides logging the ai_run.

import { NextRequest, NextResponse } from "next/server";

import { aiProvider } from "@/lib/ai";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AI_RATE_LIMITS } from "@/lib/ai/config";
import { persistAIRun } from "@/lib/ai/telemetry";
import { hashText, logFailedAIRun, normalizeAIError } from "@/lib/ai/errors";
import { INTENT_PROMPT_VERSION } from "@/lib/ai/prompts/intent";

const MAX_MESSAGE_CHARS = AI_RATE_LIMITS.CHAT_MESSAGE_MAX_CHARS;

export async function POST(req: NextRequest) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { message, workspace_id } = (body ?? {}) as {
    message?: unknown;
    workspace_id?: unknown;
  };

  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message too long. Maximum ${MAX_MESSAGE_CHARS} characters.` },
      { status: 400 },
    );
  }
  if (typeof workspace_id !== "string" || !workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  }

  // Cheap workspace snapshot: a handful of recent node titles + total count.
  // Good enough for the router to tell "empty graph" from "lots to work on".
  const { data: recentNodes, count: nodeCount } = await supabase
    .from("nodes")
    .select("title, node_type", { count: "exact" })
    .eq("user_id", user.id)
    .eq("workspace_id", workspace_id)
    .order("created_at", { ascending: false })
    .limit(8);

  const recentTitles = (recentNodes ?? [])
    .map((n) => `- [${n.node_type}] ${n.title}`)
    .join("\n");
  const workspaceContext = recentTitles
    ? `Recent nodes (${nodeCount ?? recentNodes?.length ?? 0} total):\n${recentTitles}`
    : "";

  const provider = aiProvider();
  const start = Date.now();

  try {
    const result = await provider.classifyIntent({
      message: message.trim(),
      workspace_context: workspaceContext || undefined,
      has_graph: (nodeCount ?? 0) > 0,
    });

    await persistAIRun({
      supabase,
      userId: user.id,
      workspaceId: workspace_id,
      source: "command-bar",
      run: result.run,
    });

    return NextResponse.json({
      intent: result.output.intent,
      confidence: result.output.confidence,
      rationale: result.output.rationale,
      clarifying_question: result.output.clarifying_question,
      prompt_version: result.output.prompt_version,
    });
  } catch (error) {
    const normalized = normalizeAIError(error, "Could not classify intent");
    await logFailedAIRun({
      supabase,
      userId: user.id,
      workspaceId: workspace_id,
      runType: "intent",
      provider: "llm",
      modelName: "unknown",
      promptVersion: INTENT_PROMPT_VERSION,
      inputHash: hashText(message),
      latencyMs: Date.now() - start,
      error: normalized.message,
    });
    return NextResponse.json({ error: normalized.userMessage }, { status: 502 });
  }
}
