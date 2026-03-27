// Edge inference prompt v2
// Tuned to surface non-obvious connections — the core value of the graph.
// v1 was too conservative (required explicit text evidence). v2 reasons about
// what each node REPRESENTS in the real world and whether a useful relationship
// exists even if the user never stated it.

export const INFER_EDGE_PROMPT_VERSION = "infer-edge-v2";

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

  return `You are a knowledge graph assistant. Your job is to find NON-OBVIOUS connections between two nodes.

The user has NOT stated a connection between these nodes. Your value is surfacing relationships they didn't think to make themselves — like a second brain that sees how things fit together.
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
3. Is there a real-world relationship between them — even one the user hasn't stated?
4. Would surfacing this connection be genuinely useful to the user, or just noise?

Confidence scale:
- 0.8–1.0: Clear relationship, would obviously be useful to the user
- 0.5–0.79: Plausible non-obvious connection worth reviewing
- 0.3–0.49: Speculative but interesting — surface it, user can reject
- below 0.3: Too weak or too generic — return related: false

Rules:
- related: false only if there is genuinely NO useful connection. When in doubt, surface it — the user can reject it.
- Prefer specific edge types over related_to. Use related_to only when domain overlap is real but no directional relationship exists.
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
