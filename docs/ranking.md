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
     ancestor (belongs_to chain), else a dated node it is `required_for` /
     `prerequisite_for`. Habits, notes, ideas and areas never carry one.
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
   (3+ times → "break it down?"), done today (hidden), yesterday's cluster:
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
+ 220 habit due                 + 170 carried over
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

## AI importance rerank (`judgment.ts`, `judgment_v3`)

Judges *significance only* (timing is the pressure signal). Nodes go in as short
refs (`n1`…), output is compact JSON at 80 tokens/node, 40 nodes per call; a
response cut off at `max_tokens` or with no usable scores is logged as failed and
the chat tool says so (v2's 50 tokens/node with full UUIDs could silently score
nothing on a 40-node workspace). ~$0.01 per 40 nodes.

## Not in v2 (next)

- Fixed commitments (class every day at 2pm) as rows → free-time-aware Focus.
- Timetable/PDF import into deadlines + commitments.
- Stakes / hold controls in the edit sheet (chat and the Details rail cover it now).
