# One turn — chat and building as a single pipeline

**Status: approved 2026-09-30, order 1 → 2 → 3. Phases 1–3 are built (section 5; phase 3
minus two clean-up items); phases 4–5 are not.** Written after the owner's note that the separation between "just answering" and
"planning / building the graph / extracting / connections" is the thing that feels wrong.
Sections 1–2 describe the app as it was on 2026-09-30, before phase 1.

## 1 · What exists today

Two complete stacks turn words into graph changes. Which one runs is decided **before any
model reads the message** — by which box the user typed in and by regexes.

| | Dump stack — `/api/entries` | Chat stack — `/api/assistant/chat` |
|---|---|---|
| Entry | Brain Dump box; or chat composer → `looksLikeBrainDump` regex → `classify-dump` (Haiku) → "Add to my graph / Just chatting" chooser | chat composer |
| Context | `retrieval.ts`: the 30 nodes relevant to this text, with parents | `context.ts`: top 30 by importance + a few semantic extras |
| Model | Sonnet, one JSON shot, no conversation history | Gemini / Haiku / Sonnet picked by regex (`chat-router.ts`), tool loop, history |
| Can | add nodes, mark done; priorities + commitments through a side Haiku read | add, move, rename, retype, merge, archive, link, complete, priorities, commitments, calendar, plan |
| Cannot | move, rename, split, merge, archive, answer a question, wait for an answer | catch duplicates (no `resolution.ts`), emit dependency / lateral links with the nodes, auto-apply |
| Output | `proposed_nodes` rows | a tool call parked in `pending_chat_runs` |
| Apply | `/api/proposals/nodes/review` (872 lines) | tool handlers in `tools/mutations.ts` (1462 lines) — direct inserts into `nodes` / `edges` |
| After create | embedding, AI judgment, clustering pass, `feedback_events`, dependency proposals | none of those server-side; an embedding only if the browser stays open to call `/api/nodes/analyze` |
| Trust | calibrated auto-apply + Undo; the rest in a modal | an Accept card every time (priorities and commitments: applied + Undo) |
| Conversation | stateless; replaces the chat thread with a client-built summary string | threaded |
| Transport | blocking JSON (5–35 s behind a spinner) | text stream with 3 inline marker formats |
| Size limit | 10,000 chars | 4,000 chars |

So the same sentence gets a different brain, different powers, different memory, a different
confirmation UI and a different object in the database depending on where it was typed. A
node accepted through chat has no judgment, no clustering, no feedback event (so auto-apply
calibration never learns from chat) and may have no embedding (so later dedup can't see it).

### The bridges

Every recent journal fix added a hand-off across the seam instead of removing it:

1. chat → dump: regex → `classify-dump` → chooser → `/api/entries` (`submitDumpFromChat`)
2. chat → dump, legacy: `<nodes>` tag → `handleExtractNodes`; `<graph_edit>` tag → its own modal
3. dump → chat: a fresh thread with a summary built in `app-shell.tsx` (no model wrote it, and
   the next chat turn sees only that sentence — not which nodes were proposed)
4. dump → chat: clarifying questions as fake assistant bubbles; inline answers re-sent as a
   synthetic user turn ("My answers to your questions… act on them now")
5. dump → chat's engines: `dump-priorities` Haiku read → `applyPriorityChanges` / `applyCommitmentChanges`
6. dump → chat: a restructure request becomes a yes/no clarifying question that chat then applies
   (`extract-light-v4` rule 4 — "extraction only adds")
7. chat → connection engine: the **browser** calls `analyzeNodes` after an Accept
8. suggest-steps: Haiku writes steps as text → `/api/entries` extracts them (two model calls)
9. `plan_day` → planner draft → app-mode switch

Same-rule-in-several-places is the symptom: node-type rules live in `extract.ts`,
`extract-light.ts`, `assistant.ts` and the tool descriptions; "a habit done today logs, it
doesn't complete" had to be fixed three times (Details, chat, dump).

Confirmation surfaces today: nodes-review modal, edges-review modal, graph-edit modal
(legacy), pending card, applied card, auto-apply Undo notice, merge alert, dump chooser,
`ask_choice` card — nine.

### Measured (test account, 2026-09-29 → 30, from `ai_runs`)

| Call | n | $/call | input tok | median latency |
|---|---|---|---|---|
| Chat turn, Haiku | 7 | $0.0089 | 17,073 | 2.7 s |
| Chat turn, Sonnet (structural) | 3 | $0.0380 | 33,348 | 7.3 s |
| …its resume after Accept, Sonnet | 4 | $0.0140 | 20,851 | 5.3 s |
| Light extraction, Sonnet | 4 | $0.0132 | 4,534 | 5.2 s |
| Full extraction, Sonnet | 1 | $0.0618 | 11,368 (3,911 out) | 35.2 s |
| `classify-dump` (the chooser) | 5 | $0.0004 | 361 | 0.8 s |
| `dump-priorities` | 4 | $0.0016 | 1,324 | 1.2 s |
| Gemini Q&A | 1 | $0.0010 | 3,337 | 1.5 s |

- Two days: $0.437 total → **$6.55 / 30 d projected, over the $5 target.** Chat is $0.2526 of it (58%).
- Sonnet chat turns are 8 of 19 chat calls but **$0.179 of $0.253 (71% of chat, 41% of all spend).**
- One structural edit through chat ≈ $0.052 and ~12 s of model time in two calls. The same
  model doing a light extraction costs $0.013 with 4.5k input tokens — the chat harness is
  what's expensive: 21 tool schemas (≈6.1k tokens) + the system prompt (≈6.8k) ride on every
  Claude chat call before the snapshot, and a regex hands that whole harness to Sonnet.

## 2 · Root cause

**The app picks a pipeline first and understands second.** Everything downstream — model,
context, powers, trust, UI — hangs off that early guess, so the user feels a wall between
"talking" and "building", and each capability must be built twice or bridged.

## 3 · Target

One conversation. Every input is a **turn**; building is something a turn *does*, not a place
the user goes.

```
composer · Brain Dump box · voice · answer on a card
                     │
              POST /api/turn   { text, thread, surface }
                     │
 1 UNDERSTAND   Haiku orchestrator — warm cache, thread history, ~12 tools
                (Gemini Q&A pre-step stays: it is already a model-made decision)
        ├─ answer ..................... text
        ├─ small change (≤3 ops) ...... change(ops)
        ├─ capture / break down /
        │  restructure ................ build_graph ─► BUILDER (Sonnet, narrow prompt,
        │                               relevance retrieval with parents + children;
        │                               the one place type, nesting and dedup rules live)
        ├─ what matters / busy times .. update_priorities · set_commitments
        ├─ time ....................... calendar tools · plan_day
        └─ unclear .................... ask_choice
                     │
 2 CHANGE SET   one format for everything a turn wants to change:
                create · move · update · link · complete · archive · priority · commitment
                (+ questions), with local refs between ops
                     │
 3 POLICY       per op: apply now + Undo  |  wait for Accept
                deterministic risk class × this user's acceptance history
                     │
 4 APPLY        applyChangeSet — the only writer of AI changes
                (setNodeParent, transitionNodeStatus, embedding, judgment,
                 feedback_events, one rescore, undo snapshot)
                     │
 5 CARD         one card in the thread: applied (Undo) · needs a look
                (Accept / edit / reject) · questions (tap to answer)
                     │
 6 FOLLOW-UPS   server-side after(): connections → a second card in the same
                thread; clustering
```

### The pieces

**Turn.** One endpoint for every input surface. The Brain Dump box stays (frictionless
capture is the product's promise) but it is a *surface*, not a pipeline: it opens a fresh
thread (journal #18 stays) and posts a turn with `surface: "dump"`. The chooser, the
`classify-dump` call and `looksLikeBrainDump` as a fork go away.

**Orchestrator = Haiku, always.** It decides per turn: answer, act, build, ask. It never
carries structural reasoning, so it never needs to be Sonnet — `looksLikeStructuralEdit` /
`inStructuralThread` stop choosing the model. Its tool list shrinks from 21 to about 12:
`propose_node`, `propose_nodes_batch`, `propose_changes_batch`, `propose_edge`, `update_node`,
`archive_node`, `complete_node`, `propose_merge` collapse into **`change`** (a short op list)
and **`build_graph`**. The restructuring, node-type and nesting sections leave its system
prompt.

**Builder = today's extraction, generalized.** Input: the user's words (the tool handler
passes the raw message — the orchestrator doesn't re-type it), an optional one-line
instruction ("break this node into steps", "regroup as asked"), and relevance retrieval.
Output: a change set. Compared with `extract-v24` it gains `move` / `update` / `archive` ops,
so "also X should be its own project with A and B in it" inside a dump just works instead of
becoming a question for chat (bridge 6). Dumps, breakdowns / roadmaps (bridge 8), multi-node
adds and restructures all go through it: one prompt family, one eval set.

A deterministic guard, not a regex on the user's words, keeps the split honest: `change`
rejects more than 3 ops or a create-with-children and tells the model to use `build_graph`.

**Fast lane.** For `surface: "dump"` the server skips the orchestrator call and writes the
`build_graph` call into the turn itself — same price and latency as a dump today. From step 2
on it is the same pipeline, and the thread records the change set, so the follow-up "no, put
the second one under Thesis" is an ordinary turn with full context.

**Change set.** The op list `propose_changes_batch` already uses (create / move / update /
create_edge / complete / archive with local refs), plus the priority and commitment changes.
Extraction output maps onto it 1:1: `proposed_nodes` → create, `depends_on_local_refs` /
`soft_links` → link, `complete_existing_node_ids` → complete. The parallel side reads
(`dump-priorities`) keep running in parallel and merge into the same set — one card, not three
messages. Stored in a `change_sets` table (ops + per-op status + undo snapshot): that row *is*
the proposal record, so "AI proposes, the user stays in control, every decision is traceable"
holds for chat as well as dumps.

**Policy.** One file decides pause-vs-undo for every op, replacing "dumps auto-apply, chat
asks". Starting point:
- apply now + Undo: priority and commitment changes (as today), a leaf under a known parent in
  a risk class this user accepts ≥90% of the time (as `auto-apply.ts` does today — now for
  chat-created nodes too)
- wait for Accept: move, merge, archive, retype, a new top-level branch, anything flagged a
  possible duplicate, any class below the calibration threshold

Accept / reject / undo on any op writes `feedback_events`, so calibration learns from chat.

**Apply.** `applyChangeSet` is the generalized `propose_changes_batch` handler plus what only
the review route does today (embedding, judgment, clustering trigger, feedback events). The
review route, the chat tools, `/api/graph-edit` and the auto-apply undo call it. A node is
the same object no matter how it was created.

**Card.** One component family in the thread, built from `pending-action-card` +
`applied-action-card`. Every item on it can be accepted, rejected or edited **on its own** —
"Accept all" is a shortcut, not the only way (today's chat card is all-or-nothing; the dump
modal already works per item). Rejecting a new parent re-homes the children that were going
under it rather than dropping them. Small sets are handled inline. A big dump's card has "Review all (14)"
that opens the existing nodes-review modal as an expanded view *of the same change set*.
Questions from the builder are `ask_choice`-style rows on the card; the answer is a normal
turn. Connection proposals arrive as a second card ("3 links I noticed") instead of a modal
that pops up later.

**Transport.** One event stream for every turn: text deltas plus typed events (`stage`,
`change_set`, `applied`, `question`). Replaces blocking JSON for dumps and the three marker
formats; a 35 s extraction shows "reading → matching → building" instead of a spinner.

### What it removes

| Goes away | Replaced by |
|---|---|
| chooser, `classify-dump`, `looksLikeBrainDump` fork | orchestrator decides; Brain Dump box = fast lane |
| Sonnet for a whole chat turn; `looksLikeStructuralEdit` / `inStructuralThread` routing | Sonnet only inside `build_graph` |
| `<nodes>`, `<graph_edit>`, `<recompute_scores/>` tags; `/api/graph-edit`; graph-edit modal | change set |
| client-built dump summary, fake question bubbles, synthetic "act on them now" turn | the thread's own record of the change set |
| restructure-as-clarifying-question (`extract-light-v4` rule 4) | builder emits move / update ops |
| browser-triggered connection analysis | server follow-up |
| 8 node/edge mutation tools, two apply stacks | `change` + `build_graph`, `applyChangeSet` |
| type / nesting rules in 4 prompts | builder prompt + validators in `node-types.ts` |
| 4,000 vs 10,000 char limits | one limit |

### What stays

Gemini Q&A pre-step and its regex gate (a miss there costs one tiny call, not a different
behaviour). `update_priorities` / `set_commitments` direct tools. Deterministic ranking.
`setNodeParent` as the only parent writer. The byte-stable cached snapshot. Relevance
retrieval, `resolution.ts`, `auto-apply.ts` calibration — reused, now on both doors. The
review modal for large sets. Planner models.

## 4 · Cost and speed (estimates from the measurements above — to be re-measured)

| Turn | Today | Target |
|---|---|---|
| Dump from the Brain Dump box | $0.013–0.062, 5–35 s | same (fast lane); minus the chooser call when typed in chat |
| Dump typed in the chat composer | chooser tap + same | + one Haiku round (≈$0.004–0.009, ~1–2 s), no tap |
| Structural edit in chat | ≈$0.052, ~12 s, 2 Sonnet calls | ≈$0.025–0.03: Haiku round + one builder call (≈ a light extraction); confirmation needs no model |
| Plain Haiku turn | $0.0089 | lower — the cached prefix loses ~8 tool schemas and the structure rules |

If structural chat turns cost what a light extraction costs, the two-day sample drops from
$0.437 to roughly $0.33 (≈$5 / 30 d). That is an estimate until a live run confirms it.

**Measured after phase 2** (live eval 2026-09-30, synthetic workspace, 17 model calls):

| Call | $ | Latency |
|---|---|---|
| Haiku chat turn that calls `build_graph` — warm cache | $0.0022–0.0026 | 0.9–2.5 s |
| …same, first turn after the prompt changed (writes the 1h cache, shared app-wide) | $0.0285 | 2.0 s |
| Builder, light prompt (`extract-light-v5`, ≤700 chars) | $0.0088–0.0112 | 3.0–6.0 s |
| Builder, full prompt (`extract-v25`, a 783-char dump, 10 nodes) | $0.041–0.064 | 12.6–31 s |
| Accept on the card | $0 (no model) | — |

A structural edit through chat is now **≈$0.013 and 5–8 s** (one warm Haiku round + one light
builder call) against ≈$0.052 and ~12 s before — better than the $0.025–0.03 estimated above.

Not chosen — **one Sonnet agent for every turn**: at the measured $0.038 per Sonnet chat turn,
20 turns a day is $0.76/day against a $0.16/day budget.

## 5 · Order of work

Each phase ships on its own and is testable from `testing-journal.md`.

1. **One apply engine** — ✅ built 2026-09-30 (server only, no migration, no prompt change).
   - `lib/graph/change-set.ts` `applyChangeSet`: the one writer of AI graph changes. The
     chat tools in `tools/mutations.ts` are wrappers over it (1462 → 758 lines); node creation
     existed three times there and once in the review route, now once.
   - `lib/graph/node-intake.ts`: the row, the embedding and the judgment → rescore every
     AI-created node gets. The dump review route uses the same three functions.
   - A chat-created node now gets: an embedding before Accept returns; an `accept_node`
     event (ranking's user-confirmation signal, worth +12 in `scoring.ts`, which only dump
     nodes had); the significance judgment and a rescore, run after the reply is out
     (`after()`), so Accept does not wait on a model call; a grouping pass when it landed at
     the top level; a healed workspace root instead of floating; the app's importance labels
     (chat wrote its own "critical").
   - Fixed on the way: a deadline or body on a batch `update` op was dropped while the op
     reported success.
   - Checked: 17 unit tests on an in-memory DB (`change-set.test.ts`; the 7 tool-behaviour
     ones passed against the old code first), and one pass against the real DB on a throwaway
     user — 15/15 checks, $0.0014 (2 Haiku judgments + 4 embeddings).
   - Not done here: `/api/graph-edit` still has its own writer — nothing calls it any more
     (the `<graph_edit>` tag left the prompt long ago), so it is deleted in phase 3 rather
     than rewired. A rejected chat card still writes no event; phase 2's `change_sets` row
     records that per op. Per-item accept on the chat card is phase 3.
2. **Builder as a tool** — ✅ built 2026-09-30 (no migration; `extract-v25`,
   `extract-light-v5`, `assistant-v24`).
   - `lib/ai/extraction.ts` is split: **`runBuilder`** (retrieval → model → dedup → a checked
     result; writes nothing but its `ai_run`) and `runExtraction` (a dump: `runBuilder` + the
     `proposed_nodes` bookkeeping). The builder prompts gained `changes` — move / update /
     link on EXISTING nodes — replacing "extraction only adds, ask a question" (bridge 6).
     `lib/ai/builder-ops.ts` turns the output into change-set ops.
   - **`build_graph`** (`tools/build.ts`): the chat model passes the turn to the builder; the
     builder reads the user's message word for word (the model's `note` is only let in for a
     bare "yes" or to resolve "it" on a short message — see the eval), the card shows the
     builder's change set, Accept applies exactly that set through `applyChangeSet`.
   - **Chat runs on Haiku.** `looksLikeStructuralEdit` no longer picks the model; the one
     remaining Sonnet chat turn is a *generated* breakdown (`looksLikeBreakdownAsk`). The old
     regexes survive only as a hint line in the message block (`buildHint`).
   - **A dump can reorganize.** The builder's edits — plus the new nodes they depend on
     (`splitRestructureSet`) — come back from `/api/entries` as ONE card in the dump's thread;
     Accept goes through the ordinary resume endpoint, and no model continues that thread.
   - `runTurnTools` (`tools/index.ts`) is the one place that decides what a turn's tool calls
     come to — the chat and resume routes each carried a copy. Direct tools now run even when
     a card is pending: "took the exam, waiting on the result, and add these three" used to
     lose its first half to "only one action per turn".
   - A reorganization the model leaves half-planned is never applied in part: every edit to
     that node is dropped and the user is asked (`resolveBuilderChanges` → `broken`).
   - **Live eval** (synthetic workspace, throwaway user, $0.32 over 4 rounds):
     - Haiku picked the right tool 6/6: `build_graph` for a new parent over existing nodes, a
       move that keeps a link, and a multi-item update (twice); `propose_node` for one add;
       `complete_node` for one completion.
     - Light builder 8/8 plans correct: project + rename + move + new sibling (4 runs), move +
       `useful_for` link, completions + a dated task, a move next to a new task.
     - Applied through the tool: "Applied 5 changes ✓", tree as asked.
     - **Found and fixed:** Haiku's note paraphrased "finished the italian placement test" as
       "finished Italian Crash Course" and the builder completed the course → long messages
       now go to the builder without any note. A guessed parent could not hold the child (a
       new class under the big task "Italian Crash Course") → `anchor-attachment.ts` now
       respects `ALLOWED_CHILDREN`.
     - **Known limit, full prompt:** on a long dump (783 chars, 10 new nodes) simple edits
       landed 2/2 (move + link), but the new-parent restructure did not, 3 runs out of 3 —
       twice the model moved nodes under a parent (`n11`) it never proposed. That case is now
       dropped whole and asked about instead of half-applied; one line in chat then does it
       through the light prompt. Fixing the prompt itself (write `changes` first) needs one
       more ~$0.06 run and was not done.
   - **Moved to phase 3**, where their readers are: the `change_sets` table (the card lives in
     `pending_chat_runs` for now — nothing reads per-op status yet), folding the 8 node/edge
     tools into `change`, breakdowns as a builder mode (which removes the last Sonnet chat
     route), and deleting the chooser.
   - **Not covered:** the HTTP routes and the browser (the local allowlist blocks the test
     user) — the chat turns were assembled exactly as the route does and the tool calls run
     through `runTurnTools`; `/api/entries/[id]/retry` ignores a dump's restructure.
3. **One thread, one card** — ✅ built 2026-10-01 → 02 (no migration; `extract-v26`,
   `extract-light-v6`, `dump-priorities-v3`, `dump-reply-v2`). Live notes and the driver:
   `docs/unified-turn-handoff.md`.
   - **One change set per dump** (`lib/ai/dump-turn.ts`): the builder's new nodes, edits,
     links and completions become one op list. **One policy** (`lib/ai/turn-policy.ts`):
     completions, links and the new nodes this user reliably accepts (the same `auto-apply.ts`
     calibration) apply at once with Undo; every reorganization — with the new parent it
     needs — waits as one unit. This pulled the create-node half of phase 4 in.
   - **No `change_sets` table after all.** `proposed_nodes` stays the ledger of what the
     builder proposed (status + `accepted_node_id`): the calibration, Undo and the dump
     history keep reading it, and the waiting ops sit in a parked `build_graph` run.
   - **One card** (`turn-card.tsx`): Added (Undo) · Marked done · Linked · What matters · Your
     week · Needs your OK · questions. Every row of a change card — dump or chat — is
     accepted or skipped on its own (`change-checklist.tsx`, `selectOps`); a row that needs a
     skipped one is blocked, a node whose new parent was skipped is re-homed. The review
     modal, the toast and the separate cards are no longer shown for a user's dump
     (suggest-steps, the bootstrap wizard and the retry route keep the modal).
   - **The reply** (`dump-reply.ts`): a small Haiku read answers the venting / the question,
     in parallel with the builder, on every dump (`dump-reply-v2`, 2026-10-02: a verdict
     line NONE / ACK / ANSWER / BOTH first; a dump that is only items gets NONE).
   - **The thread remembers** (`lib/chat/turn-note.ts`): history tells the chat model what the
     dump added, finished, linked, what waits and what was asked.
   - **Connections** found after a turn arrive as a "Links I noticed" card in its thread.
   - **No chooser**: a dump typed in chat is the same turn, continuing that thread; the reply
     sees the conversation.
   - **Builder**: the long prompt quotes edit requests and the short prompt carries them out
     (the long prompt failed 4 of 5 reorganizations); deadlines come from the user's words
     through `lib/time/relative-day.ts`; one bad reference no longer discards the output.
   - Deleted: `/api/graph-edit`, the graph-edit modal, the `<nodes>` / `<graph_edit>` tag
     handling.
   - **Not done (moved to phase 4):** folding the node/edge tools into one `change` tool
     (done 2026-10-02, see 4), and breakdowns as a builder mode (the last Sonnet chat route).
4. **One policy — built 2026-10-02.** Chat changes go through the same policy as a dump:
   - **One tool, `change`** (`lib/ai/tools/change.ts`), replaces the eight node/edge tools. Its
     ops add `remove_edge`, `delete_node` (permanent, the subtree, never the root, no Undo —
     the card says so) and `merge` to the change set (`change-set.ts`). Every call carries
     `source`: `"user"` → the dump policy (`applyTurnChanges` in `dump-turn.ts`, calibration
     from the same ledger: chat creates write a `raw_entries` row with source `assistant_save`
     and `proposed_nodes` rows); `"suggestion"` → everything waits, marked "Suggested". A
     missing source counts as a suggestion. `build_graph` runs the same policy.
   - **Advice stays advice** (owner): `update_priorities` / `set_commitments` called with
     source `"suggestion"` wait on a card (`isSuggestedDirectCall`, `tools/index.ts`); OK'd,
     they apply with their own applied card and Undo (resume route).
   - **Undo for everything applied** (`lib/graph/change-undo.ts`, `POST /api/changes/undo`):
     `applyChangeSet` records one step per op — remove the new node (the ledger learns it was
     a no), reopen what was completed (and what it closed), remove the habit check-in, remove
     an added link, restore a removed one, move back, restore old fields. The turn card has an
     Undo per section (Added / Marked done / Linked); a card's accepted rows get one too (the
     resume route sends their steps in a `<<BRAINDUMP_UNDO>>` marker). Dumps get the same.
   - **The same card**: a chat change streams its applied part in a `<<BRAINDUMP_TURN>>`
     marker; the message renders `TurnCard`, with the waiting rows inside it — the card a
     dump gets.
   - Checked: unit tests (fake DB) for the policy, the ops and every undo step;
     `scripts/test-change-tool.ts` (gitignored) on the real DB, 22/22; 8-message prompt eval
     ($0.165); 3 chat turns in the browser.
   - **Still open:** the breakdown as a builder mode (the last Sonnet chat route); the
     composer's dump classifier (a dump typed in chat still takes the dump turn — same policy
     and card now, so the split no longer shows).
5. **Server follow-ups + staged streaming.** Connections as a follow-up card (done in
   phase 3, client-triggered). **Stages built 2026-10-02 for dumps:** with `stream: true`
   `/api/entries` answers in NDJSON — `reading` → `building` (retrieval done, the builder
   call starts) → `reorganizing` (the edit pass, long dumps that ask to regroup) →
   `applying` — then the usual JSON (`lib/chat/dump-stream.ts`). The Brain Dump box and the
   chat bubble show "Sorting it into your graph · 14s" instead of a bare spinner
   (`components/ui/dump-progress.tsx`). Chat turns keep their streamed text.

Phases 1–3 are the felt change; phase 4's policy and phase 5's stages are built.

## 6 · Decisions (owner, 2026-09-30)

1. **Trust — yes.** A chat-created node may apply at once with Undo when this user's history
   for that risk class is ≥90%, the rule dumps already follow (phase 4; changes UX decision 6
   in `AGENTS.md` when it lands). Separately, and in every phase: items on a card are
   accepted or rejected **one by one**, never only as a batch.
2. **Brain Dump box** keeps opening a fresh thread (journal #18).
3. **Review modal** only for large sets (more than ~6 items needing a look); smaller ones are
   handled on the card.
4. **Order:** 1 → 2 → 3.

## 7 · Risks

- **Haiku under-calls `build_graph`** (answers a dump in prose, or squeezes a restructure into
  `change`). Guard: the ≤3-op validator, a `[multi-item capture]` hint in the message block
  from the existing heuristic, and the phase-2 eval.
- **Builder prompt grows** with move / update ops. The light prompt is 4.5k input tokens today;
  restructures also need the children of retrieved nodes. Measure with `countTokens` first.
- **One more Haiku round** for dumps typed in chat. If the measured delay is over ~2 s, extend
  the fast lane to messages the heuristic is sure about.
- **Migration of in-flight rows**: `pending_chat_runs` and `proposed_nodes` pending at deploy
  time must still resolve; keep their routes alive for one release.
