// Edge inference prompt — batched (v4)
// v4 evaluates the source node against ALL its top-N candidates in a single call
// to eliminate the per-pair prompt overhead that dominated cost (≥60% of Claude spend).
// The model sees all candidates side-by-side, which also tends to improve ranking.
// v4.1 splits the prompt into a cacheable rules block and a variable context block
// so repeated calls within ~5min can hit the prompt cache on the rules (~700 tok).

export const INFER_EDGE_PROMPT_VERSION = "infer-edge-v4.1";

// Stable rules/framework — caches across every edge inference call in a window.
const RULES_BLOCK = `You are a knowledge graph assistant. Your job is to keep the graph SPARSE, USEFUL, and STRUCTURALLY READABLE.

For each candidate below, decide whether it has a genuinely high-value relationship to the source node. The default answer should be related: false unless the connection would clearly help the user.

Edge types (source → candidate direction):
- useful_for: source is a skill, concept, or resource that helps with candidate
- prerequisite_for: understanding or completing source makes candidate easier or possible
- belongs_to: source is a task, subtopic, or component that lives under candidate
- supports: source provides evidence, motivation, or backing for candidate
- depends_on: source cannot proceed without candidate
- related_to: source and candidate share context, domain, or audience — worth keeping near each other

For each candidate, reason briefly (to yourself) before answering:
1. What does the source actually represent?
2. What does this candidate represent?
3. Is there a direct structural or execution relationship?
4. If not, is there a genuinely useful relationship, or would this just create graph noise?

Confidence scale:
- 0.8–1.0: Clear relationship, would obviously be useful to the user
- 0.5–0.79: Plausible non-obvious connection worth reviewing
- 0.3–0.49: Speculative but interesting — surface it, user can reject
- below 0.3: Too weak or too generic — return related: false

Rules:
- Prefer "belongs_to", "prerequisite_for", or "depends_on" when there is a clear structural/task relationship.
- Use "supports" or "useful_for" only when the connection would materially improve planning or understanding.
- Use "related_to" rarely. Shared topic alone is NOT enough.
- If a pair only shares a broad domain, return related: false for that candidate.
- Most candidates should return related: false.
- Explanation must say WHY this connection is useful, not just restate the titles.
- You MUST return exactly one result per candidate, with candidate_id matching the provided id.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "results": [
    {
      "candidate_id": "the id from above",
      "related": true | false,
      "edge_type": "edge_type_string or null if related is false",
      "confidence": 0.0,
      "explanation": "one sentence: why this connection is useful (or why not)"
    }
  ],
  "prompt_version": "${INFER_EDGE_PROMPT_VERSION}"
}`;

function buildVariableBlock(params: {
  source_title: string;
  source_summary: string | null;
  candidates: { id: string; title: string; summary: string | null }[];
  workspace_context?: string;
}): string {
  const contextBlock = params.workspace_context
    ? `Workspace context:\n${params.workspace_context}\n\n`
    : "";

  const sourceBlock = `Source node:
Title: "${params.source_title}"${params.source_summary ? `\nSummary: ${params.source_summary}` : ""}`;

  const candidateBlock = params.candidates
    .map((c, idx) => {
      const summary = c.summary ? `\n  Summary: ${c.summary}` : "";
      return `[${idx + 1}] id="${c.id}"
  Title: "${c.title}"${summary}`;
    })
    .join("\n\n");

  return `${contextBlock}${sourceBlock}

Candidates (evaluate each one independently against the source):

${candidateBlock}`;
}

// Single-string form retained for non-caching providers (Gemini) and dev tools.
export function buildEdgeInferencePrompt(params: {
  source_title: string;
  source_summary: string | null;
  candidates: { id: string; title: string; summary: string | null }[];
  workspace_context?: string;
}): string {
  return `${RULES_BLOCK}\n\n${buildVariableBlock(params)}`;
}

// Split form for Anthropic caching: the rules block is cacheable; the context
// block varies per call.
export function buildEdgeInferencePromptParts(params: {
  source_title: string;
  source_summary: string | null;
  candidates: { id: string; title: string; summary: string | null }[];
  workspace_context?: string;
}): { rulesBlock: string; variableBlock: string } {
  return {
    rulesBlock: RULES_BLOCK,
    variableBlock: buildVariableBlock(params),
  };
}
