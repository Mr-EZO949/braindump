// POST /api/nodes/suggest-steps
// Given an accepted goal or project node, uses the LLM to suggest actionable
// sub-tasks/steps. Returns brain-dump-style text that the client feeds into
// the extraction pipeline via /api/entries.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";

// Light mode's output contract — a flat list of immediate next actions.
const OUTPUT_FORMAT = `Output format — write as a brain dump that the extraction engine can parse:

Under "[parent title]":
- Task: [step title]. [summary]
- Task: [step title]. [summary]
...

Only output the brain dump text. No preamble, no explanation, no markdown.`;

// Full mode's output contract — a two-level TREE (phases → tasks) so the
// roadmap reads as structure the user can navigate, not a flat wall of tasks.
// The nesting (a "Under [phase]:" block per phase) is what the extraction
// engine turns into sub-parents beneath the goal.
const OUTPUT_FORMAT_GROUPED = `Output format — write as a brain dump the extraction engine parses into a TREE. Group the steps under 2–4 short PHASES (logical stages, in order). Each phase is its own heading with its tasks nested under it:

Under "[parent title]":
- Phase: [phase name]. [one line — what this phase covers]
- Phase: [phase name]. [one line]

Under "[phase name]":
- Task: [step title]. [summary]
- Task: [step title]. [summary]

Under "[phase name]":
- Task: [step title]. [summary]
- Task: [step title]. [summary]

Give every phase its own "Under [phase name]:" block. Keep it to 2–4 phases, 2–4 tasks each. Only output the brain dump text. No preamble, no explanation, no markdown.`;

// Full roadmap — the whole breakdown, grouped into phases.
const STEP_SYSTEM_PROMPT_FULL = `You are a task-breakdown assistant for BrainDump, a graph-based planning tool.

Given a goal or project, generate 4–8 concrete, actionable steps — and ORGANIZE them into 2–4 short phases so the result is a high-level tree, not a flat list. Each step is a task that can be checked off; each phase is a stage that groups related tasks.

Rules:
- Read the Description for the CURRENT state — what is already done, in progress, or live. Do NOT propose steps for work that's already complete; start from where things actually stand, not from scratch. (If a survey is described as "already live", don't suggest designing or launching it — pick up at analysis/write-up.)
- If the Description names a blocker — waiting on a person, a decision, or input that isn't ready — make the unblocking action an EARLY step and sequence the rest after it.
- Tailor every step to THIS specific situation. Never output a generic textbook sequence that ignores the Description.
- Phases should be natural stages for THIS goal (e.g. "Prep", "Build", "Launch"), named for what they contain — not generic "Phase 1/2/3". Order them so earlier phases unblock later ones.
- Put each task under the phase it belongs to. Every phase must hold at least one task.
- If the workspace's other active items are listed, do NOT propose steps that duplicate them, and sequence your steps around their deadlines and dependencies — if a step must happen before or is blocked by another item, order it accordingly and say so in its summary.
- Be specific and practical, not generic. "Take a full-length SAT practice test" is better than "Practice".
- Include a mix of immediate quick-wins and longer tasks.
- Keep titles short (under 60 characters) but descriptive.
- Include a one-sentence summary for each step explaining why it matters or what it involves.

${OUTPUT_FORMAT_GROUPED}`;

// Light — just enough to get unstuck. For paralysis relief, not planning.
const STEP_SYSTEM_PROMPT_LIGHT = `You are a task-breakdown assistant for BrainDump, a tool for people who get stuck starting things.

Given a goal or project, generate ONLY the 1–3 most immediate, concrete next actions — the smallest things the user can do right now to get moving. This is not a full plan; it's the first push past the blank page.

Rules:
- Each step must be doable in one short sitting. "Open a new doc and write the title" beats "Draft the report".
- Pick the true first step(s) — what literally has to happen before anything else.
- Keep titles short (under 60 characters) and concrete.
- One-sentence summary each.

${OUTPUT_FORMAT}`;

// Count the "- Task:" lines the model produced. Used to decide whether the
// cheap Haiku pass returned a usable breakdown or something too thin to ship.
function countSteps(text: string): number {
  return text.split("\n").filter((l) => /^\s*-\s*Task:/i.test(l)).length;
}

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

  const { title, summary, node_type, workspace_id, mode, instructions } = body as {
    title: string;
    summary: string | null;
    node_type: string;
    workspace_id: string;
    mode?: "light" | "full";
    instructions?: string;
  };
  const stepMode = mode === "light" ? "light" : "full";
  // Optional user directions to steer the breakdown. Capped so a pasted essay
  // can't blow the 800-token budget.
  const cleanInstructions =
    typeof instructions === "string" ? instructions.trim().slice(0, 500) : "";

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

  // Workspace context so the breakdown fits the bigger picture: sequence around
  // real deadlines/dependencies and don't duplicate work that already exists.
  const { data: wsNodes } = await supabase
    .from("nodes")
    .select("title, node_type, target_date")
    .eq("workspace_id", workspace_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("target_date", { ascending: true, nullsFirst: false })
    .limit(40);
  const contextBlock =
    wsNodes && wsNodes.length > 0
      ? `\n\nOther active items already in this workspace — do NOT duplicate these, and sequence your steps around their deadlines and dependencies:\n${wsNodes
          .map((n) => `- [${n.node_type}] ${n.title}${n.target_date ? ` (due ${n.target_date})` : ""}`)
          .join("\n")}`
      : "";

  const client = new Anthropic({ apiKey: claudeKey });
  const userPrompt =
    (summary ? `Goal/Project: "${title}"\nDescription: ${summary}` : `Goal/Project: "${title}"`) +
    (cleanInstructions
      ? `\n\nUser's directions for this breakdown (follow these): ${cleanInstructions}`
      : "") +
    contextBlock;

  const systemPrompt =
    stepMode === "light" ? STEP_SYSTEM_PROMPT_LIGHT : STEP_SYSTEM_PROMPT_FULL;
  // Light wants 1–3 steps, so a single step is a valid result — only escalate
  // if it came back empty. Full wants a real roadmap, so <2 steps is too thin.
  const minSteps = stepMode === "light" ? 1 : 2;

  async function generate(model: string): Promise<string> {
    const response = await client.messages.create({
      model,
      max_tokens: 800,
      temperature: AI_TEMPERATURE.PLANNER,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text?.trim() ?? "";
  }

  try {
    // Haiku first — most breakdowns are routine and don't need Sonnet's
    // depth. Escalate to Sonnet only when Haiku comes back too thin. A Sonnet
    // throw rides the outer catch → 502.
    let model: string = AI_MODELS.CLAUDE_HAIKU;
    let stepsText = await generate(model);
    let escalated = false;

    if (countSteps(stepsText) < minSteps) {
      model = AI_MODELS.CLAUDE_SONNET;
      stepsText = await generate(model);
      escalated = true;
    }

    if (!stepsText) {
      return NextResponse.json({ error: "No steps generated" }, { status: 502 });
    }

    console.log("[suggest-steps]", { mode: stepMode, model, escalated, steps: countSteps(stepsText) });
    return NextResponse.json({ steps_text: stepsText });
  } catch {
    return NextResponse.json({ error: "AI generation failed" }, { status: 502 });
  }
}
