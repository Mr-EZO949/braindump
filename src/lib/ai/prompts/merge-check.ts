// Merge-check prompt v1 — Phase 11.2
// Given two nodes and their embedding similarity, asks Claude whether they
// represent the same real-world entity and should be merged.
//
// Design choices:
// - Provide full title + summary for both nodes so Claude can reason semantically
// - Include similarity score as a calibration hint
// - Ask for confidence 0–1 so the caller can apply its own threshold
// - Keep prompt short; this is a classification task, not a generative one

export const MERGE_CHECK_PROMPT_VERSION = "merge-check-v1";

export function buildMergeCheckPrompt(params: {
  new_title: string;
  new_summary: string | null;
  new_type: string;
  existing_title: string;
  existing_summary: string | null;
  existing_type: string;
  similarity: number;
}): string {
  const fmt = (title: string, summary: string | null, type: string) =>
    `Type: ${type}\nTitle: ${title}${summary ? `\nSummary: ${summary}` : ""}`;

  return `You are evaluating whether two knowledge-graph nodes represent the same real-world entity and should be merged.

Node A (newly added):
${fmt(params.new_title, params.new_summary, params.new_type)}

Node B (existing):
${fmt(params.existing_title, params.existing_summary, params.existing_type)}

Embedding similarity: ${(params.similarity * 100).toFixed(1)}%

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
}
