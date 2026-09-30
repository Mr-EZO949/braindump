# Prompt Version Changelog

All prompt changes are tracked here. Each entry records the version, what changed, and why.
Run `POST /api/eval/run` before and after changes to verify regression.

---

## Extraction (`extract.ts`)

### extract-v24 (current) · extract-light-v4
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

### assistant-v23 (current)
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
