# One plan per day, and "I went off schedule" (#27, 2026-10-05)

Owner: *"if say i went off schedule and im telling that to ai … will ai rebuild the schedule
based off context?"* and *"a second plan absolutely has to replace the old plan with an undo"*.

## What "a day's plan" is

The tasks on that day in the Planner (`plan_tasks`). A task made from a plan names the node it
is about (`node_id`); a task typed by hand has none and is never part of "the plan".
`plan_sessions` / `plan_blocks` stay the draft the user reviews before Accept.

## One plan per day

Every way a plan reaches a day writes through `commitDayPlan`
(`lib/planner/plan-replace.ts`): the Planner's Accept (its own plans and chat's `plan_day`
drafts, via `POST /api/assistant/plan/commit`), "Replan from now" and chat's `replan_today`.

- A new plan takes over the old plan's **unfinished** tasks that start before it ends — all of
  them for a day plan, only the overlapping part for a 1 h / 2 h session. Ticked tasks stay
  (they happened); hand-typed tasks stay.
- The old rows are **superseded, not lost**: one `feedback_events` row (`event_type`
  `edit_plan`, `entity_type` `plan_replace`) keeps them exactly, with the new task ids.
- **Undo** → "back to the earlier plan" (`POST /api/assistant/plan/undo`): the new tasks go,
  the old rows come back with their ids and ticks, the new plan's session is marked
  `rejected`. Undo stacks newest first (an older plan can't be restored over a newer one).
  Undo appends a row naming the one it cancels — the table is append-only.
- The "Replace or add?" modal is gone: Accept replaces, and the day shows
  "Replaced your earlier plan (N unfinished items) · Undo".
- Focus's "Add to planner" isn't a plan: it fits its three picks into today's free gaps, as
  before.

No migration.

## Replan the rest of today

`replanToday` — the Planner's **Replan from now** button (`POST /api/assistant/plan/replan`)
and chat's `replan_today` tool. Deterministic, no model call ($0): the plan the user accepted
is the plan.

- Today's unfinished plan tasks are kept and laid out again from the next quarter hour, in the
  order they were planned: each keeps its time if that is still ahead and free, else moves to
  the next free moment — never over a fixed commitment or a hand-typed timed task.
- What the user says they **missed** leaves today's plan. A missed habit is recorded as missed
  today — never done — and stays out of today's Focus and plans. A task they drop is a skip.
- Past blocks they didn't do are recorded as **skips** (the stale check counts them, as it
  counts an undone plan task on a past day).
- What can't fit before the day ends (23:00) drops — undated work first, last first — and is
  named on the card.
- Ticked tasks stay as they are.
- No plan today → chat plans with `plan_day` instead; the button only shows when today has an
  unfinished plan.

Chat (assistant-v30): "I went off schedule", "missed the gym", "running 2h late", "redo my
afternoon" → `replan_today` with `source: "user"`, applied at once; the card
("Rest of today replanned") lists each task's new time (was …) with Undo. The chat snapshot now
shows **today's plan from the Planner** (times, ticked or not) instead of the latest accepted
session's blocks, so the model knows what was planned and done.
