# Node types v2 (approved and built 2026-09-29)

Status: **built** — code in `src/lib/graph/node-types.ts` (the one place type rules
live), migration `supabase/migrations/20260929000000_node_types_v2.sql`, prompts
extract-v22 / extract-light-v2 / assistant-v18. All four were approved
recommendations below (keep class, outline → big task, backfill structure only,
"Note"). Old graphs don't convert one-to-one, so Round 2 tests the types with new
dumps; the migration only backfills what the structure proves.

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
  sittings" — a "big task".
- Two palettes: the canvas uses `node-colors.ts`, the create sheet has its own accents.

## The system: 9 types in 4 families

Each type answers one question. The family says how the node **ends**.

| Family | Type | The question | Examples | How it ends |
|---|---|---|---|---|
| **Direction** — why | `goal` | Is it a *result* you'll know you reached — pass it, land it, hit the number — ideally by a date? | Pass Machine Learning · Internship in Milan by November · 1450+ on the SAT | **Achieved** (you confirm) or dropped |
| **Work** — what you do | `project` | Is it a body of work with several *different* parts or deliverables? | Launch BrainDump beta · Internship search · Portfolio site | Done when its parts are done (you confirm) |
| | `big_task` **new** | Is it *one piece of work* you do or produce, over several sittings? | Write the thesis · Test BrainDump · Crash-course Italian · Prep the Q3 deck | Checked off |
| | `task` | Can you finish it in one sitting (~2h or less)? | Email the professor · Solve 5 practice problems · Book the flight | Checked off |
| | `habit` | Does it repeat on a stated cadence? | Gym 3×/week · Daily stretching · Italian media daily | Never — tracked per day/week |
| **Structure** — where | `area` **new** | Is it a part of life you keep maintaining, with no finish? | University · Health · Career · Money · Life admin | Never |
| | `class` | Is it a course you're taking this term? | Linear Algebra · Deep Learning | Archived at the end of the term |
| **Thinking** — what you know | `idea` | Is it something you *might* do, not committed yet? | Reselling clothes Milan→Astana · Lecture-summarizer extension | Promoted to task/big task/project, or archived |
| | `note` **new** (replaces `concept`) | Is it something to *remember* — a person, a fact, advice, a decision? | Noah Kim (TA) · Sarah's advice: stay through the refactor · Essay structure | Never (archived when stale) |

Tie-breakers the prompts and UI use:

- task vs big_task: **one sitting?** If you'd break it into steps before starting, it's a
  big task. A task that gets children is promoted to big_task automatically.
- goal vs big_task (decided 2026-09-29): **a result or a piece of work?** "Pass the ML
  exam" / "Pass Machine Learning" is a result → goal; "Write the ML project report" is work
  → big task.
- big_task vs project: **one piece of work?** "Write my thesis" → big task; "Launch the
  beta" has several different deliverables (landing page, onboarding, payments) → project.
- goal vs area: **could you say "done"?** "Money independence" can't be ticked → area
  (and the assistant may ask what a measurable version would be). "Earn €1,000/month from
  side projects by March" → goal.
- note vs idea: **could you act on it?** Knowledge → note; a possible thing to do → idea.
- The workspace root becomes an `area` (it stays identified by
  `workspaces.bootstrap_root_node_id`), so it stops counting as a goal in scoring.

## Nesting rules

| Parent | Allowed children |
|---|---|
| root, area | anything, including sub-areas (the root is an area) |
| goal | goal (milestone), project, big_task, task, habit, note |
| class | goal (pass it), big_task (assignments), task, habit, note |
| project | big_task, task, habit, idea, note |
| big_task | big_task (a phase), task (a step), note — so it can carry a deep roadmap |
| task, habit, idea, note | none (a note can hang under anything as a leaf) |

The rules are enforced softly: prompts follow them, and one deterministic fix runs on
save (task gets a child step or phase → big_task). Nothing blocks the user from breaking them manually.


## Link kinds (2026-10-05)

Four, each clearly different (the old nine overlapped in meaning). Every
writer emits only these; `lib/graph/edge-types.ts` `normalizeEdge` reads older
rows as their kind everywhere (layout, delete subtree, ranking, Focus, planner,
chat snapshot, edit sheet). No migration — old rows keep their stored type.

| Kind | Stored as | Absorbs (read-only) | Edit sheet |
|---|---|---|---|
| part of | `belongs_to` (child → parent) | `contains` (flipped) | Contains / Belongs to |
| needed for | `required_for` — blocks its target in Focus / planner | `prerequisite_for`, `blocks`, `depends_on` (flipped) | Needs / Needed for |
| helps | `supports` | `useful_for` | Helps / Helped by |
| related | `related_to` | `inspired_by` | Related |

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
- **The gradient-red outline moves to `big_task`** — what was originally asked for in
  journal #3 ("make the outline of the big task gradient red"). Goals and projects keep the
  Round-1 "size & weight" treatment (+0.2 size, weight 680) without the red outline, so the
  outline means one thing: *this needs breaking down*.
- Area: hollow hub, soft border, small uppercase Geist Mono label, constant size (areas
  aren't ranked).
- Detail panel labels: Goal · Project · Big task · Task · Habit · Area · Class · Idea · Note
  ("Objective" stays the group label for goal + project).
- Create sheet: types grouped by family, each with its one-line question.

## What was built (2026-09-29)

- **Migration** (apply before the build reaches prod): allows `big_task`, `area`,
  `note` (keeps `concept` allowed so the old build works until deploy); backfills roots
  → area, concepts with children → area / without → note, tasks with task/big task/habit
  children → big_task; trigger `promote_task_with_children` keeps "a task that gains a
  step becomes a big task" true on every edge write. No model pass over old goals — they
  stay goals until the user retypes them.
- **Logic:** scoring/planner/Focus/next-action/nudges/retrieval/auto-apply/merge/dedup
  tables all know the new types. Planner never schedules areas, classes, ideas or notes;
  a big task with steps plans its steps, without steps one work session. Dedup lets a big
  task match an old task or project with the same meaning.
- **Prompts:** one "Node types" section in extract-v22 (each type's question, tie-breakers,
  nesting), every example re-typed (clusters → area, "Make Money" → area, "Pass X" →
  goal since the follow-up); light prompt got the same questions plus the heading → area
  rule; assistant + the chat tools' node_type field description; breakdowns: "AI roadmap"
  = phases (each a big task) with steps for every type, "Quick tasks" = 1–3 next actions;
  merge-check-v2; judgment_v2.
- **UI:** canvas — big task = red pill + gradient-red outline + step ticks, project = thin
  progress bar, goal/project keep size & weight, area = hollow hub with a mono uppercase
  label at constant size, idea = dashed outline, note = small; one palette everywhere;
  create sheet = the nine types grouped by family with their questions (the broken
  "Custom type" option is gone); Todos lists big tasks with "2/5 steps" and expands to
  their steps; human labels in review, roadmap, detail panel, filters.
- **Markers:** goal target badge, class term tag ("FALL ’26"), habit cadence dots (one per
  weekly target, filled by this week's check-ins) — verified in the browser with
  `.claude/skills/verifier-webapp/verify-node-types.mjs`.
- **Follow-up (same day):** passing an exam/course is a goal, a big task is
  a piece of work; big tasks hold phases and get deep AI roadmaps (phases → steps); areas
  may nest; a task holding a project phase is promoted too; step progress counts hidden
  completed steps; prompts extract-v23 / extract-light-v3 / assistant-v19. The eval below
  ran BEFORE this change (exams came out as big tasks then).
- **Eval (live, ~$0.30):** first Round-1 dump from scratch → every "Pass X exam" a big
  task, Make Money and fitness areas, internship a dated goal, reselling an idea; follow-up
  against the real workspace attaches to old-typed nodes without duplicates, notes for
  people/advice, Life Admin area, "lose 5 kg by March" a goal with habits; light probes
  and chat (Haiku) type big tasks, tasks, notes, areas and goals correctly.

## Build plan (as proposed)

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

## Decisions (all approved 2026-09-29, as recommended)

1. Keep `class` (recommended — students are core users and courses behave differently), or
   fold it into `area`?
2. Move the gradient-red outline from goal/project to big_task (recommended)?
3. Backfill existing workspaces with a review list (recommended), or start Round 2 on a
   fresh workspace and only migrate the schema?
4. Name the knowledge type "Note" (recommended) or keep "Concept"?
