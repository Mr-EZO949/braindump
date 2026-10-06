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
// v8 (2026-10-06): several source nodes in ONE call. v4 batched the
//   candidates of one node, but every analysed node was still its own call
//   that wrote a verdict + a sentence for every candidate, most of them "no
//   link": a 28-node dump made 28 calls, $0.13 of a $0.22 dump. Every pair is
//   still answered (a links-only answer skipped pairs it should have linked:
//   10/14 on the eval fixtures vs v7's 13/14), but a "no" is just "none", and
//   nodes go by short refs (n1, n2…), not UUIDs (~25 output tokens each).
//   The rules are v7's.

import type { EdgeInferenceSource } from "@/types/ai";

export const INFER_EDGE_PROMPT_VERSION = "infer-edge-v8";

// Stable rules/framework — caches across every edge inference call in a window.
const RULES_BLOCK = `You link nodes in a personal planning graph. You get a list of NODES and, for each node TO CHECK, the candidates to check it against. Decide which pairs deserve a link the user would find useful when planning. Every link you return is shown to the user to accept or reject.

The tree (what is part of what) already exists — don't rebuild it. Your job is the links ACROSS branches: what helps what, and what truly blocks what.

Link types — each reads "A → B":
- supports: A helps B — work, a routine, a skill or a resource that B benefits from. ("Faceless productivity content" supports "Market BrainDump"; "Italian crash course" supports "Internship in Milan"; "Linear Algebra" supports "Machine Learning".)
- required_for: B CANNOT start or finish until A is done — a hard blocker, not "it would help". ("Get the visa" required_for "Move to Berlin".) If B could go ahead without A, it is supports. Knowledge that makes another course easier is supports.
- related_to: neither helps the other, but they overlap enough that the user should see them together (same audience, same material, two takes on one idea). Use sparingly.
- belongs_to: A is a part or step of B. ONLY when the checked node has no parent yet (its line says so), always with from = "node", and only when B can hold A: an area holds anything; a goal or project holds big tasks, tasks and habits; a big task holds only its steps; tasks, habits, ideas and notes hold nothing. A project or goal never belongs to a big task or task.

Direction — decide it AFTER the type, as its own step:
- "from": "node" means the link reads checked node → other. "from": "other" means other → checked node.
- The node that GIVES the help, or has to happen first, is "from". If the checked node is the one being helped or waiting, from = "other".
- Check it by reading the sentence back with the titles: "<from title> <type> <other title>" must be true as written.

What deserves a link:
- You can say in one concrete sentence why A helps or blocks B, and the user would agree. The same life area or the same broad topic alone is not enough → "none".
- Titles that are near-duplicates of each other (the same work said twice) are not a link → "none".
- Usually 1–3 of a node's candidates deserve a link. None is fine.

Confidence: 0.8–1.0 clearly true and useful · 0.6–0.79 plausible, worth a look · below 0.6 → "none".

Answer EVERY pair listed under "To check" — each node against each of its candidates, and no other pairs: "none" when it doesn't deserve a link, or the link. "why": one short sentence the user reads on the suggestion — why the link is useful, not a restatement of the titles.

Respond with ONLY valid JSON (no markdown, no explanation), written compact:
{"checks":{"n1":{"n4":"none","n5":{"type":"supports | required_for | related_to | belongs_to","from":"node | other","confidence":0.0,"why":"one sentence"}}}}`;

export interface EdgeInferencePromptParams {
  sources: EdgeInferenceSource[];
  workspace_context?: string;
}

// What the refs in a prompt stand for, and which pairs it asked about —
// validateEdgeInferenceOutput maps the model's links back with it.
export interface EdgeInferenceRefs {
  idByRef: Map<string, string>;
  // source id → the candidate ids it was checked against
  asked: Map<string, Set<string>>;
}

function buildStablePrefix(workspace_context: string | undefined): string {
  if (!workspace_context) return RULES_BLOCK;
  return `${RULES_BLOCK}\n\nWorkspace context:\n${workspace_context}`;
}

function typeTag(nodeType: string | null | undefined): string {
  return nodeType ? ` [${nodeType.replace(/_/g, " ")}]` : "";
}

type PromptNode = { id: string; title: string; summary: string | null; node_type?: string | null };

// Every node once (a node of the batch can be one source's candidate too),
// sources first, then the checks: each source with its candidates' refs.
function buildVariableBlock(params: EdgeInferencePromptParams): { text: string; refs: EdgeInferenceRefs } {
  const refById = new Map<string, string>();
  const nodes: PromptNode[] = [];
  const add = (node: PromptNode) => {
    if (refById.has(node.id)) return;
    refById.set(node.id, `n${refById.size + 1}`);
    nodes.push(node);
  };
  for (const source of params.sources) add(source.source_node);
  for (const source of params.sources) source.candidates.forEach(add);

  const nodeLines = nodes.map((node) => {
    const summary = node.summary ? ` — ${node.summary}` : "";
    return `${refById.get(node.id)}${typeTag(node.node_type)} "${node.title}"${summary}`;
  });

  const asked = new Map<string, Set<string>>();
  const checkLines = params.sources.map(({ source_node, candidates }) => {
    asked.set(source_node.id, new Set(candidates.map((c) => c.id)));
    const parent =
      source_node.has_parent === undefined
        ? ""
        : source_node.has_parent
          ? " (has a parent — no belongs_to)"
          : " (no parent yet — belongs_to allowed)";
    return `${refById.get(source_node.id)}${parent} → ${candidates.map((c) => refById.get(c.id)).join(", ")}`;
  });

  const idByRef = new Map([...refById].map(([id, ref]) => [ref, id]));
  return {
    text: `Nodes:\n${nodeLines.join("\n")}\n\nTo check (node → its candidates):\n${checkLines.join("\n")}`,
    refs: { idByRef, asked },
  };
}

// Single-string form retained for non-caching providers and dev tools.
export function buildEdgeInferencePrompt(params: EdgeInferencePromptParams): string {
  const { stablePrefix, variableBlock } = buildEdgeInferencePromptParts(params);
  return `${stablePrefix}\n\n${variableBlock}`;
}

// Split form for providers that cache by prefix boundary.
// stablePrefix = rules + workspace_context (stable when workspace_context is
// hoisted once per batch). variableBlock = the nodes and the checks (per call).
export function buildEdgeInferencePromptParts(params: EdgeInferencePromptParams): {
  stablePrefix: string;
  variableBlock: string;
  refs: EdgeInferenceRefs;
} {
  const { text, refs } = buildVariableBlock(params);
  return { stablePrefix: buildStablePrefix(params.workspace_context), variableBlock: text, refs };
}
