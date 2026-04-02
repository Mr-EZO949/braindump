// Edge inference prompt v2
// Tuned to surface non-obvious connections — the core value of the graph.
// v1 was too conservative (required explicit text evidence). v2 reasons about
// what each node REPRESENTS in the real world and whether a useful relationship
// exists even if the user never stated it.

export const INFER_EDGE_PROMPT_VERSION = "infer-edge-v3";

export function buildEdgeInferencePrompt(params: {
  source_title: string;
  source_summary: string | null;
  target_title: string;
  target_summary: string | null;
  workspace_context?: string;
}): string {
  const contextBlock = params.workspace_context
    ? `\nWorkspace context:\n${params.workspace_context}\n`
    : "";

  return `You are a knowledge graph assistant. Your job is to keep the graph SPARSE, USEFUL, and STRUCTURALLY READABLE.

The default answer should be related: false unless there is a genuinely high-value relationship.
${contextBlock}
Node A: "${params.source_title}"
${params.source_summary ? `Summary A: ${params.source_summary}` : ""}

Node B: "${params.target_title}"
${params.target_summary ? `Summary B: ${params.target_summary}` : ""}

Edge types (A → B direction):
- useful_for: A is a skill, concept, or resource that helps with B
- prerequisite_for: understanding or completing A makes B easier or possible
- belongs_to: A is a task, subtopic, or component that lives under B
- supports: A provides evidence, motivation, or backing for B
- depends_on: A cannot proceed without B
- related_to: A and B share context, domain, or audience — worth keeping near each other

Reasoning steps (think through these before answering):
1. What does Node A actually represent in the real world? (a skill? a task? a concept? a goal?)
2. What does Node B actually represent?
3. Is there a direct structural or execution relationship between them?
4. If not, is there still a genuinely useful relationship, or would this just create graph noise?

Confidence scale:
- 0.8–1.0: Clear relationship, would obviously be useful to the user
- 0.5–0.79: Plausible non-obvious connection worth reviewing
- 0.3–0.49: Speculative but interesting — surface it, user can reject
- below 0.3: Too weak or too generic — return related: false

Rules:
- Prefer "belongs_to", "prerequisite_for", or "depends_on" when there is a clear structural/task relationship.
- Use "supports" or "useful_for" only when the connection would materially improve planning or understanding.
- Use "related_to" rarely. Shared topic alone is NOT enough.
- If the pair only shares a broad domain, return related: false.
- Most pairs should return related: false.
- Explanation must say WHY this connection is useful, not just restate the titles.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "related": true | false,
  "edge_type": "edge_type_string or null if related is false",
  "confidence": 0.0–1.0,
  "explanation": "one sentence: why this connection is useful to the user",
  "prompt_version": "${INFER_EDGE_PROMPT_VERSION}"
}`;
}
