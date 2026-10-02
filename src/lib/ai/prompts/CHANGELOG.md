# Prompt Version Changelog

All prompt changes are tracked here. Each entry records the version, what changed, and why.
Run `POST /api/eval/run` before and after changes to verify regression.

---

## Extraction (`extract.ts`)

### extract-v26 (current) — the long prompt quotes edit requests; the short prompt carries them out (2026-10-01)
- The long prompt no longer plans edits. A sentence that asks to change EXISTING nodes is copied word for word into `edit_requests`, and the long prompt creates nothing for it. `runBuilder` (extraction.ts) then runs those sentences through `extract-light-v5` with child-expanded retrieval — the same call that does a one-line restructure from chat — and merges the result (refs prefixed `e_`, its nodes first so dedup keeps them). The `changes` schema left the long prompt; the "Edits to existing nodes" section became a short "quote it" section.
- Why: on long dumps the long prompt planned a new-parent reorganization badly in 4 runs of 5 (moved nodes under a local_ref it never proposed; or created the project and forgot the move), while the short prompt got the same request right 8 of 8. The difference is how much else is on the page.
- From the first end-to-end runs of a long MIXED dump (venting + a question + completions + new work with dates + two reorganizations + two stated links + a weekly class time): read the dump to its last line ("also need to call the bank" was dropped); a habit done today is a completion (the full prompt lacked the rule); steps the user names are children with the date on the step (a "pick a dataset by friday, then write the proposal" became one big task); a weekly fixed time is a commitment, never a habit node; a soft link may target an existing node's id (the model had invented a copy of an existing goal to link to and lost the link with it); venting and questions to the assistant produce no clarifying question (`dump-reply-v1` answers them).
- Eval (synthetic 16-node workspace, throwaway user, the 1,136-char mixed dump, end to end in the browser): 3 runs while the prompt moved from "changes first" to "quote and hand off". Final run: every item captured (10 new nodes incl. the bank call and the named ML steps), gym logged + CV done, both reorganizations exactly as asked (BrainDump project with Test/Market and the old fixes moved along; Italian under Personal Development keeping `useful_for` the internship), both stated links, the class as a commitment and no habit node. $0.0425 (13.4k in / 1.6k out, 13.8 s) + edit pass $0.0129 (6.4 s).

### extract-light-v6 (current) · extract-v26 — the user's date words (2026-10-02)
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

### infer-edge-v5 (current)
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

## Assistant (`assistant.ts`)

> Note: this changelog drifted (entries jump v4 → v10; the live constant is the
> source of truth, now mirrored by the derived `PROMPT_VERSIONS` map). The
> intermediate v5–v9 changes predate this entry and weren't logged here.

### assistant-v25 (current) — answer first, then the card; plan_day busy time (2026-10-02)
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

### dump-reply-v2 (current) — every dump is read; a verdict line first (2026-10-02)
- The word filter (`looksConversational`) is gone: every dump gets the read (~$0.001), so a dump that only tells about the day ("long day, the 8am got cancelled…") gets its one sentence too. The model now writes a verdict on the first line — `NONE` (only items, dates, updates, instructions) · `ACK` (vents, ask nothing) · `ANSWER` (asks you something) · `BOTH` — then the reply. An acknowledgement gives no advice and names nothing they didn't mention; an answer answers in their terms ("money or exams?" → which one, and why). What they say they finished in this dump is never suggested as still to do (the plate is read before the builder applies it).
- Length is enforced in `parseDumpReply`, not asked for only: ACK keeps its first sentence; ANSWER/BOTH stop at the last whole sentence within 60 words, never before the answer's first sentence.
- Why: the owner's pure-venting dumps in the Brain Dump box got "found nothing to add or change"; v1 replies ran ~70 words.
- Eval (5 synthetic dumps, a 10-item plate). Without the verdict line, the prompt alone answered an items-only dump, gave unasked advice after venting twice, and named a problem set the user had just finished. With it: day story → one sentence (21 words); items only → NONE; "money or exams?" → "Exams come first — Probability 2 … the reselling shifts are open-ended and can wait"; vent + "what would you drop?" → acknowledgement + drop Italian and reselling (no deadline); "mom's visiting, finished the CV" → NONE. $0.0049 per round of 5, two rounds.

### dump-reply-v1 — the human half of a dump (2026-10-01)
- New. A small Haiku read, run next to the graph builder only when the dump has a human part (`looksConversational`: a "?", venting or feeling words), answers it in 1–3 sentences above the dump's card: acknowledge what they said with their own specifics; answer a direct question ("what would you drop?") from what is on their plate (top-ranked work items with dates and holds); never describe the graph changes (the card does). `NONE` → no reply.
- Why: `docs/unified-turn.md` phase 3. Until now a dump's question came back as a "clarifying question" in a modal and nobody answered it.
- Eval (the mixed dump, 2 runs): both acknowledged the 4 hours of sleep and answered with a concrete drop (Italian crash course — no deadline; Clothes Reselling — no deadline, no steps). $0.0012–0.0013, ~2 s, in parallel with the builder. Replies ran ~70 words against the 55 asked.

### dump-priorities-v3 (current) (2026-10-01)
- A date or to-do for a step or new piece of work inside a listed class/project is a new item, not a deadline or focus for the class ("for ML I have to pick a dataset by friday" dated the class Machine Learning). One fact changes one item — the most specific ("stats midterm is oct 20" dated the midterm goal AND the class). Reorganizing requests are another step's job — no change and no "unclear" question. Questions name items by title; the parser also replaces refs (`n12`) the model writes anyway.
- Eval: the mixed dump, before → after: the class no longer gets the step's date; the midterm-and-class double deadline did not recur in the last run.
- 2026-10-02: a date on a to-do ABOUT an item is the to-do's ("email prof marino about the stats midterm review by friday" had moved the midterm to Friday); now an example in the deadline line. Same eval as extract-light-v6: midterm only moved by "got moved to oct 22".

## Planner (`plan.ts`)

### plan-v3 (current)
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
