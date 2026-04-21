// Intent router prompt v1 — Phase 1 (unified command bar)
// Classifies a free-form user message into one intent so the bar can
// dispatch to the right surface (brain dump ingestion vs. assistant chat vs.
// planner vs. graph edit). The model sees a short workspace context and the
// message; it emits a single intent label with a confidence score and an
// optional clarifying question when it cannot choose.

export const INTENT_PROMPT_VERSION = "intent-v1";

export function buildIntentPrompt(params: {
  message: string;
  workspace_context?: string;
  has_graph: boolean;
}): string {
  const ctx = params.workspace_context?.trim();
  const ctxBlock = ctx
    ? `\nWorkspace snapshot (for grounding):\n${ctx}\n`
    : "\nWorkspace snapshot: (empty — no nodes yet)\n";

  return `You are the intent router for BrainDump, a knowledge-graph app.
Classify the user's message into exactly ONE intent so the UI can route it.

Intents:
- "braindump"  — the user is dumping raw thoughts, notes, ideas, tasks, journal-style text. Multiple sentences, stream-of-consciousness, or a list of things. Goes into the extraction pipeline.
- "question"   — a question about their graph, past work, or anything that wants an answer (not an action). Examples: "what did I say about X", "summarise my goals", "what is Y".
- "plan"       — a planning/scheduling request. "what should I do today", "plan the next 2h", "give me a schedule", "what should I work on".
- "edit"       — an explicit graph edit: rename / delete / complete / archive / add a single node / mark done. Must reference a node or clearly instruct a structural change.
- "status"     — a "what now?" / "where am I?" / "what's next?" orientation request that isn't a full plan. Short, open-ended, wants recommendation.
- "unclear"    — ambiguous, empty, or needs clarification to choose between the above.

Decision rules:
1. Prefer "braindump" for multi-sentence unstructured text even if a question appears inside — users paste thoughts all the time.
2. Short single-sentence messages are usually "question" or "status", not "braindump".
3. "edit" requires a clear imperative referencing a node ("rename X to Y", "delete X", "mark X done", "add a node Y under X"). Vague "update my graph" is "unclear".
4. "plan" implies time-boxed scheduling. "what should I do" without time context is "status".
5. If the workspace is empty and the user asks "what now" → "status" with a clarifying question suggesting they brain-dump first.
6. Confidence is 0.0–1.0 reflecting how certain you are.
7. clarifying_question is non-null ONLY when intent is "unclear" OR confidence < 0.55. Otherwise null.
${ctxBlock}
Has any nodes in workspace: ${params.has_graph ? "yes" : "no"}

User message:
"""
${params.message}
"""

Respond with ONLY valid JSON (no markdown, no prose):
{
  "intent": "braindump" | "question" | "plan" | "edit" | "status" | "unclear",
  "confidence": 0.87,
  "rationale": "one short sentence explaining the call",
  "clarifying_question": null,
  "prompt_version": "${INTENT_PROMPT_VERSION}"
}`;
}
