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
// v5 (docs/unified-turn.md, phase 2): the prompt is now the graph BUILDER. It
// edits existing nodes itself through "changes" (move / update / link) instead
// of asking a question for chat to act on, and chat's build_graph tool runs it.
// v6 (2026-10-02): the user's date words are copied into date_words and the
// server resolves them (lib/time/relative-day.ts) — on a Friday, "by friday"
// came back as the next TUESDAY. Same resolver the priority read uses.
// v7 (2026-10-03): a weekly fixed time (a lecture, a shift, a practice) is the
// user's schedule, saved by the priority read as a commitment — no node. The
// full prompt had the rule since v26; here "volleyball practice tuesdays and
// fridays 5–7pm, stats lecture tue/thu 2–4pm" made two habit nodes next to
// the two weekly times.
//
// Same output schema and the same Session block as extract.ts, so the rest of
// the pipeline (resolution, auto-apply, completions) is unchanged. Longer
// dumps still take the full prompt (see AI_INGESTION.LIGHT_DUMP_MAX_CHARS).

import { buildExtractionVariableBlock, type ExtractionPromptParams } from "./extract";

export const EXTRACT_LIGHT_PROMPT_VERSION = "extract-light-v7";

const LIGHT_RUBRIC_BLOCK = `You turn a short brain-dump UPDATE into changes to the user's existing knowledge graph. Most of these updates report things the user just did, plus a few new things to do; some ask to reorganize what is already there. Keep the graph sparse: propose only what the dump clearly states.

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
- A FIXED time in the week set by someone else — a lecture, a lab, a work shift, a team practice, a standing meeting ("stats lecture every Tuesday and Thursday 2–4pm", "practice moved to 6pm") — is the user's SCHEDULE, saved by another step. No node for it: not a habit, task or note.
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

4. Edits to existing nodes.
- proposed_nodes only ADDS. When the dump asks to reorganize nodes that already EXIST — "move X under Y", "X should be its own project with A and B in it", "X isn't really a Y thing, it's more of a Z thing", "rename X to Y", "X is really a project" — put the edit in "changes", using ids from the existing-node list:
  - {"kind":"move","node_id":"<existing id>","new_parent":"<existing id, or the local_ref of a node you create in this dump>"} — replaces the node's current parent; whatever sits under the node moves with it.
  - {"kind":"update","node_id":"<existing id>","title":"New title","node_type":"big_task"} — rename and/or retype; give only the fields that change.
  - {"kind":"link","source":"<id or local_ref>","target":"<id or local_ref>","edge_type":"supports | useful_for | required_for | related_to"} — a lateral link that leaves the tree alone.
- A new parent over existing nodes: create the parent in proposed_nodes, placed where the things going into it sit NOW (existing_parent_node_id = their current parent — not the root unless that is where they are), then move the existing nodes under its local_ref. Example — existing "Test & Market BrainDump" [big_task] (under: Money Projects), dump "BrainDump should be its own project with testing and marketing as tasks in it" → proposed_nodes: project "BrainDump" n1 with existing_parent_node_id = Money Projects' id, big_task "Market BrainDump" n2 with primary_parent_local_ref n1; changes: update the existing node's title to "Test BrainDump", move it under n1. Existing nodes listed "(under: <the node being split or regrouped>)" move too, to whichever new home fits them.
- Every part the user names must exist under the new parent afterwards. "X with A and B in it" / "A and B as two separate things" → A and B are each a node: rename the existing node into the ONE part it already is, create the others. WRONG: only renaming or retyping the existing node into the parent (update "Test & Market BrainDump" → project "BrainDump") and stopping — the project would then have no testing and no marketing in it. WRONG too: renaming it to "Test BrainDump" and creating neither the project nor "Market BrainDump".
- NEVER create a second copy of a node that exists to stand in for a move or a rename — move or rename the one that is there. And never create an empty new parent without moving anything into it.
- A node that leaves a parent it still HELPS keeps that as a link: "Italian is personal development really, but it helps the internship" → move "Italian Crash Course" under "Personal Development" + link it useful_for the internship goal.
- The new parent must be able to hold the node (a project never goes under a task or big task; tasks, habits, ideas and notes hold nothing). When the wording implies the opposite nesting from what exists, the bigger thing is the parent.
- Only edit nodes the dump actually names. If it is unclear WHICH node is meant or WHERE it should go, ask in clarifying_questions instead of guessing. Deleting and marking done are not edits: done → complete_existing_node_ids; "drop X" → leave it.

5. Deadlines.
- Only an explicit date or weekday ("by Friday", "due Oct 3", "end of the month") → copy the user's words for it into date_words ("friday", "oct 3", "end of the month") AND give target_date YYYY-MM-DD resolved against today in the Session block. The server reads date_words with a calendar and trusts that over your target_date. Put it on the item the deadline is about — a to-do's date belongs to the to-do, not to the goal or class it is for. Anything else ("soon", "this week", "before the launch") → leave both out; never invent a date.

Confidence: 0.9+ when clearly stated, 0.6–0.8 when inferred.

Respond with ONLY valid JSON, compact (no indentation or line breaks). Always include proposed_nodes (use [] when there is nothing new); leave out any other field that would be null or an empty array.
{"proposed_nodes":[{"local_ref":"n1","proposed_title":"string","proposed_summary":"string","proposed_body":"string","proposed_node_type":"task","primary_parent_local_ref":"n2","existing_parent_node_id":"existing node id","target_date":"YYYY-MM-DD","date_words":"friday","extraction_confidence":0.9}],"changes":[{"kind":"move","node_id":"existing node id","new_parent":"existing node id or n1"}],"clarifying_questions":["string"],"complete_existing_node_ids":["existing node id"],"auto_complete_local_refs":["n1"]}`;

export function buildLightExtractionPromptParts(params: ExtractionPromptParams): {
  rubricBlock: string;
  variableBlock: string;
} {
  return { rubricBlock: LIGHT_RUBRIC_BLOCK, variableBlock: buildExtractionVariableBlock(params) };
}
