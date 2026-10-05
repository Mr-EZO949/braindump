# Standing preferences — how the user wants to spend their time

Status: built 2026-10-05 (#28, branch `fix/preferences`). No migration.

"If I say I wanna spend 4h a day coding, will it remember?" — now it does. A
standing preference is said once and kept: a time budget ("4h a day coding",
"2h of Italian on weekdays", "10h a week"), working hours ("no work after
10pm", "not before 9"), best focus hours ("I'm sharpest 9–12"), or another
rule about time ("gym in the mornings"). Not busy time (that's
`docs/commitments.md`) and not nodes.

## Storage

Supabase auth `user_metadata.standing_preferences` (like the auto-add switch):
per user, at most 12 rows, written by the service-role admin API
(`lib/planner/preference-store.ts`). Row shape and every rule:
`lib/planner/preferences.ts` (pure, unit-tested). Kinds: `budget` (title,
minutes, per day|week, days, node_id, part_of_day) · `hours` (start/end, one
per user) · `peak` (start–end, one per user) · `rule` (title).

## Where they come from

- **Chat — `set_preferences`** (direct tool, like `set_commitments`): source
  "user" applies at once, card "Saved for your plans" with **Undo**
  (`POST /api/preferences`); "suggestion" waits on a card. The snapshot carries
  `[STANDING PREFERENCES]` with ids. Guard (code): an add for something already
  saved — the same budget (same node, or the same activity by name), the hours,
  the best hours, the same rule — becomes an update of only the fields said
  ("make it 3h" keeps the name, link and days). Messages with remember / forget /
  from now on never go to the no-tool Gemini route.
- **Dumps — `dump-priorities-v5`**: the priority read also returns preferences,
  each quoting the user's words; saved by the same engine, shown in the dump's
  "Your week" card with the weekly times under one Undo
  (`/api/assistant/commitments/undo` takes `undo.preferences`).
- **Settings — "Your time"** in the account panel: the list, each with ×
  (`GET` / `DELETE /api/preferences`). Changes go through chat.

## Where they're read

| Surface | What changes |
|---|---|
| Day plan (Planner screen `/api/assistant/plan`, chat `plan_day`) | "no work after 22:00" ends a day plan there instead of 23:00 (`planWindowMinutes(…, dayEndMinute)`). On a plan of 4h+, each budget for that weekday becomes a request ("Coding — your 3h a day" → container blocks on the linked node), after what the user typed (a budget for something they named is skipped); all budgets ≤ 60% of the session, scaled in 15-min steps. Best hours, working hours, rules and a budget's part of day go to the plan model as context lines. Chat's `plan_day` now also passes the "About you" working hours. No plan prompt change. |
| Focus (`daily-brief`, `top-now`) | A budget for today on something nothing inside was finished on today: its work gets +150 (under carried-over) and the line "Your 3h a day on Coding — not started today". |
| Chat snapshot | `[STANDING PREFERENCES]` block (priority 91, ordered by kind then id). |

## Not built

- Minutes actually spent today (Focus's "behind" = nothing finished under it
  today; a replan doesn't subtract what was done).
- "Not before 9" doesn't move a plan's start (the Planner sends the start); it
  rides along as context.
- The graph builder may still make a node from a dump's wish ("Code 4h daily");
  the read saves the preference either way.
