// Merge-check prompt v1 — Phase 11.2
// Given two nodes and their embedding similarity, asks the LLM whether they
// represent the same real-world entity and should be merged.
//
// v1.1 splits stable rubric + JSON schema from the per-pair comparison so
// Gemini systemInstruction (implicit caching) can reuse the rubric prefix
// across calls. Rubric is ~300 tokens — below the 1024-token Anthropic cache
// floor, so we do NOT apply cache_control on Claude for this task.

export const MERGE_CHECK_PROMPT_VERSION = "merge-check-v1";

const RUBRIC_BLOCK = `You are evaluating whether two knowledge-graph nodes represent the same real-world entity and should be merged. The two nodes are provided in the Session block below.

Rules:
- "same_entity" is true ONLY if both nodes clearly refer to the same concept, project, task, or goal — not merely related topics.
- A node titled "Learn React" and one titled "React.js study plan" are likely the same entity.
- A node titled "Financial independence" and one titled "SaaS revenue goal" are NOT the same entity (even if related).
- Different types (e.g. goal vs task) can still be the same entity if they clearly describe the same thing.
- confidence reflects how certain you are (0 = totally unsure, 1 = certain).

Respond with ONLY valid JSON (no markdown):
{
  "same_entity": true,
  "confidence": 0.92,
  "reason": "one-sentence explanation",
  "prompt_version": "${MERGE_CHECK_PROMPT_VERSION}"
}`;

export interface MergeCheckPromptParams {
  new_title: string;
  new_summary: string | null;
  new_type: string;
  existing_title: string;
  existing_summary: string | null;
  existing_type: string;
  similarity: number;
}

function buildVariableBlock(params: MergeCheckPromptParams): string {
  const fmt = (title: string, summary: string | null, type: string) =>
    `Type: ${type}\nTitle: ${title}${summary ? `\nSummary: ${summary}` : ""}`;

  return `Session:
Node A (newly added):
${fmt(params.new_title, params.new_summary, params.new_type)}

Node B (existing):
${fmt(params.existing_title, params.existing_summary, params.existing_type)}

Embedding similarity: ${(params.similarity * 100).toFixed(1)}%`;
}

export function buildMergeCheckPromptParts(params: MergeCheckPromptParams): {
  rubricBlock: string;
  variableBlock: string;
} {
  return { rubricBlock: RUBRIC_BLOCK, variableBlock: buildVariableBlock(params) };
}

export function buildMergeCheckPrompt(params: MergeCheckPromptParams): string {
  return `${RUBRIC_BLOCK}\n\n${buildVariableBlock(params)}`;
}
