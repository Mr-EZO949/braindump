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
// v2: node types v2 (docs/node-types.md) — big_task / area / note, goal only
// for verifiable outcomes; old types in the existing list are still the same item.
// v3: passing an exam/course is a goal (a result); big_task = a piece of work.
// v4: a request to restructure EXISTING nodes becomes one yes/no clarifying
// question that restates the edit (extraction only adds) — chat applies it.
//
// Same output schema and the same Session block as extract.ts, so the rest of
// the pipeline (resolution, auto-apply, completions) is unchanged. Longer
// dumps still take the full prompt (see AI_INGESTION.LIGHT_DUMP_MAX_CHARS).

import { buildExtractionVariableBlock, type ExtractionPromptParams } from "./extract";

export const EXTRACT_LIGHT_PROMPT_VERSION = "extract-light-v4";

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
- Pick the type by its one question:
  - task — one sitting, one clear "done" ("email the professor", "solve 5 practice problems").
  - big_task — ONE piece of work they do or produce, over several sittings ("write the thesis", "test BrainDump", "build my portfolio site").
  - project — a body of work with several different parts ("internship search", "launch the beta").
  - goal — a RESULT they'll know they reached, ideally dated ("pass the calculus exam", "1450+ on the SAT", "internship in Milan by November"). Aspirations without a finish line ("get in shape", "make money") are areas.
  - habit — only with an explicit cadence ("daily", "every morning", "3× a week").
  - area — an ongoing part of life with no finish line ("Health", "Career", "Life Admin").
  - class — a course this term. idea — something they might do, not committed. note — something to remember: a person and their role, advice, a fact, a decision already made.
- Vague fragments ("work on stuff", "idk what to do", "fix bugs" with no target) and feelings/complaints ("this feature is killing me", "everything's falling apart"): no node — at most one short, specific clarifying question that quotes the fragment.
- Use only what the user said. Never add details they didn't give — no invented times, targets, numbers or steps.
- Types: goal | project | big_task | task | habit | area | class | idea | note.

3. Never duplicate — attach instead.
- The existing-node list was retrieved for THIS dump by meaning and wording; the user is usually talking about exactly those items. "under: X" shows where each lives.
- If an equivalent node already exists, do not propose it again — even if its type differs (older graphs typed big tasks as tasks or projects, and areas as goals or concepts).
- If a new item is a step toward / part of an existing node, create it and set existing_parent_node_id to that node's id (the most specific fitting one; not a generic root). Parents must be able to hold it: a big task holds only task steps (and notes); tasks, habits, ideas and notes hold nothing.
- If the dump itself names a project plus its parts, create the project with the parts as children via primary_parent_local_ref (list the parent first). Never set both parent fields on one node.
- If the user writes a heading over 2+ items ("Life admin: rent, parking pass, …") and no matching node exists, create that heading as the parent — an area for a part of life ("Life Admin"), a project for a body of work — and put the items under it. If a matching node exists, attach the items to it.

4. Restructure requests.
- You can only ADD nodes and mark completions — not move, rename, split or re-parent existing ones. If the dump asks to reorganize EXISTING nodes ("X should be its own project with A and B as tasks in it", "move X under Y", "split X into two"), do NOT create a node to stand in for the change — no empty new parent, no duplicate. Put ONE entry in clarifying_questions that restates the exact edit so a plain "yes" is enough, naming the existing nodes by title: "Make 'BrainDump' its own project under 'Money Projects', with 'Test BrainDump' and 'Market BrainDump' as tasks in it (replacing 'Test & Market BrainDump')?" Extract the rest of the dump as usual.

5. Deadlines.
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
