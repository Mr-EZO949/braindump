// POST /api/nodes/suggest-steps
// Given an accepted goal or project node, uses the LLM to suggest actionable
// sub-tasks/steps. Returns brain-dump-style text that the client feeds into
// the extraction pipeline via /api/entries.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";

const STEP_SYSTEM_PROMPT = `You are a task-breakdown assistant for BrainDump, a graph-based planning tool.

Given a goal or project, generate 4–8 concrete, actionable steps the user should take to accomplish it. Each step should be a task that can be checked off.

Rules:
- Be specific and practical, not generic. "Take a full-length SAT practice test" is better than "Practice".
- Order steps logically — what comes first, what depends on what.
- Include a mix of immediate quick-wins and longer tasks.
- Keep titles short (under 60 characters) but descriptive.
- Include a one-sentence summary for each step explaining why it matters or what it involves.

Output format — write as a brain dump that the extraction engine can parse:

Under "[parent title]":
- Task: [step title]. [summary]
- Task: [step title]. [summary]
...

Only output the brain dump text. No preamble, no explanation, no markdown.`;

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
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { title, summary, node_type, workspace_id } = body as {
    title: string;
    summary: string | null;
    node_type: string;
    workspace_id: string;
  };

  if (!title || !workspace_id) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Accept any node type — the user explicitly asked for a breakdown, so
  // even a "concept" or "task" or "idea" gets its own roadmap. The model's
  // output will land in the standard review queue regardless.

  // Verify workspace ownership
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return NextResponse.json({ error: "AI not configured" }, { status: 500 });
  }

  const client = new Anthropic({ apiKey: claudeKey });
  const userPrompt = summary
    ? `Goal/Project: "${title}"\nDescription: ${summary}`
    : `Goal/Project: "${title}"`;

  try {
    const response = await client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 800,
      temperature: AI_TEMPERATURE.PLANNER,
      system: STEP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const stepsText = textBlock?.text?.trim() ?? "";

    if (!stepsText) {
      return NextResponse.json({ error: "No steps generated" }, { status: 502 });
    }

    return NextResponse.json({ steps_text: stepsText });
  } catch {
    return NextResponse.json({ error: "AI generation failed" }, { status: 502 });
  }
}
