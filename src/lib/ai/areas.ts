// Shared life-area inference. Haiku reads a brain dump (+ optional role/focus)
// and proposes 3–6 top-level AREAS the user would organize everything under.
//
// Used in two places that must stay in sync:
//   - the bootstrap wizard's step 2 (/api/workspaces/[id]/suggest-areas)
//   - every normal brain dump (/api/entries), so a dump into a bare workspace
//     gets the same "here are your branches" treatment the wizard gives.
//
// Fail-soft everywhere: any error → empty array, so the caller just proceeds
// without area suggestions rather than breaking the dump/setup flow.

import Anthropic from "@anthropic-ai/sdk";

import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";
import type { WorkspaceProfileAreaType } from "@/types/graph";

export const AREA_TYPES = new Set<WorkspaceProfileAreaType>([
  "academic",
  "project",
  "career",
  "health",
  "life_admin",
  "personal",
]);

export interface SuggestedArea {
  title: string;
  area_type: WorkspaceProfileAreaType;
}

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

export interface SuggestAreasParams {
  dump?: string | null;
  role?: string | null;
  focus?: string | null;
}

// Infer areas from a dump. Returns [] on any failure or when nothing is
// inferable — never throws.
export async function suggestAreas(params: SuggestAreasParams): Promise<{
  suggested_areas: SuggestedArea[];
  suggestion_error: string | null;
}> {
  const dump = typeof params.dump === "string" ? params.dump.trim().slice(0, 4000) : "";
  const focus = typeof params.focus === "string" ? params.focus.trim() : "";
  const role = typeof params.role === "string" ? params.role.trim() : "";

  if (!dump && !focus) {
    return { suggested_areas: [], suggestion_error: null };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { suggested_areas: [], suggestion_error: "no_api_key" };
  }

  const userMsg = [
    dump ? `Brain dump:\n${dump}` : null,
    role ? `Role/context: ${role}` : null,
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
        (a): a is SuggestedArea =>
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

    return { suggested_areas, suggestion_error: null };
  } catch (err) {
    return {
      suggested_areas: [],
      suggestion_error: err instanceof Error ? err.message : "model_error",
    };
  }
}
