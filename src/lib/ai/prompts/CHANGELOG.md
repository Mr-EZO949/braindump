# Prompt Version Changelog

All prompt changes are tracked here. Each entry records the version, what changed, and why.
Run the eval before and after a change: `npx tsx --env-file=.env.local scripts/eval-run.ts` (synthetic fixtures in `src/lib/ai/eval/`, ~$0.2 a run; `--only <ids>` for one fixture, `--replay <report.json>` to re-check a saved run for free).

---

## Extraction (`extract.ts`)

### extract-v28 (current) · extract-light-v9 (current) — four link kinds (2026-10-05)
- Owner: fewer link TYPES (the old nine overlapped). soft_links / `link` changes take `supports` (helps; absorbs `useful_for`), `required_for` (needed for; was `prerequisite_for`), `related_to` (absorbs `inspired_by`). Validation folds a retired name into its kind, so nothing else is ever written. Spec: `docs/node-types.md` "Link kinds".
- Size (countTokens): full rubric 9,105 → 9,057 (−48); light rubric 2,566 → 2,581 (+15, a one-line meaning per kind).
- Eval (one round, synthetic): `full-scratch` links 1/1 (Linear Algebra → PyTorch required_for); the 3 misses are node typing/placement (Stats class anchor, "Learn PyTorch" a goal — open since v27), not links. $0.0425.

### extract-v27 · extract-light-v8 — the user's label never sets the type (2026-10-04)
- One tie-breaker in each builder prompt: under a heading like "goals for this semester:" (or after "my goal is to …") each item is typed by the Node types questions — "land the Stripe internship" → goal, "write the capstone report" → big_task, "learn Rust" → project; finishing, writing or learning something is work, not a result. The full prompt's "Goals for This Semester" grouping example now says it is an area whose items keep their own types.
- Why: the eval's first live run (`full-scratch`) typed every item under "goals for this semester: get into the honors program, finish thesis proposal, learn pytorch" as a goal. By `docs/node-types.md` only the first is a result; the thesis proposal is a big task and PyTorch a project. A new light fixture (`light-goal-heading`, the same line on its own) showed the short prompt does it too: v7 made "Learn PyTorch" a goal ($0.0120).
- Eval (one round, synthetic fixtures; examples in the prompt deliberately use other items than the fixtures):
  - extract-v27: `full-scratch` 8/9 node types (v26: 7/9) — "Finish Thesis Proposal" now a big_task, "Learn PyTorch" STILL a goal. `full-mixed` (neighbour) passes everything, the three "pass X" exams still goals. $0.0925 (scratch $0.0431, mixed $0.0494 incl. edit pass). Open: the PyTorch line needs another round — a candidate cause is the "Lists of named items" rule ("one node per named item … of the same kind"), which reads a "goals" list as items of one kind.
  - extract-light-v8: `light-goal-heading` 3/3 (v7: 2/3; "Learn PyTorch" → project), `light-goal-habit` (neighbour) still passes. $0.0244.

### extract-v26 — the long prompt quotes edit requests; the short prompt carries them out (2026-10-01)
- The long prompt no longer plans edits. A sentence that asks to change EXISTING nodes is copied word for word into `edit_requests`, and the long prompt creates nothing for it. `runBuilder` (extraction.ts) then runs those sentences through `extract-light-v5` with child-expanded retrieval — the same call that does a one-line restructure from chat — and merges the result (refs prefixed `e_`, its nodes first so dedup keeps them). The `changes` schema left the long prompt; the "Edits to existing nodes" section became a short "quote it" section.
- Why: on long dumps the long prompt planned a new-parent reorganization badly in 4 runs of 5 (moved nodes under a local_ref it never proposed; or created the project and forgot the move), while the short prompt got the same request right 8 of 8. The difference is how much else is on the page.
- From the first end-to-end runs of a long MIXED dump (venting + a question + completions + new work with dates + two reorganizations + two stated links + a weekly class time): read the dump to its last line ("also need to call the bank" was dropped); a habit done today is a completion (the full prompt lacked the rule); steps the user names are children with the date on the step (a "pick a dataset by friday, then write the proposal" became one big task); a weekly fixed time is a commitment, never a habit node; a soft link may target an existing node's id (the model had invented a copy of an existing goal to link to and lost the link with it); venting and questions to the assistant produce no clarifying question (`dump-reply-v1` answers them).
- Eval (synthetic 16-node workspace, throwaway user, the 1,136-char mixed dump, end to end in the browser): 3 runs while the prompt moved from "changes first" to "quote and hand off". Final run: every item captured (10 new nodes incl. the bank call and the named ML steps), gym logged + CV done, both reorganizations exactly as asked (BrainDump project with Test/Market and the old fixes moved along; Italian under Personal Development keeping `useful_for` the internship), both stated links, the class as a commitment and no habit node. $0.0425 (13.4k in / 1.6k out, 13.8 s) + edit pass $0.0129 (6.4 s).

### extract-light-v7 — weekly fixed times are not nodes (2026-10-03)
- The light prompt gets the full prompt's rule: a fixed weekly time set by someone else (a lecture, a lab, a shift, a team practice) is the user's schedule, saved by the priority read as a commitment — no habit, task or note for it.
- Why: "volleyball practice is tuesdays and fridays 5 to 7pm. and stats lecture is every tuesday and thursday 2 to 4pm" typed in chat (a short dump) saved both weekly times AND made two habit nodes, "Volleyball Practice" and "Statistics Lecture" — "every tuesday" read as a habit cadence.
- Eval (one live run, same message, throwaway user): two weekly times, no new nodes. $0.0116 for the whole dump turn (light builder $0.0085, 21 output tokens; v6 on the same message: $0.0111 and two habit nodes).

### extract-light-v6 · extract-v26 — the user's date words (2026-10-02)
- Both builder prompts copy the user's words for a deadline into `date_words` ("friday", "oct 20", "next monday") next to `target_date`; validation resolves them with `lib/time/relative-day.ts` (the resolver the priority read and chat tools already use) and keeps `target_date` only when the words don't resolve ("end of Q3"). The light prompt also says a to-do's date belongs to the to-do, not to the goal or class it is about.
- Why: on Friday 2026-10-02 the light prompt turned "email the prof … by friday" into Tuesday 10-06, while the priority read put Friday 10-09 on the midterm goal — two models, two wrong-or-different answers for one phrase.
- Eval (one short real dump, $0.013): "the stats midterm got moved to oct 22. also need to email prof marino about the review session by friday, and did the gym" → midterm due 10-22 (priority read), new email task due 10-09 (resolver), the midterm untouched by the email's date, gym logged.

### extract-v25 · extract-light-v5 — the graph builder (2026-09-30)
- Both prompts now EDIT existing nodes. New output field `changes`: `move` (node → new parent, an existing id or the local_ref of a node created in the same output), `update` (rename / retype), `link` (lateral edge). The v24 rule "extraction only adds → ask one yes/no question for chat to act on" is gone. Rules carried over from the assistant prompt's restructuring section: a new parent goes where its future children sit now; never a second copy of an existing node; keep a `useful_for` link when a node leaves a parent it still helps; the parent must be able to hold the child; every part the user names must exist afterwards (with the two wrong outcomes spelled out).
- The existing-node list says its ids are for attaching, completing **or editing**. Retrieval also shows the children of the top hits when the text reads like a restructure (or the call comes from chat), so "make X its own project" can move X's steps with it.
- Why: `docs/unified-turn.md` phase 2 — the same model that places a dump's nodes now does chat's restructures (through `build_graph`), instead of a whole chat turn on Sonnet.
- Eval (synthetic workspace, throwaway user; $0.32 in total with the assistant-v24 runs below): light prompt 8/8 plans correct — new project + rename + move + new sibling (4×), move + `useful_for` link, two completions + a dated task, a move next to a new task, a 3-task update. $0.0088–0.0112 and 3–6 s per call. Full prompt on a 783-char dump (10 new nodes): move + link correct 2/2, but the new-parent restructure failed 3/3 — it renamed only, converted the fused node into the project itself, or moved nodes under a local_ref (`n11`) it never proposed. Not fixed in the prompt; `resolveBuilderChanges` now drops every edit to a node whose move is half-planned and the user gets a question instead. $0.041–0.064, 12.6–31 s.

### extract-v24 · extract-light-v4
- The intent-framed example named a fused "Test & market BrainDump" node, contradicting the project-with-parts rule two sections above it. The model copied the example: a real dump got one big task and no "BrainDump" project. The example now shows the project with its two children, and fusing two kinds of work into one "A & B" node is called out.
- A grouping typed project ("Money Projects", created by the setup wizard) still holds projects. Without this line the parts of BrainDump were attached straight to it and the project node was skipped. (The wizard now creates every branch as an area.)
- Lists of named items: one node per item. One eval run folded seven named exams into a single "clear the backlog" goal.
- soft_links: the old text ("a SMALL NUMBER", "most nodes should have zero") got zero links on a 25-node dump. A relation the dump STATES between two nodes that aren't parent/child ("X for Y", "X so that Y", "X is marketing for Y") is now always captured as supports / useful_for; prerequisite_for only for a real order.
- Restructure requests (both prompts): extraction only adds, so "X should be its own project with A and B in it" becomes ONE clarifying question that restates the edit so "yes" is enough — no empty stand-in parent. The answer goes to chat, which applies it.
- Eval (2026-09-30, the owner's own 2,414-char dump, replayed into a throwaway workspace): BrainDump project with Test / Market / fixes / faceless content under it, six exam goals, 3 links (faceless content supports Market BrainDump, sleep supports the exam backlog, build required_for market). Light prompt on the follow-up dump: 0 nodes, Daily Gym completed, the one question. $0.245 for three full runs (one per prompt revision), $0.011 light.
- v18–v23 are described in the header of `extract.ts`.

### extract-v17
- Added the **Depth rule**: prefer real area→project→task chains over a flat fan, with an explicit "don't overdo it" guardrail (no filler/invented middle levels, no wrapping a lone child, ≤~4 levels per dump, attach one level up when unsure).
- Why: user wants deep graphs, not linear ones. Verified on a multi-domain dump → 21 nodes, max depth 3 ("Make Money Fast → BrainDump → Market/Test", "UniMi CS Degree → exams", "Get in Shape → gym/cardio/creatine"). Depth comes from extraction's own structure rules (Depth + v16 project-with-parts + semantic clustering) — NOT from injecting areas, which was tried and reverted because it made extraction emit empty duplicate area shells.
- Companion (not a prompt change): a normal dump also runs `suggestAreas` (lib/ai/areas.ts) in parallel — an LLM area *inducer* (TnT-LLM-style label induction, not embedding clustering) that infers latent life-domains the user never named — surfaced as optional review chips for domains the dump didn't already structure.

### extract-v16
- Extended the goal-with-means rule to projects (now "Goal/Project-with-parts"): when the user names a project plus the work it needs ("working on BrainDump, needs marketing and testing"), create the project as a parent node with the work as task children — not loose top-level tasks with no project node, and not one merged node.
- Added worked examples (BrainDump → Market/Test; Song Spot → Add player/Fix auth) and made the "list parent before children" instruction explicit here too.
- Why: users reported a named project's sub-work landing as scattered top-level tasks (no project parent), the same flattening v15 fixed for goals.

### extract-v15
- Added intent-framed grouping rule: when the user states a driving intent and lists 2+ items serving it ("it's very important to make money, so I have these projects: A, B, C"), create that intent as a goal cluster and attach the items — even if the umbrella reads slightly generic, because the user supplied the framing.
- Added goal-with-means rule: don't collapse a stated goal plus its distinct activities ("get in shape → gym/cardio/stretch/creatine") into one node; keep the goal as a parent over its activities.
- Why: large multi-domain dumps flattened into a wide fan off the "General" root — only topically-tight clusters (courses) nested, while intent-based groupings (money projects) and multi-activity goals (fitness) stayed as loose siblings. Retroactive embedding clustering can't recover these (intent ≠ cosine similarity), so the fix belongs in extraction.
- Note: entries v8–v14 predate this changelog being kept in sync; the version constant advanced without log entries. v15 resumes tracking.

### extract-v7
- Added workspace context block (`workspace_context` param)
- Added existing anchor attachment rule with `existing_parent_node_id`
- Enforced mutual exclusivity: cannot set both `primary_parent_local_ref` and `existing_parent_node_id`
- Added `soft_links` field for same-dump cross-links
- Why: brain dumps need to connect to existing workspace structure, not just internal refs

### extract-v6
- Added semantic clustering rule: auto-create domain clusters when 3+ nodes share a domain
- Why: solopreneur and student brain dumps were flat — all tasks at root level with no structure

### extract-v5
- Added named context anchor rule (course names, projects, named datasets)
- Added implied anchor rule ("stats homework ch7" implies "Statistics Course")
- Added explicit grouping rule (user-written headings become nodes)
- Why: graphs were too flat; needed hierarchical structure from natural language cues

### extract-v4
- Tightened node type classification rules
- Reduced over-extraction of journal-type nodes

### extract-v3
- Added `source_span` field for traceability
- Added `depends_on_local_refs` for same-dump dependencies

### extract-v2
- Structured JSON output with `local_ref` system
- Added confidence scoring guidelines

### extract-v1
- Initial extraction prompt with basic node type classification

---

## Edge inference (`infer-edge.ts`)

### infer-edge-v7 (current) — four link kinds (2026-10-05)
- `useful_for` folded into `supports` (a skill or resource that helps is "supports"); output types supports / required_for / related_to / belongs_to. (v6 was the reverted `hard_need` try below, hence v7.) `edge-selection.ts` maps any retired name to its kind; the helping-work rule now always gives `supports`.
- Size: rules block 830 → 784 tokens (−46). Chat `change` tool schema 745 → 763 (+18: the enum lost two names, gained a one-line meaning per kind).
- Eval (one round, 3 calls): `edge-skill` 6/6, `edge-blocker` 5/5, `edge-helps-not-blocks` 3/4 — the miss is the known "Get the Food Permit" → required_for → "Run Instagram Ads" (open since v5). $0.0076. Real chat turn "the machine learning class really helps with getting the internship, connect them" → Linked "Machine Learning helps Get Internship by November" with Undo (stored `supports`), $0.0128.

### infer-edge-v5
- 2026-10-05, #24 "fewer, truer links" — fixed in code, prompt unchanged (`edge-selection.ts`, `connection.ts`):
  - Tried and NOT adopted: infer-edge-v6, a `hard_need` field ("which one literally can't happen without the other, or none") answered before the type, explanation first. Haiku's `hard_need` agreed with its wrong type every time (Market → Launch 0.92, Food Permit → Instagram Ads 0.98, and Linear Algebra Review → ML class flipped to required_for 0.95); +214 input tokens/call. Reverted. $0.0162 for 5 calls.
  - A hard blocker can't start at helping work: a blocker title with a learning word (learn, study, review, practice, research…) becomes `useful_for`, a promotion word (market, promote, ads, outreach, networking…) `supports`. A habit, area, idea or note is never a blocker; only goal/project/big task/task/class can be blocked.
  - Up to 2 blockers per analysed node (was 1 — "Renew Passport" → visa was dropped when the visa → move was kept).
  - Structural cuts: a node's own ancestors/descendants are no longer sent to the model; a lateral link between siblings under a project/goal/big task/class is dropped (a blocker between them stays); under an area only `related_to` is dropped; the root doesn't count. A link the graph already says — the same direction between the two ends or their ancestors, or A → X → B — is dropped (a blocker only counts as said by blockers).
  - `related_to` floor 0.7 → 0.8; a node with 3 lateral links (on the graph + waiting on review) gets no new one, applied across the whole batch best-first (`runConnectionBatch`, shared by `/api/nodes/analyze` and the `connection_batch` job).
  - Eval: 2 new fixtures (`edge-helps-not-blocks`, `edge-too-many`). Today's code on v5's live answers: 22/27 → 26/27 (the old 3 fixtures 14/17 → 17/17; replayed free). Left: "Get the Food Permit" → required_for → "Run Instagram Ads" (Haiku: you can't advertise an unlicensed bakery). Baseline round $0.0139 for 5 calls. Real `/api/nodes/analyze` pass on a throwaway workspace: Market → supports → Launch, two blockers kept for the visa, a 0.75 related_to cut, the node's own child not asked about; $0.0131 for 3 calls.
- 2026-10-04, tried and NOT adopted: the eval's `edge-direction` fixture links "Market BrainDump" → required_for → "Launch the BrainDump Beta" (0.95), where marketing only helps the launch. A test added to required_for ("could B still happen with A left undone, just less well? Promotion, practice, preparation, networking and studying make B go better, not possible → supports", with two non-fixture examples) changed nothing: still required_for from source at 0.95, now explained the other way round ("marketing cannot succeed without a public beta"). `edge-skill` and `edge-blocker` unchanged. Reverted, so the version stays v5; $0.0082 for the 3 calls. Haiku reads the two nodes as one dependent pair in either direction — the next try needs a direct line (marketing supports a launch; work on one product helps, it doesn't block) or a code-side check, and its own round.
- Direction is its own field (`from`: source | candidate), decided after the type. v4 had one direction per type, so "Linear Algebra helps ML", asked from the ML node, came out as ML → prerequisite_for → Linear Algebra: 5 of 10 links on a real dump were backwards.
- One dependency type, `required_for`, for hard blockers only. Dependency edges block the target in Focus, the planner and the ranking, and v4's "prefer prerequisite_for" turned every "this helps that" into a blocker (10 of 10 links were dependencies, none lateral). Helping is `supports` / `useful_for`.
- The model sees node types and whether the source already has a parent, plus the nesting rules.
- Code (`edge-selection.ts`): up to 2 lateral links per node (was 1), a dependency needs ≥0.75 (an unsure one is kept as `supports`), a proposed parent must be able to hold the node (no project under a big task).
- Eval (2026-09-30, 5 nodes of a copy of the owner's graph, real pipeline into a throwaway workspace): 8 links — useful_for ×4, supports ×3, related_to ×1 — all in the right direction, no dependency. $0.0218 for 5 calls ($0.0044/call).
- infer_edge runs are logged again: the old `void supabase.from("ai_runs").insert(...)` never executed (a supabase-js query only runs when awaited), so none had been logged since 2026-04-08.

### infer-edge-v4 / v4.1 / v4.2
- Batched: one call per source node over its top candidates; rules + workspace context as a cacheable prefix.

### infer-edge-v3
- Added workspace context block for richer inference
- Why: edge inference without workspace context was missing obvious connections

### infer-edge-v2
- Shifted from requiring explicit text evidence to reasoning about real-world relationships
- Added reasoning steps (what does each node represent?)
- Added confidence scale guidance (0.8+ = clear, 0.5-0.79 = plausible, etc.)
- Why: v1 was too conservative, missed non-obvious but useful connections

### infer-edge-v1
- Initial edge inference prompt — required direct textual evidence

---

## Merge check (`merge-check.ts`)

### merge-check-v3 (current) — a container and what lives in it are never one node (2026-10-04)
- New rule: a class or area and a goal, project, big task or task inside it are never the same entity, even when the titles share words ("Linear Algebra" class holds "Pass Linear Algebra"; "Health" area holds "Run a Half-Marathon").
- Why: the eval's first live run said the goal "Pass Machine Learning" and the class "Machine Learning" were the same (0.88). Under node types v2 the class holds that goal; merging them breaks the structure. In the app `merge.ts` already skips goal-vs-class pairs (`COMPATIBLE_TYPES`), but area-vs-goal pairs do reach the model.
- Eval (one round): `merge-class-vs-goal` now "different" (0.98, "the class is a container, the goal lives within it"); neighbours `merge-area-vs-goal` (different, 0.95) and `merge-api-docs` (same across big_task/task, 0.94) still pass. $0.0028 for 3 calls.

### merge-check-v2
- Node types v2: older nodes may carry an earlier type for the same item.

---

## Assistant (`assistant.ts`)

> Note: this changelog drifted (entries jump v4 → v10; the live constant is the
> source of truth, now mirrored by the derived `PROMPT_VERSIONS` map). The
> intermediate v5–v9 changes predate this entry and weren't logged here.

### assistant-v34 (current) — part of a day; "yes" to "build around it?" re-plans (2026-10-06)
- Two sentences after the plan rule: "rebuild 2–5pm" / "plan my evening again" → `plan_day` with `start_time` and `end_time` (what's planned outside stays — commit route `plan_start`, `keptOutsideWindow`); when the plan's own message asked "…is due tomorrow and isn't in it — want me to build around it?" and they say yes → `plan_day` again with the same span and the item added to `include`.
- Why (owner 10-06): "if the AI thinks my plan is bad it should suggest: you have this due, maybe focus on that instead — and rebuild around it". The question is written in code (`lib/planner/due-left-out.ts`, no model call) and ends the `plan_day` result, so the reply to it reaches Haiku with tools (a bare "yes" to a statement goes to the tool-less simple path — the first e2e run did exactly that).
- Eval (throwaway user, real pipeline, synthetic nodes: "Stats exam prep" due tomorrow, blocks already at 16:00 and 22:00; "rebuild just 18:00 to 19:30 for me: 1h of leetcode and 30 min on my cv" → Apply → Accept → "yes" → Apply → Accept): run 1 found two bugs (no question; the plan's span pinned to Leetcode as fixed time) → fixed; run 2: question asked, "yes" → `plan_day` 18:00–19:30 with "stats exam prep" in include, 16:00 and 22:00 kept, no duplicates. $0.017 + $0.024.

### assistant-v33 — plan_day gets the times, the end and the note; a correction re-plans (2026-10-06)
- One sentence after the plan rule: anything at a clock time goes in `busy`, an end in `end_time` ("until 11pm" → "23:00"), another day in `day`, how they feel in `note`; a correction to a plan just drafted ("no, mealprep is 12:30–14:00", "also add X", "lighter please") → `plan_day` again with the whole request, every time kept — not `replan_today`.
- Why (owner's ezo workspace, 10-06): "fill until 11pm" from 12:30 came as `custom_minutes` 570 (22:00); "today is not much deep work cuz im sick" had nowhere to go; "no, mealprep is from 12:30 for 1.5 hours" ran `replan_today`, which took the plan's work off as missed instead of rebuilding.
- Checked end to end (throwaway user, the owner's Tuesday message, UI chat → card → Planner Accept): `plan_day` came with `end_time` 23:00 and the note on 4 of 4 runs; the time for mealprep sometimes went to `busy`, sometimes stayed only in the message — `pinFromMessage` covers the second. A correction that also adds something ("…and also add 30 min of reading") is still read as a dump (open, see testing-journal).

### assistant-v32 — a plan request plans right away; one message, every intent (#22, 2026-10-05)
- PM: on a seeded graph "plan the rest of my day" (default explain mode) answered with questions ("What times are you occupied, and what work matters most?") instead of calling `plan_day`, on v29 and v30. The plan rule in "Which call" now names "the rest of my day" and says: plan_day right away, in every mode, never ask first — saved commitments are planned around, the ranking knows what matters; busy time not saved → plan anyway, at most one line after the card. `chat-router.ts` `buildHint` adds a plan hint next to the message when a stated clause asks for a plan.
- Code next to it (#22): `tools/intent-coverage.ts` checks the first acting response's calls against what the user STATED and asks once for only the missing calls (held calls, merged into one turn); a stated change keeps a question off Gemini; ops / priority actions / `mark_task_done` on a node's id called as tools become the right op with the source read from the message; change calls after a pending card are still planned.
- Size (messages.countTokens, free): +68 tokens over v30 (8,706 → 8,774, measured before the merge with v31).
- Live round (6 Haiku calls, synthetic throwaway graph, real route, `scripts/eval-chat-intents.ts`): "plan the rest of my day" ×2 → plan_day card, no reply text; "plan my day, I want 3h on the Italian course" → plan_day with the 3h; "went to the gym this morning, now plan my afternoon" → plan_day card but the gym went to `mark_task_done` on the habit's node id (fixed in code after the run: `asNodeCompletion`; 1 re-check call → gym logged + plan card); the #22 message → gym logged, CV can wait applied, stats focus Suggested; add + move → added + move on the card. $0.029 for the round + $0.003 re-check.
- #22 before/after (10-message set, same route): before 8/10 messages, 22/24 intents; the #22 message itself dropped "CV can wait" in 2 of 4 runs. After: 9/10, 23/24 (twice); the #22 message 5/5. The remaining miss: "I need to book a room for the study group" isn't captured (the capture rule treats "need to" as talk; the model asked when).

### assistant-v31 — standing preferences (#28, 2026-10-05)
- One new paragraph and one new direct tool, `set_preferences` (`tools/preference-mutations.ts`, `docs/preferences.md`): "I want to spend 4h a day coding", "no work after 10pm", "I'm sharpest 9–12" are saved for every future plan and Focus (source "user" applies at once with Undo; "suggestion" waits). "make it 3h" / "forget the coding thing" update / remove the one listed in the new `[STANDING PREFERENCES]` snapshot block by id; a code guard turns an add for something already saved into an update (no duplicates). "Just for today" stays a plan_day include.
- Size (countTokens, free): static prefix +608 tokens over v29 (8,365 → 8,973 measured before the merge with v30: tool ~460, paragraph ~150), cached like the rest.
- Live check (one round, throwaway user, real chat route → DB, 5 Haiku turns): "I want to spend 4h a day coding, and no work after 10pm" → budget 240 linked to the Coding project + hours until 22:00, card "Saved for your plans" with Undo (Undo emptied the list); "actually make the coding 3h" → same id, 180 min; "stats lecture every tuesday at 2pm" → set_commitments as before; "plan the rest of my day, fit in 1h of Italian" → plan_day include "1h of Italian" only (the budget is added by code); "forget the coding thing" → removed. $0.0017–0.0130 a turn (first turn of a session $0.0130, cache write).

### assistant-v30 — "I went off schedule" → replan_today (#27, 2026-10-05)
- One rule in "Which call": "I went off schedule", "missed the gym", "running 2h late", "redo my afternoon" → `replan_today` (new DIRECT tool, `lib/ai/tools/replan.ts`), source "user", no confirming; `missed` = ids of what they missed or drop today; a missed habit is never completed; the card is the reply (one short line, no times); no "Today's plan" in the snapshot → `plan_day`. The snapshot now carries today's plan from the Planner (times, ticked or not) instead of the latest accepted session's blocks. Spec: `docs/replan.md`.
- Size (messages.countTokens, free): tools + system 8,310 → 8,706 tokens (+396, cached static part).
- Live round (2 calls, synthetic throwaway workspace with a plan made "this morning", one block ticked): "bro i went off schedule and i missed my workout" → replan_today with the gym as missed: gym off today's plan and recorded missed (no check-in), the 4 other unfinished blocks re-timed from 16:00 around a hand-typed 17:00 call, the ticked block untouched, Undo restored all 7 rows exactly ($0.0148, cold cache; the reply restated the times → the "card is the reply" line was added). "ugh running like 2 hours late, redo my afternoon" → replan_today with start_time ≈ now + 2h, one-line reply, no times ($0.0128).

### assistant-v29 — habits done, advice in its own call (PM check of v28, 2026-10-04)
- The PM's live check of v28 on main, first message of a session: "did the gym this morning. also the CV update can wait till next week, should I focus on stats or the internship today?" → the gym wasn't logged (the reply told the user to tick the habit themselves), the assistant's own "Pass Statistics Midterm — focus this week" was APPLIED next to the CV's "can wait", and a second round's "Done." was glued onto the answer.
- Prompt: a habit they did ("did the gym this morning") is a completion that logs today's check-in — never "tick it yourself"; advice next to a stated fact goes in its OWN update_priorities call with source "suggestion", with this exact message as the example ("all in ONE call" had pulled the advice into the user's call); the change ops are named as ops inside change (v28's "→ ONE remove_edge" made Haiku call a `remove_edge` tool once — added after the run below, not re-run).
- Code next to it: `tools/advice-guard.ts` — in a message that asks something, a focus / can-wait / stakes / drop row of a "user" update_priorities call counts as the user's only when a clause they stated carries that kind of word; otherwise it splits off and waits on a Suggested card while the stated rows apply. A change op called as a tool becomes that op inside change (`asChangeOp`). A new text block starts a new paragraph in both chat routes.
- Eval (synthetic 39-node workspace, throwaway user, real route, 6 Haiku calls): the PM's message in the browser → one round: the answer first ("You should focus on stats today — …"), then Marked done · Go to the gym (habit_completions row, the habit stays active) · Undo, What matters · Update CV — Can wait · Undo, and Suggested · Focus on Pass Statistics Midterm this week · Apply / Skip ($0.0146, the session's first message). add / move / plan / steps → same cards as v27/v28; unlink → Unlinked, but via the stray `remove_edge` call and a second round (fixed after the run, above). $0.0024–0.0045 per warm message; $0.039 in total.

### assistant-v28 — the same rules at half the size (fix list #19, 2026-10-03)
- The static prefix (system prompt + tool schemas), written to the cache at the start of every chat session, went from 13,084 to 8,119 tokens (`messages.countTokens`, Haiku 4.5): system prompt 6,950 → 3,460, tools 6,134 → 4,659. v27 said most things twice — in the prompt and in the tool descriptions (node types, the update_priorities actions, the commitment rules, the read-only tool list, the change ops). Each rule now lives once: what a call does in its tool description, when to make it in the prompt. Nothing was dropped on purpose; examples were cut where a rule already said it.
- Two lines added after the real pass: `update_priorities` names the confusable actions again ("deprioritize ('X can wait')", "wait … 'took the exam, waiting for results'") — trimmed out, "Learn X can wait" became a paused "waiting for better timing"; and "the card lists what moved — don't describe it" in Priorities (a reply had restated the card). write_steps: its card is the reply (one reply said "I'll break down the dataset cleaning work into steps for you.").
- Code next to it (same item): the static block's cache TTL is 5 minutes, not 1 hour (`AI_ASSISTANT.STATIC_CACHE_TTL`, env `CHAT_STATIC_CACHE_TTL=1h` to go back — config.ts says when); the snapshot shows importance in steps of 5 and the chat route keeps sending the snapshot it sent last plus the lines that changed (`snapshot-pin.ts`), so a graph change no longer re-writes ~2K cached tokens; one round fewer when every tool call already landed as a card (`turnNeedsNoFollowUp`); "what should I focus on today?" goes to Gemini Flash-Lite like other plain questions.
- Eval (synthetic 39-node workspace, throwaway user, 6 messages through the real chat route in one burst, before and after; then 5 messages in the browser): add / move / unlink / plan my day / break X into steps → the same tool calls and cards before and after. "did the gym and finished my CV — stats or internship?" → v27: both done + a `focus` it APPLIED as the user's (advice applied — against assistant-v26's rule) and a second model round (30K input); v28: both done, the advice in words, one round. Haiku cost per message, warm: v27 $0.0024–0.0080, mean $0.0044 (the static block happened to be warm from another session); v28 $0.0020–0.0040, mean $0.0029; the session's first message $0.0128 (v27 measured on 9/30–10/01: $0.029–0.031). Real pass: Gemini answered "what should I focus on today?" ($0.0008); steps → Suggested · 6 → Apply; "add call the bank … under Life Admin" read the pinned snapshot (9.6K cached, 718 written, $0.0025). Total spend $0.114.

### assistant-v27 — the reply doesn't repeat the card; steps go to the step-writer; unlink without lookups (2026-10-03)
- Fix list #6: "Answer first, then the card" gained two rules — never restate what the card lists (a short natural line like "Added. Nice work on the CV." is fine), and never describe the tool as coming or under way ("I'll add…", "Adding…", "Let me…"): it runs in the same response. `REPLY_LENGTH` now binds advice and opinions too (1–3 sentences, under 60 words, plain prose, no bold anywhere), and steps never go in text.
- Fix list #7: new tool `write_steps` (tools/steps.ts → lib/ai/step-writer.ts, prompt `steps-v1`). "Break X into steps" / "a roadmap for X" / "where do I start" → Haiku calls it with the node; ONE focused Sonnet call writes the steps from the node, its parent, what's under it and the user's words; they wait on a Suggested card. The Sonnet chat route (`usesSonnet` / `inBreakdownThread`) is gone — chat is Haiku, its follow-ups too. `buildHint` points breakdown asks at write_steps.
- Fix list #9: the grounding rule "connections need get_node" made Haiku look both nodes up before an unlink; the rule now says removing a link needs no lookup, and the unlink line and the `remove_edge` op description say "the two ids from the snapshot, in your first response".
- Code next to it: after a change set that applied in full, the chat route no longer runs a follow-up model call just because the message reads multi-step ("…, and add a task") — only when it asks for a step the change can't carry (scheduling, a plan, a reminder: `needsStepAfterChange`).
- Eval (synthetic 16-node workspace, throwaway user, through the browser on the dev server, 4 chat turns): "break Italian Crash Course into steps" → `write_steps` in round 1, no lookup; Suggested · 7 (concrete: greetings, numbers and verbs, a 15-minute speaking practice, a recorded 1-minute intro…), Apply → 7 tasks under the big task with Undo. Haiku $0.0272 (first message of the hour: cache write) + Sonnet $0.0071 (1,347 in / 439 out, 6.7 s); warm it is ≈ $0.004 + $0.007 against $0.075 for the old Sonnet turn. "finally updated my cv, and add a task to email the TA about the ML dataset" → one `change`, CV done + task added with Undo; the reply was "Done on the CV. Adding the email task now." and a follow-up round added "Next: send that email before you forget." after the card (29K input, $0.0064) → fixed after the run by `needsStepAfterChange` (unit-tested) and by adding "Adding…" to the tense rule (not re-run live). "should I focus on money or exams this week? feel like I'm spreading myself thin" → 43 words, plain prose, no bold; the priority change waits as Suggested ($0.0054). "the gym and the stats midterm aren't related, remove that link" → `change` with remove_edge in round 1, no lookup, Unlinked · Undo, 2.5 s, $0.0026.

### assistant-v26 — one `change` tool; whose idea it is decides what happens (2026-10-02)
- Eight node/edge tools (propose_node, propose_nodes_batch, propose_changes_batch, propose_edge, propose_merge, update_node, archive_node, complete_node) became ONE, `change` (lib/ai/tools/change.ts): a list of ops — create_node · move · update · create_edge · remove_edge · complete · archive · delete_node · merge — and a required `source`. `source: "user"` (the user asked for it or said it happened) goes through the dump policy (turn-policy.ts): new items, things done and links apply at once with Undo; moves, renames, archives, deletes and merges wait on the card, row by row. `source: "suggestion"` (the assistant's own idea) waits, all of it. `build_graph` uses the same policy. `update_priorities` / `set_commitments` take the same `source`: a suggestion waits on a card.
- New prompt rules: "Advice is a suggestion" (asked "money or exams?", answer in words; a priority change that follows from the advice goes in with source "suggestion"); a message with a fact AND a question gets two calls (the fact as "user", the advice as "suggestion"); remove_edge needs only the two ids; delete_node only when the user says delete, otherwise archive. The "When to propose" list became "Which tool" in change ops.
- Why (owner, 2026-10-02): asked "money or exams?", the assistant applied its own advice (two classes to "focus this week", reselling to "can wait") — "it shouldn't apply it in the graph immediately". And chat should behave like a dump: what you clearly said happens, with Undo; only reorganizing waits.
- Eval (8 synthetic messages through the real tool layer on a throwaway workspace, then 2 reruns after two rule fixes): add → applied; "finished X and did the gym" → both done at once; "fixed my sleep schedule — money or exams?" → the sleep task completed (user) and the advice stayed words (first run: a suggested-priorities card, nothing applied; the fact-plus-advice rule fixed the missed completion); move → waits; "remove that link" → unlinked at once (still looks both nodes up first, ~$0.003); "break the thesis proposal into steps" (Sonnet) → 7 steps on a Suggested card; delete → waits; "focus on stats, reselling can wait" → applied. Haiku $0.0034–0.0069 warm ($0.026–0.028 with the cache write), Sonnet breakdown $0.075; total $0.165. End to end in the browser (dev server, throwaway user): the owner's money-or-exams case showed "Priorities updated: Go to the gym — Done · Undo" and a "Suggested priorities" card with Accept/Reject, nothing applied.

### assistant-v25 — answer first, then the card; plan_day busy time (2026-10-02)
- New "Answer first, then the card" block: a message that needs a reply AND a graph change gets the reply first, complete, in the same response, with the tool call last. No "Mark X done first." announcements, no answer held until after Accept. A plain update or command keeps "the card is the reply". The three "card IS the reply: at most one short sentence" rules (build_graph, update_priorities, set_commitments) now allow the answer when the message also asks something.
- "Never write that something changed unless a tool call in this turn did it": on 2026-09-30 the model told the owner "Daily Gym is marked done" with no tool call.
- `plan_day` tool (planner-mutations.ts, not this prompt): `start_time` + `busy` (one-off busy time named in chat). The description says to plan right away instead of first asking whether the busy time repeats.
- Server guard (`answerStillOwed`, confirmations.ts): after an Accept, the one-line "Done ✓" shortcut is skipped when the user asked something and the turn wrote under 140 characters before its card, so the answer can't be dropped.
- Why (owner, 2026-09-30): "First it should reply with everything in chat, then if there are certain actions … we should be asking for THOSE." In his "fixed my sleep schedule — money or exams?" turn the model wrote "Mark 'Fix Sleep Schedule' done first." and answered only after the Accept. The answer survived only because the message contained "also" (`looksMultiStep`).
- Eval: end to end through the real chat route on a synthetic 13-node workspace (throwaway user, dev server, `scripts/test-e2e-b0.ts`), 3 turns. (1) "did my skincare and my stretching today" → one card completing both habits, Accept → both logged for today. (2) The owner's sleep/money-vs-exams message → the answer came first in the bubble ("…Focus on Pass Machine Learning Exam and Pass Probability 2 Exam this week, then layer in Clothes Reselling…"), then the cards; Accept → completed. (3) "schedule from 2:30 to 11 pm, lectures 2:30 to 6:30 today" → `plan_day {custom 510, start_time 14:30, busy: Lectures 14:30–18:30}` with no "is it weekly?" question; the plan covered 4h30 of free time, and accepted tasks landed at 18:30–22:50, none in the lectures. Haiku turns $0.0029–0.0039 warm ($0.0301 for the first, cache write); plan $0.0115 (Sonnet, 7.6 s; was 16–19 s for 8h30 on 2026-09-30). Total $0.053.

### assistant-v24 — build_graph (2026-09-30)
- New tool `build_graph`: the chat model hands a restructure or a multi-item capture to the graph builder (the extraction prompts above) instead of planning it itself. The "Restructuring" section shrank from five paragraphs of how-to (new parent placement, fused nodes, children, nesting) to a routing rule — one plain move is still `propose_edge`; anything more is `build_graph`. Those rules now live once, in the builder's prompt.
- `propose_nodes_batch` is for steps the model itself writes (a breakdown); `propose_changes_batch` for a small mix or a bulk status change. Direct tools may share a turn with a card (the server no longer rejects them as a second action).
- Routing: every chat turn is Haiku except a generated breakdown (`looksLikeBreakdownAsk`). A hint line in the message block points at `build_graph` when the message reads like a restructure or a dump.
- `note` on `build_graph`: in the first eval Haiku filled it on every call, once with a wrong paraphrase ("finished the italian placement test" → "finished Italian Crash Course") that made the builder complete the wrong node. The description now forbids paraphrasing and the server ignores the note unless the message is a bare "yes" or is short.
- Eval (one Haiku call each, prompt + tools + snapshot assembled as the route does): right tool 6/6 — `build_graph` for a new parent over existing nodes, a move that keeps a link and a multi-item update (2×); `propose_node` for "add a task … under the internship goal"; `complete_node` for "mark … as done". $0.0022–0.0026 per warm turn (14.3k input, 13.9k read from cache), $0.0285 on the first turn after the prompt changes.

### assistant-v23
- "Restructuring" block: a move is `propose_edge` belongs_to (the old parent link is replaced by the tool); a regroup is ONE `propose_changes_batch` — create the new parent (local_ref), rename the fused node, move it, create its sibling; a node that still helps its old parent keeps a useful_for / supports link in the same Accept. Never "I can't re-parent", never "in stages".
- Every new node gets a parent_node_id.
- Why (2026-09-30): re-parenting failed on the single-parent index and chat said it had no tool for it; a regroup was split across turns, created the project as a `contains` orphan, and the connection engine then nested it under its own task.
- Eval (prompt + tools + real handlers, throwaway workspace, not the HTTP route): the Italian message → one card [move under Personal Development, useful_for the internship], $0.084 (first Sonnet turn of a thread, cache write); "yeah" to the dump's restructure question → one card, 5 changes, BrainDump project with Test / Market under it, $0.016.

### assistant-v22
- New direct tool `set_commitments` + a "Fixed commitments" block: recurring busy times (class, shift, practice) are saved at once with an Undo; "every day" for a class/job = Mon–Fri; dates are the user's words (`until` / `from`), resolved in code; change/remove by the id in the snapshot's new `[FIXED COMMITMENTS]` list. One-offs stay `add_task_to_calendar`.
- Why: "stats every day at 2pm" lived only as free text; Focus and the planner couldn't see busy time (docs/commitments.md).
- v11–v21 are logged in STATUS.md's journal and docs/ranking.md, not here.

### assistant-v10
- Removed the `<plan>` time-block instruction + JSON example. It had no client consumer (app-shell parses only `<nodes>`/`<graph_edit>`/`<recompute_scores/>`), so asking the chat to "plan my afternoon" dumped raw JSON into the reply. Multi-block planning now routes to the dedicated Planner; single items use add_task_to_calendar.
- Why: dead, token-wasting instruction that produced unconsumed output (found in v1.5 review).

### assistant-v4
- Added full mutation tool vocabulary: propose_node, propose_nodes_batch, propose_edge, update_node, archive_node, complete_node, add_task_to_calendar, reschedule_task, mark_task_done
- Every mutation tool pauses the agent loop and surfaces an Accept/Reject card via the M2 confirmation gate
- Added "ONE mutation per turn" rule (server auto-rejects extras) with guidance to call propose_nodes_batch for multi-item asks
- Replaced the `<nodes>` and `<graph_edit>` tag protocols with direct tool calls; kept `<recompute_scores/>` and the planner `<plan>` block (not yet migrated to tools)
- Added tool-selection guidance per intent ("add X"→propose_node, "break into steps"→propose_nodes_batch, "I finished"→complete_node, etc.)
- Why: M3 replaces the old text-tag mutation path with tool-use so mutations go through the confirmation gate by default

### assistant-v3
- Reframed from "answer the query" to "collaborator the user thinks out loud with"
- Added engagement rules: acknowledge first, clarify when ambiguous, act decisively when confident
- Added tool-use guidance for read-only agent loop (search_nodes, get_node, get_recent_activity, get_workspace_summary, get_calendar)
- Added tone rules: match user energy, no sycophancy, emotional acknowledgement only when warranted
- Kept legacy `<nodes>` / `<graph_edit>` / `<plan>` / `<recompute_scores/>` tags until M3 mutation tools replace them
- Why: M1 agent loop needs a prompt that treats tools as the default grounding mechanism and pushes clarifying questions for genuinely ambiguous asks — no more "CREATE THE NODES" for every ask

### assistant-v2
- Added mode system (explain, plan, transform)
- Added anti-generic-advice rule: "Never produce a generic self-help tip that ignores graph context"
- Why: assistant was giving Buzzfeed-tier productivity tips instead of using graph data

### assistant-v1
- Basic graph-grounded assistant with context injection

---

## Brain-dump side reads (`dump-priorities.ts`, `dump-reply.ts`)

### dump-reply-v3 (current) — no borrowed facts (2026-10-02)
- The acknowledgement rule's example sentence ("four hours of sleep and a midterm in three weeks is a lot") is gone, and so are the sample phrases in the ACK verdict. New rule: about them and their day, only what the dump says — never add how much they slept, how they feel or what happened; facts about their items come only from the plate.
- Why: in the end-to-end check of the combined branch, "did the gym today. ugh im exhausted, what should i do first tonight?" got "Four hours of sleep and a midterm in three weeks is a lot." — the prompt's example, copied word for word.
- Eval (6 synthetic dumps incl. that one, $0.0061): "You got the gym in today even though you're exhausted." + an answer naming the closest deadline; day story → one sentence; items only → NONE; "money or exams?" → exams, with dates as evidence; vent + "what would you drop?" → acknowledgement + the week's weight (did not name a drop this time); landlord vent → one sentence, nothing invented.

### dump-reply-v2 — every dump is read; a verdict line first (2026-10-02)
- The word filter (`looksConversational`) is gone: every dump gets the read (~$0.001), so a dump that only tells about the day ("long day, the 8am got cancelled…") gets its one sentence too. The model now writes a verdict on the first line — `NONE` (only items, dates, updates, instructions) · `ACK` (vents, ask nothing) · `ANSWER` (asks you something) · `BOTH` — then the reply. An acknowledgement gives no advice and names nothing they didn't mention; an answer answers in their terms ("money or exams?" → which one, and why). What they say they finished in this dump is never suggested as still to do (the plate is read before the builder applies it).
- Length is enforced in `parseDumpReply`, not asked for only: ACK keeps its first sentence; ANSWER/BOTH stop at the last whole sentence within 60 words, never before the answer's first sentence.
- Why: the owner's pure-venting dumps in the Brain Dump box got "found nothing to add or change"; v1 replies ran ~70 words.
- Eval (5 synthetic dumps, a 10-item plate). Without the verdict line, the prompt alone answered an items-only dump, gave unasked advice after venting twice, and named a problem set the user had just finished. With it: day story → one sentence (21 words); items only → NONE; "money or exams?" → "Exams come first — Probability 2 … the reselling shifts are open-ended and can wait"; vent + "what would you drop?" → acknowledgement + drop Italian and reselling (no deadline); "mom's visiting, finished the CV" → NONE. $0.0049 per round of 5, two rounds.

### dump-reply-v1 — the human half of a dump (2026-10-01)
- New. A small Haiku read, run next to the graph builder only when the dump has a human part (`looksConversational`: a "?", venting or feeling words), answers it in 1–3 sentences above the dump's card: acknowledge what they said with their own specifics; answer a direct question ("what would you drop?") from what is on their plate (top-ranked work items with dates and holds); never describe the graph changes (the card does). `NONE` → no reply.
- Why: `docs/unified-turn.md` phase 3. Until now a dump's question came back as a "clarifying question" in a modal and nobody answered it.
- Eval (the mixed dump, 2 runs): both acknowledged the 4 hours of sleep and answered with a concrete drop (Italian crash course — no deadline; Clothes Reselling — no deadline, no steps). $0.0012–0.0013, ~2 s, in parallel with the builder. Replies ran ~70 words against the 55 asked.

### dump-priorities-v5 (current) — standing preferences (#28, 2026-10-05)
- A third section, "preferences": a time budget, working hours, best hours or another standing rule about their time, each with `said` = the user's words (`parseDumpPriorityResponse` drops a row whose words aren't in the dump, like stakes/focus). Saved through set_preferences' engine and shown in the dump's "Your week" card next to weekly times, under one Undo. "4h a day on X" is named as not a focus; no "unclear" question about a preference. The read also runs on a dump with no existing nodes when `mentionsTimePreference` (regex) sees a time wish.
- Size: 1,180 → 1,445 system tokens (+265, ~$0.0003 a dump read).
- Eval (5 synthetic dumps, the read alone, $0.0107): "from now on 4h a day coding + took the midterm, waiting on the grade" → budget 240 linked to Coding + wait (no focus); "no work after 10pm, sharpest 9 to 12" → hours 22:00 + peak 09–12; "today I'll code for 3h then gym" → nothing; "2 hours of italian every weekday, gym in the mornings" → budget Mon–Fri linked + rule linked to the habit; "coding is killing me" → nothing. 5/5. Before the focus/unclear lines, one end-to-end dump (all four test messages in one text) also put "focus this week" on Coding and asked whether the rule was standing — the two lines added for that, not re-run end to end.

### dump-priorities-v4 — stakes and focus only from the user's words (2026-10-03)
- Fix list #5: a dump anxious about the internship came back as "high stakes" on the internship goal although it never said what rides on it. Stakes now need the user to SAY what rides on it or that it counts more or less; worry, stress, "I really need to get it" are mood → no change. stakes / focus / deprioritize rows carry `said` (the user's exact words) and `parseDumpPriorityResponse` drops a row whose words aren't in the dump. "everything else can wait" names no item; the workspace root is no longer offered to the read at all (code).
- Eval (5 synthetic dumps against the seeded 16-node workspace, the read on its own — nothing applied): tone only ("so stressed about the internship… i really really need to get it") → no change; "my whole masters application depends on getting it" → stakes high on the internship goal; "focus on stats this week" → focus on Statistics; "the stats midterm got moved to oct 22" → deadline on the midterm; "did the stats midterm this morning, now waiting for the results" → wait. First run 4/5: the stakes row came back as `"level":"high"` and failed validation → the prompt now shows a full stakes row and the parser also reads `level`; rerun of 3 cases 3/3, but "everything else can wait a bit" became deprioritize on the root area "Life" → the root filter and the "names no item" clause (not re-run). 10 calls, $0.0167; ~1,350 in / 20–110 out, 0.7–1.2 s each.

### dump-priorities-v3 (2026-10-01)
- A date or to-do for a step or new piece of work inside a listed class/project is a new item, not a deadline or focus for the class ("for ML I have to pick a dataset by friday" dated the class Machine Learning). One fact changes one item — the most specific ("stats midterm is oct 20" dated the midterm goal AND the class). Reorganizing requests are another step's job — no change and no "unclear" question. Questions name items by title; the parser also replaces refs (`n12`) the model writes anyway.
- Eval: the mixed dump, before → after: the class no longer gets the step's date; the midterm-and-class double deadline did not recur in the last run.
- 2026-10-02: a date on a to-do ABOUT an item is the to-do's ("email prof marino about the stats midterm review by friday" had moved the midterm to Friday); now an example in the deadline line. Same eval as extract-light-v6: midterm only moved by "got moved to oct 22".

## Step-writer (`steps.ts`)

### steps-v1 (current) — one focused call writes the steps (2026-10-03)
- New: `lib/ai/step-writer.ts` — chat's `write_steps` and the Details panel's Quick steps / AI roadmap use the same call, so both write the same steps. It sees the item (title, type, description, deadline), its parent, what is already under it (done ones marked) and the user's words; JSON schema enforced. Shapes: `next` (1–3 actions, Haiku), `steps` (3–7, Sonnet), `roadmap` (2–4 phases of 2–4 steps, Sonnet). Steps already under the item are dropped in code. The rules are suggest-steps-v2's: start where it stands (and unblock first), real work not planning-to-plan, concrete doses for studying, phases named for what finishes them.
- Replaces: a breakdown's whole chat turn on Sonnet (~$0.075), and suggest-steps-v2 (Haiku wrote brain-dump text, then a second Sonnet extraction turned it into proposals for the old review modal).
- Eval (see assistant-v27): chat "break Italian Crash Course into steps" → 7 steps, $0.0071, 6.7 s. Details → AI roadmap on the class "Machine Learning" (which held "Email the TA about the ML dataset") → 4 phases × 3 steps, starting with "Unblock the project dataset" (follow up with the TA if no reply by Oct 5, then inspect and load the data), then lectures + practice problems, EDA, a baseline model; $0.0103 (1,341 in / 762 out, 9.3 s).

## Planner (`plan.ts`)

### plan-v9 (current) — every request in, the user's note, meals by the clock (2026-10-06)
- USER REQUESTS: they are what the plan is for; a line with related open tasks fills its time with them ("2h of leetcode" → each LeetCode task); an unmatched line is titled with the user's words and never dropped or swapped (mealprep, cleaning). Request lines carry `related open tasks` and `title: "…"`.
- THE USER ABOUT TODAY: "sick / tired / light day" in the context → at most two deep-work blocks of ≤60 min, light items first, end with Free time.
- Meals: lunch starts 12:00–14:00, dinner 18:30–20:30 by the clock; count the clock through the free stretches (Wednesday's plan put "Lunch" at 20:00).
- Code around it (`validatePlanOutput`, `plan-requests.ts`): requests are guaranteed after the model (left out → added, short → topped up, unmatched with no length ≥30 min), Free time and unasked work make room; repeats of one item fold into one block unless together >2 h; bracketed lists don't split ("6h academics (Calculus, Probability, ML)"); clock-timed items are fixed time, not requests.
- Live round (synthetic, 3 calls, $0.031): Tuesday-like sick day — all 4 requests in, two of them not in the graph, no deep work over 60 min, dinner 20:15; Wednesday-like — academics exactly 6h over the three classes, lunch 13:40; "2h of leetcode" (Haiku) — both LeetCode tasks, 60 + 60.

### plan-v8 — time blocks for bigger things; what the user asks for (2026-10-04)
- The Session block gains two sections, empty (and absent) when there is nothing to list: **Time blocks** — a class, or a goal / project / big task with open steps, with its next 1–2 open steps ("start with …", picked in code by the user's order) — and **The user asked for** — "3h of Italian, 2h of math" from the Planner's new "Anything to fit in?" box or chat's `plan_day` `include`, matched to a node by its words in code (`lib/planner/plan-requests.ts`), unmatched lines passed as words.
- New rules: a time block is ONE block on the item itself (node_id = the item), 45–180 min, and covers its steps (no separate block for them); it never pushes out a work item with a deadline signal; every request MUST be in the plan, and a request over 2 h may be two blocks with a break between. "Carry-over" now means dated work left undone (undated leftovers are asked about instead, `lib/planner/skips.ts`).
- Code around it (`validatePlanOutput`): a step whose time block is in the same plan is dropped; a matched request the model left out is put first at its length; a time block's reason starts with "Start with “…”, then “…”" (first block only).
- Why: owner, 10-04: "AI should be able to place 3h for Italian crash course without necessarily putting a certain task … 3h of English or 2h of math". Until v7 a class or a goal with steps could never get time — only its leaf steps.
- Eval (throwaway user, seeded synthetic graph, 5 plan calls, $0.10 incl. one chat turn): the same 08:00–23:00 day as the v7 run — v7 gave Italian three separate lesson blocks and BrainDump two step blocks; v8 gave "Italian Crash Course" 90 min, "BrainDump launch" 90 min, "Machine Learning" 120 min (a class, no steps), Renew passport (due in 5 days) still first, nothing double-booked ($0.0209, 3,804 in / 1,326 out). Planner "Plan today" from 16:00 with "2h of Italian, 1h30 of math": both in, Italian 120 min starting with its first two lessons — but that run dropped the passport task for time blocks, which added the "never pushes out a deadline" rule; its first attempt failed validation (a 0-minute block) and was retried ($0.0286 for both). Chat "plan my day from 8am — I want 3h of Italian and 2h of math in it": Haiku filled `include`, the plan has passport first, "2h of math" (no node), Italian 2 h + 1 h around lunch ($0.0191 plan + $0.0125 chat turn). Prompt +550 tokens when there are time blocks (countTokens: 2,841 vs 2,295).

### plan-v7 — a whole waking day (2026-10-03)
- A day plan runs from its start (the time the user gave, else now; 08:00 on another day) to 23:00, up to 18 h, instead of a fixed 8 h; custom windows go to 18 h (were 10 h). One module sizes it for the Planner, the plan route, chat's `plan_day` and `buildPlan`: `lib/planner/plan-window.ts`.
- The Session block names the clock span ("session 08:00–23:00"). New rules: a long session (5+ h) gets a break about every 2 h of focus and lunch / dinner at normal times, hardest work early; never invent work, repeat an item or add a block for busy time — when the work runs out, ONE "Free time" break; reasons are one short clause (≤12 words).
- Code around it: the JSON schema is now enforced on Sonnet too (it was Haiku only); a block that only restates a fixed commitment is dropped before the free minutes are packed (`validatePlanOutput`); output cap 6,144 → 16,000 tokens; an answer cut off at the cap becomes "This plan was too long to finish in one go…" instead of "invalid response".
- Why: the owner plans ~15 h a day. On the first 15-hour run (Tuesday, lecture 14–16 and practice 18–20) Sonnet wrote ~25 blocks on clock time including a 4-hour "Stats lecture" placeholder; the validator packed it into the 660 free minutes and dropped everything after it (dinner, the evening) — 4,368 output tokens, $0.049, 31 s.
- Eval (throwaway user, synthetic workspace, through the app): 15-hour Planner plan on that Tuesday → work 08:00–14:00 with lunch, gym 16:00–17:30, dinner, evening work, "Free time" to 23:00, nothing in either commitment — $0.036, 20 s (that run still paid a failed first attempt; the schema went on after it). Chat "plan my day from 8am, dentist 11 to 12" → 08:00–23:00, nothing 11–12, lunch + dinner — $0.017 (1,186 output tokens), 10 s, one attempt. 2-hour plan → Haiku, $0.004, 6.5 s, unchanged.

### plan-v4 – plan-v6
- Not logged here at the time: v4–v6 added fixed commitments (busy time and free stretches in the Session block, docs/commitments.md) and the Haiku/Sonnet split with an enforced schema on Haiku.

### plan-v3
- Replaced the fixed "focus blocks 25–50 minutes" rule with content-grounded sizing: estimate each block's duration from the item's title/summary/type (quick chore ~10–15m, normal task ~30–45m, deep work 60–120m), and explicitly do not pad everything to one length
- Why: the planner was inventing uniform durations ungrounded in the actual work — a one-line reply and a multi-hour task got the same block. The planner already has each item's content, so it can estimate per-item without a separate duration service.

### plan-v2
- Added candidate planning signals (due soon, blocked by, unblocks, carry-over, recently unblocked)
- Added rule for manual planner items from workspace context to be schedulable with `node_id = null`
- Why: the planner needed richer backend signals and a way to account for standalone manual tasks without flattening everything into generic blocks

### plan-v1
- Initial planning prompt with time blocks, breaks, buffer
- Block types: focus, admin, break, buffer
- Rules: 25-50 min focus blocks, breaks for 90+ min sessions, 10 min end buffer

---

## Embeddings

### embed-v1 (current)
- Gemini text-embedding-004, 768 dimensions
- No prompt changes — uses model defaults

---

## Reranking

### rerank-v1 (current)
- Cohere rerank-v3.5
- Fallback: lexical scoring when Cohere is unavailable
