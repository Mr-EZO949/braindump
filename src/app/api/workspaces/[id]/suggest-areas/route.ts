// POST /api/workspaces/[id]/suggest-areas
// Haiku infers 3–6 life/work AREAS from the bootstrap dump (+ role + focus) so
// the wizard's step 2 can pre-fill an editable list. These become the branch
// skeleton the rest of the graph hangs off. Fail-soft: any error → empty array,
// so the user just adds areas manually.
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { WorkspaceProfileAreaType } from "@/types/graph";

export const runtime = "nodejs";

const AREA_TYPES = new Set<WorkspaceProfileAreaType>([
  "academic",
  "project",
  "career",
  "health",
  "life_admin",
  "personal",
]);

const SYSTEM_PROMPT = `You are a workspace area classifier for an ADHD-focused planning app. Given a brain dump and optional context, suggest 3–6 life/work AREAS the user would organize everything under. These become top-level branches of their graph.

Area types (use exactly these strings):
- academic: courses, studying, research
- project: builds, launches, execution
- career: jobs, internships, portfolio, networking
- health: energy, fitness, recovery
- life_admin: logistics, errands, money, upkeep
- personal: identity, habits, relationships, hobbies, languages

Rules:
- Only suggest areas that appear or are clearly implied in the dump/context.
- Concrete named contexts beat generic umbrellas. Avoid bare "Personal"/"Work"/"Life".
- Each title is 2–4 words (e.g. "Academics", "Career & Internships", "Health & Fitness").
- At most 6 areas. Never repeat an area_type.
- If the input is empty or too vague to infer anything, return [].

Respond with valid JSON only — an array: [{"title":"...","area_type":"..."}]. No markdown, no prose.`;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await params; // workspace id not needed for inference, but keep the route shape
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
  const { bootstrap_dump, role, success_title } = (body ?? {}) as {
    bootstrap_dump?: string | null;
    role?: string | null;
    success_title?: string | null;
  };

  const dump = typeof bootstrap_dump === "string" ? bootstrap_dump.trim().slice(0, 4000) : "";
  const focus = typeof success_title === "string" ? success_title.trim() : "";
  if (!dump && !focus) {
    return NextResponse.json({ suggested_areas: [], suggestion_error: null });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ suggested_areas: [], suggestion_error: "no_api_key" });
  }

  const userMsg = [
    dump ? `Brain dump:\n${dump}` : null,
    typeof role === "string" && role.trim() ? `Role/context: ${role.trim()}` : null,
    focus ? `Main focus: ${focus}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 512,
      temperature: AI_TEMPERATURE.MERGE_CHECK, // 0.1 — deterministic classification
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "[]";
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed: unknown = JSON.parse((fenced ? fenced[1] : raw).trim());

    const suggested_areas = (Array.isArray(parsed) ? parsed : [])
      .filter(
        (a): a is { title: string; area_type: WorkspaceProfileAreaType } =>
          !!a &&
          typeof a.title === "string" &&
          a.title.trim().length > 0 &&
          typeof a.area_type === "string" &&
          AREA_TYPES.has(a.area_type as WorkspaceProfileAreaType),
      )
      .map((a) => ({ title: a.title.trim().slice(0, 80), area_type: a.area_type }))
      // de-dupe by area_type to honor the prompt's "never repeat" rule
      .filter((a, i, arr) => arr.findIndex((b) => b.area_type === a.area_type) === i)
      .slice(0, 6);

    return NextResponse.json({ suggested_areas, suggestion_error: null });
  } catch (err) {
    return NextResponse.json({
      suggested_areas: [],
      suggestion_error: err instanceof Error ? err.message : "model_error",
    });
  }
}
