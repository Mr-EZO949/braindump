// POST /api/assistant/estimate-durations
// Estimates how long each provided node will take, given title/summary/type.
// Returns a map of node_id → minutes (rounded to nearest 5).
//
// Used by the What Now → "Add to Planner" flow to size the time blocks
// based on actual content rather than a fixed type-based default.
//
// Runs on Haiku in a single batched call. Falls back to a sane default
// (30m for tasks, 60m for goals/projects, 45m for habits) if the model
// errors or returns garbage.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";

const MIN_DURATION = 15;
const MAX_DURATION = 180;
const DEFAULT_BY_TYPE: Record<string, number> = {
  task: 30,
  habit: 45,
  project: 60,
  goal: 60,
  concept: 30,
  class: 30,
  idea: 30,
  question: 15,
};

type NodeInput = {
  id: string;
  title: string;
  summary: string | null;
  node_type: string;
};

function fallbackFor(node: NodeInput): number {
  return DEFAULT_BY_TYPE[node.node_type] ?? 30;
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 30;
  const rounded = Math.round(value / 5) * 5;
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, rounded));
}

async function generateEstimates(
  nodes: NodeInput[],
): Promise<Record<string, number> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (nodes.length === 0) return {};

  const renderedNodes = nodes
    .map(
      (n) =>
        `- id: ${n.id}\n  type: ${n.node_type}\n  title: ${n.title}${
          n.summary ? `\n  summary: ${n.summary}` : ""
        }`,
    )
    .join("\n");

  const prompt = `Estimate how many MINUTES of focused work each of the following items will take. Items are knowledge-work tasks captured in a personal planning app. Be realistic — a literature review can be 60-90m, "buy milk" is 15m, a coding subtask is usually 25-45m.

Items:
${renderedNodes}

Respond with ONLY valid JSON in this exact shape (no markdown, no explanation):
{"estimates":[{"id":"<id>","minutes":<integer between ${MIN_DURATION} and ${MAX_DURATION}>}]}

Rules:
- Round to a multiple of 5.
- Default to 30 if you genuinely cannot tell.
- One entry per input id, same id strings.`;

  try {
    const client = new Anthropic({ apiKey });
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 512,
      temperature: AI_TEMPERATURE.PLANNER,
      system:
        "You estimate task durations for a personal planning app. Always respond with valid JSON only — no markdown, no commentary.",
      messages: [{ role: "user", content: prompt }],
    });
    const block = r.content[0];
    const text = block?.type === "text" ? block.text.trim() : "";
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = fenced ? fenced[1].trim() : text;

    const parsed = JSON.parse(jsonText) as {
      estimates?: Array<{ id?: string; minutes?: number }>;
    };

    if (!parsed?.estimates || !Array.isArray(parsed.estimates)) return null;

    const result: Record<string, number> = {};
    for (const e of parsed.estimates) {
      if (typeof e.id === "string" && typeof e.minutes === "number") {
        result[e.id] = clampDuration(e.minutes);
      }
    }
    return result;
  } catch (err) {
    console.error("[estimate-durations] failed", err);
    return null;
  }
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

  const { nodes } = body as { nodes?: NodeInput[] };
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return NextResponse.json({ error: "nodes must be a non-empty array" }, { status: 400 });
  }
  if (nodes.length > 20) {
    return NextResponse.json({ error: "Too many nodes (max 20)" }, { status: 400 });
  }

  const estimates = await generateEstimates(nodes);

  // Build the final result — fill in any missing IDs with the type-based
  // fallback so the caller always gets a complete map.
  const durations: Record<string, number> = {};
  for (const n of nodes) {
    durations[n.id] = estimates?.[n.id] ?? fallbackFor(n);
  }

  return NextResponse.json({
    durations,
    used_ai: estimates !== null,
  });
}
