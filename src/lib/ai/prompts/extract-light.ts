// Light extraction prompt — for SHORT dumps (daily updates: "did the gym,
// finished the TA shift, call with Abdo moved to Friday, need to email the
// prof"). Those are mostly completions of existing items plus a few new
// tasks, so they don't need the full rubric's clustering / depth / grouping
// rules (~9K tokens). This keeps only the rules short updates exercise: ~2.5K
// tokens with context, ~$0.008 per update vs ~$0.024 on the full prompt.
// Still Sonnet: on Haiku (eval 2026-09-28) it completed whole projects from
// partial progress ("practice exam" → "Pass Probability" done) and invented
// details, which the past-tense / never-invent rules below don't fully fix.
//
// Same output schema and the same Session block as extract.ts, so the rest of
// the pipeline (resolution, auto-apply, completions) is unchanged. Longer
// dumps still take the full prompt (see AI_INGESTION.LIGHT_DUMP_MAX_CHARS).

import { buildExtractionVariableBlock, type ExtractionPromptParams } from "./extract";

export const EXTRACT_LIGHT_PROMPT_VERSION = "extract-light-v1";

const LIGHT_RUBRIC_BLOCK = `You turn a short brain-dump UPDATE into changes to the user's existing knowledge graph. Most of these updates report things the user just did, plus a few new things to do. Keep the graph sparse: propose only what the dump clearly states.

1. Completions — do these FIRST.
- If the dump says the user did/finished/shipped/booked something ("did the gym", "finished the lit review", "booked the flight") and a matching node is in the existing-node list, put that node's id in complete_existing_node_ids. Do NOT create a new node for it.
- Paraphrases and abbreviations count as a match ("ML exam" = "Machine Learning exam", "worked out" = "Go to the gym").
- Completion needs PAST-TENSE evidence that the user did it ("did", "finished", "sent", "booked", "passed", "done"). Plans, to-dos and intentions ("fix the login bug today", "need to call the bank", "prep the deck by Friday", "gotta decide") are NOT completions — if a matching node exists it already covers the to-do, so propose nothing for it. Asking for help deciding is not having decided.
- Complete a node ONLY when the dump says THAT item itself is done. Progress on something bigger — a practice exam, one study session, finding bugs, sending a draft — NEVER completes the project/goal/class it belongs to ("finished a probability practice exam" does not complete "Pass Probability"; "found 3 bugs" does not complete "Test BrainDump"). A habit done today does count ("did the gym" → complete the gym habit; it is logged for today).
- If it's unclear whether something is finished or what it refers to, ask a clarifying question instead of guessing.
- A brand-new milestone with no matching node that is worth keeping as a record: create it and put its local_ref in auto_complete_local_refs. Use sparingly.
- Pure status/feelings with no next step ("feeling better", "day was fine"): skip entirely.

2. New items.
- One node per clear idea/task. Title 3–8 words. Summary: one short sentence in direct address or a noun phrase — never "the user …".
- proposed_body: only if the dump gave a real stake, next step or detail (≤300 chars); otherwise leave it out.
- A task is ONE concrete action with a clear "done" ("email the professor", "solve 5 practice problems"). Something that needs several actions ("pass calculus", "write the thesis", "fix my sleep") is a project or goal — never a task.
- Habit only with an explicit cadence ("daily", "every morning", "3× a week"); otherwise task.
- Vague fragments ("work on stuff", "idk what to do", "fix bugs" with no target) and feelings/complaints ("this feature is killing me", "everything's falling apart"): no node — at most one short, specific clarifying question that quotes the fragment.
- Use only what the user said. Never add details they didn't give — no invented times, targets, numbers or steps.
- Types: task | project | goal | habit | class | concept | idea.

3. Never duplicate — attach instead.
- The existing-node list was retrieved for THIS dump by meaning and wording; the user is usually talking about exactly those items. "under: X" shows where each lives.
- If an equivalent node already exists at the same level, do not propose it again.
- If a new item is a step toward / part of an existing node, create it and set existing_parent_node_id to that node's id (the most specific fitting one; not a generic root).
- If the dump itself names a project plus its parts, create the project with the parts as children via primary_parent_local_ref (list the parent first). Never set both parent fields on one node.

4. Deadlines.
- Only an explicit date or weekday ("by Friday", "due Oct 3", "end of the month") → target_date YYYY-MM-DD, resolved against today in the Session block ("Friday" = next Friday on/after today). Put it on the item the deadline is about. Anything else ("soon", "this week", "before the launch") → leave it out; never invent a date.

Confidence: 0.9+ when clearly stated, 0.6–0.8 when inferred.

Respond with ONLY valid JSON, compact (no indentation or line breaks). Always include proposed_nodes (use [] when there is nothing new); leave out any other field that would be null or an empty array.
{"proposed_nodes":[{"local_ref":"n1","proposed_title":"string","proposed_summary":"string","proposed_body":"string","proposed_node_type":"task","primary_parent_local_ref":"n2","existing_parent_node_id":"existing node id","target_date":"YYYY-MM-DD","extraction_confidence":0.9}],"clarifying_questions":["string"],"complete_existing_node_ids":["existing node id"],"auto_complete_local_refs":["n1"]}`;

export function buildLightExtractionPromptParts(params: ExtractionPromptParams): {
  rubricBlock: string;
  variableBlock: string;
} {
  return { rubricBlock: LIGHT_RUBRIC_BLOCK, variableBlock: buildExtractionVariableBlock(params) };
}
