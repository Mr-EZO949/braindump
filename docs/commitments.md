# Fixed commitments — the week's busy time

Status: built 2026-09-29 (after ranking v2); migration
`20260930010000_commitments.sql` applied and live since 2026-09-30.
**Run end to end 2026-10-03** (throwaway user, chat → route → DB → card): add + Undo,
two weekly times from a dump typed in chat, "practice moved to 6pm" (only that one,
keeps its 2 h), "no more practice on fridays" (days → Tue), "the course ended" (removed)
+ Undo (back with its id and class link), and the AI planner around them (a 15-hour
Tuesday with a lecture 14–16 and practice 18–20: nothing inside either). Undo of a
changed time checked at the function level. Known: Undo of a removal re-inserts the
row with `source = 'chat'` even when a dump made it.
The four surfaces were looked at in a real browser in both themes with **mocked**
commitment rows (`.claude/skills/verifier-webapp/verify-commitments-ui.mjs`, $0) — that
checks how they look, not that the data path works.
Pure logic: `src/lib/planner/commitments.ts` (schedule math, words, loading) and
`src/lib/planner/commitment-changes.ts` (tool/dump validation, Undo), both unit-tested.

Time budgets and working hours the user wants ("4h a day coding", "no work
after 10pm") are not busy time — they're standing preferences,
`docs/preferences.md`.

"Stats every day at 2pm" used to live only as free text on a node, so Focus and the
planner didn't know when the user is busy. Now it's a weekly row, and every surface
that suggests *when* to work reads it as busy time.

## The row

`commitments`: `title`, `days` (ISO weekdays, 1 = Mon … 7 = Sun), `start_time`,
`end_time` (local wall-clock), `starts_on` / `ends_on` (null = open), optional `node_id`
(the class or job it belongs to), `source` (chat / dump / manual / import).

- Read **per user**, not per workspace — a class blocks the afternoon whichever
  workspace is open. `workspace_id` records where it was added.
- Only commitments that haven't ended are loaded (`loadActiveCommitments`), fail-soft
  (a missing table reads as none).
- One-off events ("dentist Thursday at 3") are not commitments — they stay timed
  planner tasks (`add_task_to_calendar`). Self-set routines ("gym every morning") are
  habits.

## Where they come from

- **Chat — `set_commitments`** (direct tool, like `update_priorities`): add / update /
  remove, applies at once, the chat shows a "Schedule saved" card with **Undo**
  (`POST /api/assistant/commitments/undo`). The snapshot carries a
  `[FIXED COMMITMENTS]` list with ids, so "practice moved to 6" updates the right one and
  "when's stats?" needs no tool. "Every day" for a class or job = Mon–Fri (the card shows
  it; the user corrects it). No end date said → saved without one ("no end date" on the
  card). A linked class node's `target_date` becomes the end date when none was said.
  Dates are the user's words (`until` / `from`), resolved in code.
- **Dumps — `dump-priorities-v2`**: the small Haiku read that already pulls priority
  facts out of a dump now also returns commitments. It runs when retrieval found existing
  nodes (as before) **or** the dump names a clock time next to a weekday / "every …"
  (`mentionsWeeklyTime`, a regex). The dump summary shows them as their own card with
  Undo.
- **Planner timeline**: a commitment's × removes it from every week (after a confirm).
  No editor form — changes go through chat.

Guard (deterministic, `parseCommitmentChanges`): an "update" that gives the commitment
new days/time *and* an unrelated title is saved as an **add** — Haiku repeatedly
"updated" the one listed commitment (volleyball practice) to save a new one (Stats
lecture) in the eval. Same-activity updates and bare renames pass through.

## Where they're read

| Surface | What changes |
|---|---|
| **Focus** (`daily-brief` → `buildPlannerCandidates({ fitToFreeTime: true })`) | A line above the hero, computed on the client's clock: "45 min free · Stats at 14:00", "In Stats until 15:00 · then 1h 30m free before Lab", "Stats at 14:00 — in 8 min". With **15–90 min** free, the items among the top 10 that fit (per-type estimate: task 30, habit 45, big task 60) move to the front, order kept (`fitHeadToFreeTime`); check-backs always fit. Under 15 min or 90+ min: order unchanged. Still no model call. |
| **Focus → "Plan my day"** | `planSchedule` treats today's commitments as busy, like timed planner tasks. |
| **AI planner** (`/api/assistant/plan`, `plan-v7`) | The client sends where the plan will land (`session_date`, `session_start`). Commitments inside that window become Session-block lines (busy time + free stretches); the model plans only the free minutes (and the Haiku/Sonnet split uses free minutes). A block that only restates a commitment (unlinked, same title) is dropped before the free minutes are packed. On **Accept**, blocks are laid back to back from the start and any block that would run into a commitment starts after it (`layoutAroundBusy`). Chat's `plan_day` does the same for every window. A day runs from its start (the time given, else now; 08:00 on another day) to 23:00, up to 18 h (`lib/planner/plan-window.ts`). |
| **Planner timeline** | Commitments draw as softly hatched bands behind the day's tasks (title + time; × on hover removes it from every week). |
| **Details** | A node with linked commitments shows one quiet line under its tags: "◷ Mon–Fri 14:00–15:00 · until Dec 20". |
| **Chat snapshot** | `[FIXED COMMITMENTS]` block (priority 92, byte-stable order). |

## Cost

- Chat: the static prompt grew by 1,010 tokens (tool + rules), cached 1h → ~$0.0001
  per turn. A commitment change is one Haiku call whose card is the reply.
- Dumps: the read is ~850 input + 100–200 output tokens, **$0.0013–0.0019** per dump
  it runs on (v1 was $0.0007–0.0012); it now also runs on dumps with a weekly time.
- Planner: +~80 tokens when a commitment falls inside the session.
- Focus, timeline, Details: SQL only.

Prompt-only checks (2026-09-29: direct model calls with a hand-written snapshot, no
router, no DB; 3 rounds, 13 calls, $0.099 — more rounds than the one-round rule allows).
Each case was right in its last run — 4 of 6 chat cases passed in round 1 and weren't
re-run after the prompt edits; the other 2 were fixed and re-run:
- chat: café shift Tue/Thu 9–17 linked to its area · practice moved to 18:00 (keeps its
  length) · dentist → calendar task · practice days → Tue only · "stats every day at 2pm
  until dec 20" → add Mon–Fri linked to the Stats class · lecture with no end → saved
  without asking.
- dumps: "practice is 6pm now" + "waiting for results" → update + wait · "call mom at
  2pm" → gate off, no call · two classes with "classes end dec 20" → in the last run
  Haiku sent the lecture as an update of practice; the code guard turns that into an
  add (unit-tested on that exact output, not re-run live).
- planner: 4h from 13:00 with class 14–15 → 180 min planned, on Haiku.
Fixed along the way: chat and dump both overwrote the existing commitment to save a new
one (prompt + the code guard above), a lecture with no end date was asked about instead
of saved, the dump filed a commitment update under `changes` (the parser now accepts it)
and invented a "focus" from "need to finish problem set 4" (prompt; gone in the re-run).

## Not built

- Timetable / PDF import (fills this table; `source = 'import'`).
- One-off busy events as commitments, rotating schedules (every other week), per-date
  exceptions ("no class on Nov 1") — say it in chat as an update/remove for now.
- Commitment awareness in the nudge ribbon / daily brief text.
