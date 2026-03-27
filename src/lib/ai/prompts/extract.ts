// Extraction prompt v1
// Phase 9 will tune this against a benchmark dataset.
// Keep version string in sync with any prompt text changes.

export const EXTRACT_PROMPT_VERSION = "extract-v2";

export function buildExtractionPrompt(params: {
  raw_text: string;
  workspace_id: string;
  user_id: string;
}): string {
  return `You are a knowledge graph extraction assistant. Extract distinct, atomic ideas from the brain dump below.

Rules:
- Each node must represent ONE clear idea, task, concept, project, goal, or question.
- Do not merge unrelated ideas into one node.
- Do not split a single coherent idea into multiple nodes.
- Titles should be concise (3–8 words).
- Summaries should be 1–2 sentences max.
- Confidence: 0.0–1.0. Use 0.9+ only if the idea is clearly stated. Use 0.6–0.8 for inferred ideas.
- source_span: copy the exact phrase or sentence from the input that led to this node. Use null for implied parent nodes.
- Node types: project | task | class | concept | idea | journal | question | goal

Parent node rule:
- If two or more extracted nodes clearly share an unstated but specific named parent, also propose that parent node.
- Good examples: "probability problem set" + "email prof about research paper" → a specific course or class they belong to IF the course is nameable; "neural nets idea" + "stats background question" → "Climate Data Research" project.
- Bad examples: do NOT propose generic parents like "Academic Work", "Personal Tasks", "Responsibilities", "Goals", "Projects" — these add no value.
- The parent must be a specific named entity (a real course, a real project, a real goal with a name) that is clearly implied. If you cannot give it a specific meaningful name, skip it.
- Set source_span to null and extraction_confidence to 0.75 for implied parent nodes.
- List parent nodes BEFORE their children in the array.

Brain dump:
"""
${params.raw_text}
"""

Respond with ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "proposed_nodes": [
    {
      "workspace_id": "${params.workspace_id}",
      "user_id": "${params.user_id}",
      "proposed_title": "string",
      "proposed_summary": "string or null",
      "proposed_node_type": "task | project | concept | goal | idea | question | class | journal",
      "extraction_confidence": 0.0–1.0,
      "source_span": "string or null"
    }
  ],
  "prompt_version": "${EXTRACT_PROMPT_VERSION}"
}`;
}
