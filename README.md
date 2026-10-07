# BrainDump

A second brain for people who freeze up — ADHD paralysis, executive dysfunction, or just too
much in your head. You dump everything you're carrying in plain words; BrainDump turns it into
a living graph of goals, projects and tasks, and when you're stuck it tells you the one thing
to do next.

Not a productivity tool that scolds you — a place to offload first, then find direction.

## What it does

- **Brain dump → graph.** Free text (typed or spoken) becomes nodes and connections: goals,
  projects, big tasks, tasks, habits, areas, ideas and notes, nested under what they belong
  to. Vague items like "learn Italian" are treated as goals and broken down, not scheduled.
- **The AI proposes, you decide.** Changes land as proposals. Items you reliably accept are
  applied directly with one-tap Undo, calibrated from your own accept/reject history;
  everything else waits on a card for review.
- **Focus — "What now?"** A paralysis-relief screen that picks a short list of next steps from
  deadlines, stakes, momentum and neglect, and fits them into the free time you actually have.
- **Day planner.** Plans the rest of your day around fixed commitments (classes, shifts),
  replans when you go off schedule, and says what is safe to ignore today.
- **Chat assistant.** Ask about your graph or tell it what happened ("the exam got moved to
  Friday") and it updates the graph under the same review rules as a dump.
- **Also:** Todos, Habits with streak history, Roadmap by target date, weekly reflection,
  duplicate detection and merge, nudges for at-risk items, PWA install.

## How it's built

| Layer | Stack |
| --- | --- |
| App | Next.js 16 (App Router), React 19, TypeScript |
| Graph | Custom SVG renderer with D3-force relaxation around structural rest positions |
| Data | Supabase (Postgres, Auth, row-level security), pgvector |
| AI | Claude (Sonnet for graph building and planning, Haiku for chat and classifiers), Gemini (embeddings, cheap Q&A routing), Cohere rerank |
| Tests | Vitest unit tests, an offline/live eval harness for prompts |
| Hosting | Vercel (functions in `dub1`, next to the database) |

Some design choices worth calling out:

- **One writer for AI graph changes.** Every model-originated change — from a dump, a chat
  turn or a planner action — goes through a single change-set function with local references,
  a cycle-guarded parent model, and recorded undo steps.
- **Ranking without a model.** Node importance and Focus order are deterministic: lead-time
  deadline pressure inherited from dated parents, stakes, decaying user steering, holds and
  rotation. The LLM only judges significance. See [`docs/ranking.md`](docs/ranking.md).
- **Cost as a constraint.** Every model call is logged with its real price (including prompt
  cache reads/writes). Chat is routed: plain questions go to a small model with no tools, and
  only turns that need to act reach Claude. Prompts are versioned and cache-friendly.
- **Validated structured output.** Model output is schema-checked before anything is written;
  failures are logged, never applied.

Design notes for the larger subsystems live in [`docs/`](docs/).

## Running locally

```bash
npm install
npm run dev
```

Required environment (`.env.local`):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
COHERE_API_KEY=          # optional: falls back to embedding order
```

AI features are off unless enabled: `AI_EXTRACTION_ENABLED`, `AI_EMBEDDING_ENABLED`,
`AI_EDGE_INFERENCE_ENABLED`, `AI_PLANNER_ENABLED`, `AI_MERGE_SUGGESTIONS_ENABLED`,
`AI_LIFECYCLE_CASCADE_ENABLED` (set to `"true"`). Database migrations are in
`supabase/migrations/`.

Checks: `npx tsc --noEmit -p .` · `npx vitest run` · `npm run lint` · `npm run build`.

## License

Copyright (c) 2026 Zhangir Ospan. All rights reserved. The source is published for viewing
only; see [LICENSE](LICENSE).
