# Node types v2 — proposal (2026-09-29, awaiting owner sign-off)

Status: **proposed, not built.** The live taxonomy is still
`project | task | class | concept | idea | goal | habit` (see AGENTS.md → Node types).

## Why

Round-1 testing and the live DB (non-eval workspaces, 682 active nodes) show the types
don't mean one thing each:

- **concept (65)** is four things: life areas ("Health & Habits", "University & Exams",
  "Life Admin"), groupings ("This Semester's Courses", "BrainDump Marketing"), knowledge
  ("Systems Thinking", "Essay Structure") and people ("Noah Kim", "Maya Chen").
- **goal (151)** mixes real outcomes ("Get 1450+ on the SAT", "Half-marathon under 1:50 by
  Nov") with areas/aspirations ("Personal success", "Money independence", "Stay
  consistent"), habits ("Resume Gym Routine (3x/week)") and every workspace root ("ezo").
  The extraction prompt itself makes clusters `goal` in one example and `concept` in the next.
- **The same thing gets different types.** "Pass Calculus 1 & 2" is a task in one workspace
  and a goal in another; "Pass ML Exam", "Write Thesis", "Crash-Course Italian Fast" are
  tasks (10 tasks have children). There is no type for "one thing, one finish line, several
  sittings" — the owner's "big task" (journal #3, #16).
- Two palettes: the canvas uses `node-colors.ts`, the create sheet has its own accents.

## The system: 9 types in 4 families

Each type answers one question. The family says how the node **ends**.

| Family | Type | The question | Examples | How it ends |
|---|---|---|---|---|
| **Direction** — why | `goal` | Is it an outcome you'll *know* you reached (a number, an event, a yes/no), ideally by a date? | Internship in Milan by November · 1450+ on the SAT · Half-marathon under 1:50 | **Achieved** (you confirm) or dropped |
| **Work** — what you do | `project` | Is it a body of work with several *different* parts or deliverables? | Launch BrainDump beta · Internship search · Portfolio site | Done when its parts are done (you confirm) |
| | `big_task` **new** | Is it *one* thing with one finish line that takes several sittings? | Pass the ML exam · Write the thesis · Test BrainDump · Prep the Q3 deck | Checked off (prompted when its last step is done) |
| | `task` | Can you finish it in one sitting (~2h or less)? | Email the professor · Solve 5 practice problems · Book the flight | Checked off |
| | `habit` | Does it repeat on a stated cadence? | Gym 3×/week · Daily stretching · Italian media daily | Never — tracked per day/week |
| **Structure** — where | `area` **new** | Is it a part of life you keep maintaining, with no finish? | University · Health · Career · Money · Life admin | Never |
| | `class` | Is it a course you're taking this term? | Linear Algebra · Deep Learning | Archived at the end of the term |
| **Thinking** — what you know | `idea` | Is it something you *might* do, not committed yet? | Reselling clothes Milan→Astana · Lecture-summarizer extension | Promoted to task/big task/project, or archived |
| | `note` **new** (replaces `concept`) | Is it something to *remember* — a person, a fact, advice, a decision? | Noah Kim (TA) · Sarah's advice: stay through the refactor · Essay structure | Never (archived when stale) |

Tie-breakers the prompts and UI use:

- task vs big_task: **one sitting?** If you'd break it into steps before starting, it's a
  big task. A task that gets children is promoted to big_task automatically.
- big_task vs project: **one finish line?** "Pass the ML exam" has one (the exam); "Launch
  the beta" has several deliverables (landing page, onboarding, payments) → project.
- goal vs area: **could you say "done"?** "Money independence" can't be ticked → area
  (and the assistant may ask what a measurable version would be). "Earn €1,000/month from
  side projects by March" → goal.
- note vs idea: **could you act on it?** Knowledge → note; a possible thing to do → idea.
- The workspace root becomes an `area` (it stays identified by
  `workspaces.bootstrap_root_node_id`), so it stops counting as a goal in scoring.

## Nesting rules

| Parent | Allowed children |
|---|---|
| root, area | goal, project, class, big_task, task, habit, idea, note (areas don't nest) |
| goal | project, big_task, task, habit, note |
| class | big_task (exams, assignments), task, habit, note |
| project | big_task, task, habit, idea, note |
| big_task | task (its steps), note |
| task, habit, idea, note | none (a note can hang under anything as a leaf) |

The rules are enforced softly: prompts follow them, and one deterministic fix runs on
save (task gets a child → big_task). Nothing blocks the user from breaking them manually.

## Where each type shows up

| Type | Todos | Focus / What now | Planner | Roadmap | Graph |
|---|---|---|---|---|---|
| task | ✓ | can be the pick | one block | if dated | red pill |
| big_task | ✓ with step progress (2/5), expandable | picks its **next step**; no steps → offers "break it down" | schedules the next step, or a "work session: X" block | ✓ if dated | red pill + gradient-red outline + step ticks |
| project | its tasks only | via its tasks | via its tasks | ✓ | blue, larger, progress bar |
| goal | — | "why" context for the pick | — | ✓ anchor | amber, largest, target mark |
| habit | Habits view | today's check-in | fixed slots | — | green, cadence dots |
| area / class | filter / group header | — | — | lanes | hollow hub, fixed size |
| idea | — | — | — | — | yellow, dashed outline |
| note | shown in its parent's details | — | — | — | teal, small, no importance scaling |

## Visual design (existing tokens only)

- One palette: `src/lib/graph/node-colors.ts` (goal `#f0a755`, project `#6b8cef`, task
  `#ef6b7a`, class `#a07fd8`, habit `#7fc987`, idea `#eacf5a`); `note` takes concept's teal
  `#5cc7b8`; `area` uses the text-tertiary neutral (`#928b85` dark / `#76726d` light).
  The create sheet's separate accent map is removed.
- **The gradient-red outline moves to `big_task`** — what the owner originally asked for in
  journal #3 ("make the outline of the big task gradient red"). Goals and projects keep the
  Round-1 "size & weight" treatment (+0.2 size, weight 680) without the red outline, so the
  outline means one thing: *this needs breaking down*.
- Area: hollow hub, soft border, small uppercase Geist Mono label, constant size (areas
  aren't ranked).
- Detail panel labels: Goal · Project · Big task · Task · Habit · Area · Class · Idea · Note
  ("Objective" stays the group label for goal + project).
- Create sheet: types grouped by family, each with its one-line question.

## Build plan (after sign-off)

1. Migration: allow `big_task`, `area`, `note` in `nodes_node_type_check`; keep `concept`
   until the backfill ran, then drop it.
2. Backfill existing data (deterministic first, Haiku only for the ambiguous rest, output
   a review list before writing): tasks with children → big_task; roots → area; concepts
   with children → area, without → note; goals without a measurable end → area/habit
   (Haiku, ~150 nodes, a few cents).
3. Code: `types/graph.ts`, `node-colors.ts`, canvas visuals, create sheet, context rail,
   scoring/insights/next-action/retrieval/auto-apply/merge type tables, clustering + areas +
   bootstrap (`concept` → `area`), todos (big-task progress), Focus (next step of a big
   task), planner candidates, roadmap.
4. Prompts: extract-v22 + extract-light-v2 (type questions above; groupings → area, never
   goal), assistant-v18, clustering, suggest-steps (breaks down big tasks).
5. Eval: ~10 real Round-1 dumps before/after — "Pass X" must type as big_task every time,
   no goal-vs-area flips; report $/dump.

## Open decisions for the owner

1. Keep `class` (recommended — students are core users and courses behave differently), or
   fold it into `area`?
2. Move the gradient-red outline from goal/project to big_task (recommended)?
3. Backfill existing workspaces with a review list (recommended), or start Round 2 on a
   fresh workspace and only migrate the schema?
4. Name the knowledge type "Note" (recommended) or keep "Concept"?
