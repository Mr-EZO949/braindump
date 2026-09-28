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
import { recordClaudeRun, type AIUsageScope } from "@/lib/ai/telemetry";
import { readClaudeUsage } from "@/lib/ai/usage";
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

const SYSTEM_PROMPT = `You are an area INDUCER for an ADHD-focused planning app. Read a brain dump and induce the 3–6 top-level life/work AREAS that everything in it rolls up under. These become the branches of the user's graph, and each concrete item will nest beneath one.

CRUCIAL — infer the area even when the user never named it. Use world knowledge to generalize concrete items into their natural domain. This is the whole point: the user rarely names their areas, so you must recognize them.
- "go to the gym daily, do cardio, take creatine, want my dream physique" → area "Health & Fitness" (the user never said "fitness")
- "test my app, market it, build a personal brand, resell clothes from Milan, land an internship" → these are all money/career moves → area "Income & Career"
- "calculus exam, linear algebra, ML & DL course, fuzzy systems" → area "University" or "Academics"
- "pray 5 times a day" → area "Faith & Spirituality"
- "call mom, renew passport, pay rent" → area "Life Admin"

Area types (use exactly these strings):
- academic: courses, studying, research
- project: a specific build/launch/initiative
- career: jobs, internships, portfolio, income, networking
- health: energy, fitness, recovery
- life_admin: logistics, errands, money-upkeep, appointments
- personal: identity, habits, relationships, hobbies, languages, faith

Rules:
- Induce the FEWEST areas that still cover everything — usually 3–5. Merge items into one area when they share a real-world domain, even across different wordings.
- Every area MUST be supported by at least one concrete item in the dump. Never invent an area nothing rolls up to.
- Prefer the natural real-world domain over the literal words. Concrete named contexts ("UniMi Degree") beat bare generics ("School"). Avoid "Personal"/"Work"/"Life" as a title.
- Each title is 2–4 words. Areas do NOT need distinct types — two "project"-type areas are fine if they're genuinely different domains, but don't split one domain into two.
- If the dump is truly empty or a single unrelated fragment with no domain, return [].

Respond with valid JSON only — an array: [{"title":"...","area_type":"..."}]. No markdown, no prose.`;

export interface SuggestAreasParams {
  dump?: string | null;
  role?: string | null;
  focus?: string | null;
  // Who to bill in ai_runs; omitted → the call is not logged.
  usageScope?: AIUsageScope;
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
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 512,
      temperature: AI_TEMPERATURE.MERGE_CHECK, // 0.1 — deterministic classification
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });
    await recordClaudeRun({
      scope: params.usageScope,
      source: "suggest-areas",
      model: AI_MODELS.CLAUDE_HAIKU,
      promptVersion: "suggest-areas",
      usage: readClaudeUsage(response.usage),
      latencyMs: Date.now() - startedAt,
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
      // de-dupe by title (case-insensitive) — two areas may share a type as
      // long as they're genuinely different domains, so we no longer collapse
      // by area_type (that dropped legitimate second projects/domains).
      .filter(
        (a, i, arr) =>
          arr.findIndex((b) => b.title.toLowerCase() === a.title.toLowerCase()) === i,
      )
      .slice(0, 6);

    return { suggested_areas, suggestion_error: null };
  } catch (err) {
    return {
      suggested_areas: [],
      suggestion_error: err instanceof Error ? err.message : "model_error",
    };
  }
}
