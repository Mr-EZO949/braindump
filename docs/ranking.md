# Ranking v2 — what matters and what to do next

Status: built 2026-09-30 (importance `v9`, Focus v2, chat `update_priorities`,
`assistant-v20`, `judgment_v3`).
Tunables: `RANKING` in `src/lib/ai/config.ts`. Pure signal math:
`src/lib/graph/priority-signals.ts` (unit-tested). Migration:
`20260930000000_ranking_v2.sql`.

## Two questions, one set of signals

| Output | Question it answers | Drives | Code |
|---|---|---|---|
| **Importance** (0–100, stored) | How much does this deserve attention right now? | node size + dimming on the graph, Todos order, chat snapshot order | `scoring.ts` `computeWorkspaceScores` |
| **Start priority** (unbounded, computed live) | What should I start next? | Focus / What Now, planner candidates, top-priority nudge | `planner.ts` `buildPlannerCandidates` |

Both read the same signals, so a deadline, a "focus on X" or "waiting for the
result" moves the node's size and its Focus rank together.

## Signals

Every signal is deterministic — no model call when Focus opens or scores recompute.

1. **Semantic weight** — how much the thing matters in the user's life, independent
   of timing. `0.7 × AI judgment + 0.3 × type prior` (type prior alone when there is
   no judgment). The AI judgment (Haiku, `judgment.ts`) is told to ignore deadlines:
   timing is signal 2, so it is never counted twice.
2. **Deadline pressure** (0–100) — lead-time aware, not a 7-day cliff.
   - Effective deadline: the node's own `target_date`, else the nearest dated
     ancestor (belongs_to chain), else a dated node it is `required_for` ("needed
     for"; old `prerequisite_for` / `blocks` / `depends_on` rows read the same —
     `lib/graph/edge-types.ts`). Habits, notes, ideas and areas never carry one.
   - Work left: open actionable nodes under the deadline's owner (task 1 session,
     big task without steps 3); an owner with nothing under it counts 3.
   - `slack = days_left − work_left / SESSIONS_PER_DAY`;
     `pressure = 100 × clamp((horizon − slack) / horizon, 0, 1)`, horizon 10 days.
   - Stakes stretch the horizon (high 14 days, low 6) and scale the result.
   - Overdue: full pressure for 2 days, then fades to 40 — and Focus asks
     "overdue — done, moved or dropped?" instead of shouting forever.
3. **Stakes** — `nodes.stakes` (−1 low · null normal · 1 high), inherited from the
   nearest ancestor that has one. Shifts semantic weight ±10 and shapes pressure.
4. **Steering** — the user's "focus on X" / "X can wait": `boost_node` /
   `demote_node` feedback events that **decay** (half-life 7 days), inherited by
   descendants at 0.8×. `manual_weight` stays the permanent hard override.
5. **Hold** — `paused` status, optionally with `waiting_for` + `resume_on`
   ("waiting for the exam result, check back Oct 20"). The node shrinks (×0.32),
   its open descendants shrink (×0.5) and all of them leave Focus. On `resume_on`
   the node comes back into Focus as "Check back: …".
6. **Structure** — goal alignment, centrality, unmet prerequisites, blockers,
   just-unblocked (unchanged from v8).
7. **History** (Focus only) — recently unblocked (24h), carried over from a plan
   (dated work only; 3+ times → "break it down?"), done today (hidden), yesterday's cluster:
   momentum (+) if it has deadline pressure, rotation (−) if not; a dated cluster
   untouched for 3+ days gets a neglect bonus.

## Importance v9

```
raw = 0.30·semantic + 0.28·pressure + 0.16·goal_alignment + 0.12·centrality
    + 0.06·freshness + 0.08·user_confirmation
raw = raw × dependency_pressure + blocks_penalty + blocker_bonus + 14·steering
score = calibrate(raw)                        # 32% blend toward the workspace spread
      × hold_factor                           # 0.32 self paused · 0.6 check-back due · 0.5 under a held parent
manual_weight → overrides everything; completed → 0
```

`importance_reason` is written deterministically when a clear reason exists
("Due in 4 days — about 5 sessions left", "Waiting for exam result — check back
Oct 20", "You asked to focus on this"), otherwise the AI judgment's reason.
Invariant kept from v7: at equal signals a goal outranks a task. Deliberate change
from v8: a task due tomorrow can now outrank an undated goal.

## Start priority (Focus v2)

```
type base (task 120 · big task 112 · goal 104 · habit 98 · project 70 · class 62)
+ 300 just unblocked            + 240 on the calendar within 7 days
+ 2.6 × deadline pressure       (next open step per deadline; later siblings × 0.55)
+ 220 habit due                 + 170 carried over (dated work only)
+ unlocks bonus                 − prerequisite / blocker penalties
+ 60 momentum | − 130 rotation  (yesterday's cluster, with / without deadline pressure ≥ 40)
+ up to 80 neglect              (dated cluster untouched 3+ days; next step only)
+ 220 × steering                + 1.8 × importance
```

A fresh "focus on X" (+220) beats a leftover (+170), ties a due habit, and loses
to a deadline at pressure ≳ 85. Excluded: structure/knowledge types, cluster
anchors, done today, paused nodes and everything under a paused node. Added:
paused nodes whose `resume_on` has arrived, as "Check back: …" (priority 330,
`check_back: true` so What Now doesn't schedule them as work).

**Head rule:** the top 3 (the Focus hero + alternatives) take at most one step per
deadline — three steps of the same exam aren't three choices. The rest keep their
order after (`diversifyHead`).

The hero line is the first planning signal, e.g. `"Pass the Stats final" due in 5
days · ~4 sessions left`, `Check back: waiting for exam result`, `Overdue by 15
days — done, moved or dropped?`.

**Skipped plans (2026-10-04, `lib/planner/skips.ts`).** A skip is a past day a
node sat in the user's plan (a `plan_tasks` row) and was left undone; a day the node
or a step inside it got done doesn't count. A skip pushes only work with a deadline
(own or inherited): the +170 carry-over and the +240 "on your calendar" for a past
date need one. Undated work skipped on 2+ days in 14 is **stale**: out of Focus and
new plans, asked about in a "Does this still matter?" card (Focus, Planner) —
still matters (count restarts, no push) · not now (`deprioritize`, Undo) · drop it
(archive, Undo). Answers are `feedback_events` rows (`entity_type` `stale_check`).
Habits are never asked about. No model call.

**Time blocks (plans only).** A class, or a goal / project / big task with open
steps, can get a block of time on itself in a plan, starting with its next 1–2
open steps (`time_blocks` in `buildPlannerCandidates`, `plan-v8`). A step inside
a planned time block is dropped from the same plan; a ticked time block marks the
session done and never completes the node (`lib/planner/sessions.ts`). Focus stays
one leaf step.

The score refreshes on every graph event and nightly (the `node-cleanup` cron),
because pressure moves with the calendar even when nothing is touched.

## Chat → priorities (`update_priorities`)

What the user says in chat that changes *what matters*, not *what exists*:

1. **Spot the fact.** Outcome (done · waiting on a result/reply · didn't happen ·
   dropped), time (deadline set/moved/cleared), weight (matters more/less, what's
   riding on it), window ("this week, X first").
2. **Resolve the node** from the snapshot (search if not listed). Never invent one.
3. **Map to one action per node:** `complete` · `wait` (+ `waiting_for`,
   `check_back_on`) · `resume` · `deadline` · `stakes` high/normal/low · `focus` ·
   `deprioritize` · `drop`.
4. **Ambiguous outcome → ask first** (`ask_choice`). "I didn't take psychology":
   not yet (keep it), missed it (retake date or drop?), never enrolled (drop).
5. **Applies at once, with Undo** (since 2026-09-30, assistant-v21). One call
   for all changes; they apply in order, scores recompute once, the graph
   reloads (node sizes follow) and the changed nodes pulse once. The chat shows
   an applied card — each node, its new state ("Waiting for exam result · check
   back Oct 15", "Due Oct 9") and its importance move (↑ 26 / ↓ 47) — and an
   **Undo**. No Accept gate: every priority change is reversible, so the safety
   net moved from before to after (like calibrated auto-apply). The card is the
   whole reply — no follow-up model call.
   - Undo restores exactly the fields a change touched (status through the
     status engine, then waiting_for / resume_on / stakes / target_date);
     focus / can-wait are cancelled with an opposite steering event
     (`feedback_events` is append-only; both decay alike, so they net to zero).
     `POST /api/assistant/priorities/undo`.
   - The thread history carries a note of what was applied (or undone), so the
     next turn knows.
   - Dates: the model copies the user's words into `date_words` ("this friday",
     "next tuesday", "in 2 weeks", "oct 20") and the server resolves them
     (`lib/time/relative-day.ts`). Haiku's own date for "this Friday" (said on a
     Wednesday) was wrong in 7 of 9 runs even with the next 7 dates listed.
6. **Venting with no new fact → no tool.** One or two sentences: acknowledge, then
   the assistant *names* the smallest next step (doesn't ask the user to pick).
   Venting that reveals stakes ("I need it for my masters") → propose
   `stakes: high` once.

Surfaces:

- **Focus check-back card.** A waiting item whose check-back day came leads Focus
  as a calm amber card — "Check back · Stats final exam · Waiting for exam
  result" — with **It's done ✓** and **Still waiting** (asks again in 7 days).
  Both go through `POST /api/assistant/priorities` (same engine, no model, $0).
- **Details.** A paused node shows what it's waiting on and when to check back
  (red once the day has come); its primary action is **Resume** instead of
  Start working. Chips/reason don't repeat what the tags and callout say.
- **Graph.** Paused nodes and everything under them draw stepped back (muted,
  smaller score); nodes whose priority just changed pulse once in brand red.

A waiting (paused) node can be completed directly ("got my result, I passed") —
`paused → completed` is a valid transition and logs `complete_node`. Leaving
`paused` clears `waiting_for` / `resume_on`. `update_node`'s `importance_index`
now pins `manual_weight` (it used to be overwritten by the next recompute).

Live check (2026-09-30, Haiku, assistant-v20, synthetic workspace, 18 calls,
$0.10): wait + moved deadline, stakes low/high, focus, can-wait and "I passed" all
produce the right tool call; "I didn't take psychology" asks with all three
options; venting gets no tool and a named next step. Two fixes came out of it:
the prompt now lists the next 7 dates (Haiku resolved "this Friday" on a
Wednesday to the Sunday), and paused → completed.

Second check (2026-09-30, assistant-v21, same workspace, 32 calls, $0.19 over
six rounds): tool routing right in every run. Fixes: dates via `date_words`
(3/3 right after; Haiku's own date was right in 2 of 9); the snapshot says "importance 78/100" instead of
"score: 78" (Haiku read a stats node's score as the user's exam grade); venting
replies must state a step, not ask. Still variable: "I didn't take psychology"
sometimes offers only two of the three options (1 of 2 in the last round), and
venting about a node with no step under it sometimes asks back (1 of 2).

Example: "did the stats exam, waiting for results, psych got moved to Friday" →
`wait` on *Pass the Stats final* (waiting_for "exam result") + `deadline` on
*Pass Psychology* → Stats and its prep tasks shrink, dim and leave Focus;
Psychology's pressure rises; its next step leads Focus. On the check-back day
Stats returns to Focus as one decision. (`ranking-scenario.test.ts` runs this
story through the real scorer and Focus builder.)

## Dumps → priorities (`dump-priorities.ts`, `dump-priorities-v1`)

The same facts arrive in the dump box too ("did the stats exam, waiting for
results, psych moved to friday"), and extraction only creates nodes and
completes them. So every user dump that touches existing nodes gets one small
Haiku read, in parallel with extraction (no added wait):

- Input: the dump + the existing nodes retrieval already picked for it (short
  refs, with status / due / stakes). No relevant existing node → no call.
- Output: the facts only — `wait`, `resume`, `deadline` (the user's date words,
  resolved in code), `stakes`, `focus`, `deprioritize`, `drop`. Completions stay
  with extraction; when both touch a node, the read's `wait` wins over
  extraction's "did". Ambiguous outcomes aren't acted on — the dump summary asks
  about them in chat instead.
- The facts go through `applyPriorityChanges` (same as chat) and the
  deterministic ranking reranks. The dump's summary in chat carries the same
  applied card with Undo, and the changed nodes pulse.
- Haiku never scores nodes here: scoring stays deterministic (free, stable,
  explainable).

Cost: ~570 input + 20–120 output tokens, **$0.0007–0.0012 per dump**
(measured, 3 synthetic dumps: wait + moved date, "didn't take psychology" → asked,
venting → nothing; all right).

## End-to-end check (2026-09-29, real app, throwaway user, $0.038)

One pass through the real flow (login → seeded exam story → Focus → chat →
Undo → Brain Dump box), with DB checks after each step:

- Chat "did the stats exam today, now waiting… psych moved to this friday" →
  Haiku, one call, applied card, no Accept; Friday resolved right; **Undo**
  restored status and date exactly.
- "i didn't take psychology" → ask with all three options; "Not yet" changed
  nothing.
- Dump "sent my masters draft to my prof, waiting to hear back. psych is
  pass/fail… buy printer ink" → Sonnet extract-light made the new node; the
  Haiku priority read set the draft waiting and psych low stakes; summary card
  with Undo. Dump cost: Sonnet $0.0065 + priority read $0.0010 + areas $0.0009.
- Focus: a goal due today led; the check-back item sat at #2 tagged "check back".

Fixed from it: a wait "today" set the check-back to today (now dropped when not
in the future); Gemini answered "…now that the exam is over?" instead of handing
off (outcome words now route to Haiku — Flash-Lite ignored the prompt rule even
after it was sharpened); after Undo the model still stated the undone date (the
history note now says the changes no longer apply); the anti-freeze nudge sat
on top of the Focus dialog. Still variable: ask_choice lead-in sometimes
repeats the options in text.

## Chat routing: does an update ever get lost? (2026-09-29)

Plain questions go to Gemini Flash-Lite with **no tools** (cheap); anything
that changes the graph must reach Claude. A miss is silent — a friendly answer
and no update — so it was measured on a labeled set: 26 messages that should
update something (most phrased as questions: "is it ok if I skip italian for a
while?", "I bombed the midterm, is the final worth it?") and 16 plain questions,
10 of them held out from tuning.

| | updates reaching Claude | plain Qs wrongly sent to Claude |
|---|---|---|
| router rules alone | 14/26 | 0/16 |
| Gemini, old "reply with the word HANDOFF" | 16/20 | 0/12 |
| Gemini, `needs_action` decided first (JSON schema) | 25/26 | 0/16 |
| **router + Gemini (shipped, assistant-qa-v3)** | **26/26** | **0/16** |

Before: 2 in 20 updates were silently answered instead of applied. Two layers
now: the router sends outcome words (over, took, passed, missed, pushed, moved,
waiting, pass/fail, got into, results…) straight to Claude; Gemini decides
`needs_action` as its first JSON field before writing any reply, and anything
unreadable hands off. Cost of the study: $0.028.

## AI importance rerank (`judgment.ts`, `judgment_v3`)

Judges *significance only* (timing is the pressure signal). Nodes go in as short
refs (`n1`…), output is compact JSON at 80 tokens/node, 40 nodes per call; a
response cut off at `max_tokens` or with no usable scores is logged as failed and
the chat tool says so (v2's 50 tokens/node with full UUIDs could silently score
nothing on a 40-node workspace). ~$0.01 per 40 nodes.

## Not in v2 (next)

- ~~Fixed commitments as rows → free-time-aware Focus~~ — built, `docs/commitments.md`.
  Focus fits its head to a short free window before the next commitment
  (`fitHeadToFreeTime`, applied before `diversifyHead`).
- Timetable/PDF import into deadlines + commitments.
- Stakes / hold controls in the edit sheet (chat and the Details rail cover it now).
