// Edge inference prompt — batched
// v4 evaluates the source node against ALL its top-N candidates in a single call
// to eliminate the per-pair prompt overhead that dominated cost (≥60% of Claude spend).
// The model sees all candidates side-by-side, which also tends to improve ranking.
// v4.1 split the prompt into a cacheable rules block and a variable context block
// so repeated calls within ~5min can hit the prompt cache on the rules (~700 tok).
// v4.2 folds workspace_context into the stable prefix. When the caller hoists
// workspace_context to be built once per batch, the full prefix is stable bytes
// across every inferEdge call in that batch — pushing the cached portion past
// Anthropic's 1024-token floor and enabling cache hits on calls 2…N.
// v5 (2026-09-30, a real 25-node dump produced 10 links: all dependencies, none
// lateral, half of them backwards):
//   - direction is its own field ("from"), decided after the type. v4 had one
//     direction per type, so "Linear Algebra helps ML" asked about from the ML
//     node came out as ML → prerequisite_for → Linear Algebra.
//   - one dependency type, required_for, for HARD blockers only. Dependency
//     edges block the target in Focus, the planner and the ranking, and v4's
//     "prefer prerequisite_for" turned every "this helps that" into a blocker.
//     Helping is supports / useful_for.
//   - the model sees node types and whether the source already has a parent,
//     with the nesting rules, so it stops proposing a project under a big task.
// v7 (2026-10-05, owner: fewer link TYPES; v6 was the reverted hard_need try): four kinds only — supports absorbs
//   useful_for (a skill or resource that helps is "supports"); the rest unchanged.

export const INFER_EDGE_PROMPT_VERSION = "infer-edge-v7";

// Stable rules/framework — caches across every edge inference call in a window.
const RULES_BLOCK = `You link nodes in a personal planning graph. For one SOURCE node and a few CANDIDATE nodes, decide which pairs deserve a link the user would find useful when planning. Every link you return is shown to the user to accept or reject.

The tree (what is part of what) already exists — don't rebuild it. Your job is the links ACROSS branches: what helps what, and what truly blocks what.

Link types — each reads "A → B":
- supports: A helps B — work, a routine, a skill or a resource that B benefits from. ("Faceless productivity content" supports "Market BrainDump"; "Italian crash course" supports "Internship in Milan"; "Linear Algebra" supports "Machine Learning".)
- required_for: B CANNOT start or finish until A is done — a hard blocker, not "it would help". ("Get the visa" required_for "Move to Berlin".) If B could go ahead without A, it is supports. Knowledge that makes another course easier is supports.
- related_to: neither helps the other, but they overlap enough that the user should see them together (same audience, same material, two takes on one idea). Use sparingly.
- belongs_to: A is a part or step of B. ONLY when the source has no parent yet (the Source line says so), always with from = "source", and only when B can hold A: an area holds anything; a goal or project holds big tasks, tasks and habits; a big task holds only its steps; tasks, habits, ideas and notes hold nothing. A project or goal never belongs to a big task or task.

Direction — decide it AFTER the type, as its own step:
- "from": "source" means the link reads source → candidate. "from": "candidate" means candidate → source.
- The node that GIVES the help, or has to happen first, is "from". If the source is the one being helped or waiting, from = "candidate".
- Check it by reading the sentence back with the titles: "<from title> <type> <other title>" must be true as written.

What deserves a link:
- You can say in one concrete sentence why A helps or blocks B, and the user would agree. The same life area or the same broad topic alone is not enough → related: false.
- Titles that are near-duplicates of each other are not a link → related: false.
- Usually 1–3 of the candidates deserve a link. Returning none is fine.

Confidence: 0.8–1.0 clearly true and useful · 0.6–0.79 plausible, worth a look · below 0.6 → related: false.

You MUST return exactly one result per candidate, with candidate_id matching the provided id. Explanation: one sentence saying why the link is useful (or why there is none) — not a restatement of the titles.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "results": [
    {
      "candidate_id": "the id from above",
      "related": true | false,
      "edge_type": "supports | required_for | related_to | belongs_to, or null if related is false",
      "from": "source | candidate",
      "confidence": 0.0,
      "explanation": "one sentence"
    }
  ],
  "prompt_version": "${INFER_EDGE_PROMPT_VERSION}"
}`;

export interface EdgeInferencePromptParams {
  source_title: string;
  source_summary: string | null;
  source_node_type?: string | null;
  // undefined = unknown (the line is left out).
  source_has_parent?: boolean;
  candidates: { id: string; title: string; summary: string | null; node_type?: string | null }[];
  workspace_context?: string;
}

function buildStablePrefix(workspace_context: string | undefined): string {
  if (!workspace_context) return RULES_BLOCK;
  return `${RULES_BLOCK}\n\nWorkspace context:\n${workspace_context}`;
}

function typeTag(nodeType: string | null | undefined): string {
  return nodeType ? ` [${nodeType.replace(/_/g, " ")}]` : "";
}

function buildVariableBlock(params: EdgeInferencePromptParams): string {
  const parentLine =
    params.source_has_parent === undefined
      ? ""
      : params.source_has_parent
        ? "\nParent: already has one — do not use belongs_to."
        : "\nParent: none yet — belongs_to is allowed if a candidate is clearly what it is part of.";
  const sourceBlock = `Source node${typeTag(params.source_node_type)}:
Title: "${params.source_title}"${params.source_summary ? `\nSummary: ${params.source_summary}` : ""}${parentLine}`;

  const candidateBlock = params.candidates
    .map((c, idx) => {
      const summary = c.summary ? `\n  Summary: ${c.summary}` : "";
      return `[${idx + 1}] id="${c.id}"${typeTag(c.node_type)}
  Title: "${c.title}"${summary}`;
    })
    .join("\n\n");

  return `${sourceBlock}

Candidates (evaluate each one independently against the source):

${candidateBlock}`;
}

// Single-string form retained for non-caching providers and dev tools.
export function buildEdgeInferencePrompt(params: EdgeInferencePromptParams): string {
  const prefix = buildStablePrefix(params.workspace_context);
  const variable = buildVariableBlock(params);
  return `${prefix}\n\n${variable}`;
}

// Split form for providers that cache by prefix boundary.
// stablePrefix = rules + workspace_context (stable when workspace_context is
// hoisted once per batch). variableBlock = source + candidates (per-call).
export function buildEdgeInferencePromptParts(params: EdgeInferencePromptParams): {
  stablePrefix: string;
  variableBlock: string;
} {
  return {
    stablePrefix: buildStablePrefix(params.workspace_context),
    variableBlock: buildVariableBlock(params),
  };
}
