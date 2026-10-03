// The step-writer (lib/ai/step-writer.ts): ONE focused call that writes the
// steps for one item — chat's write_steps tool and the Details panel's
// Quick steps / AI roadmap buttons both use it, so the two produce the same
// steps (fix list #7, #8). It sees the item, its parent, what is already under
// it and the user's words; nothing else.
//
// v1 (2026-10-03): replaces two older paths — a whole chat turn on Sonnet
// (~13K tokens of chat prompt, tools and graph for a breakdown, ~$0.075) and
// suggest-steps-v2 (Haiku wrote brain-dump text, then a second Sonnet
// extraction turned it into proposals). The rules are suggest-steps-v2's:
// start where the item stands, real work not planning-to-plan, concrete doses
// for studying, phases named for what finishes them.

export const STEPS_PROMPT_VERSION = "steps-v1";

export type StepShape = "next" | "steps" | "roadmap";

export const STEPS_SYSTEM = `You write the steps for ONE item in BrainDump, a planning tool for people who freeze when a task feels too big. The user should be able to start the first step today without deciding anything first.

How to write them:
- Start from where it stands. Read the description and the steps already under it: never repeat one that exists, never redo what is done — pick up from there. If something blocks it (waiting on a person, a decision, an input that isn't ready), the step that unblocks it comes first.
- Real work, not planning to plan. Every step moves the thing itself forward. Never "make a study plan", "create a schedule", "outline your approach", "research how to start", "gather resources", "figure out what to do", "break this into tasks". The only exception is a one-time unblock the item needs, like "get the syllabus" when nothing can start without it.
- Learning, studying, a course: concrete doses of the real material — "Watch lecture 3", "Solve 5 practice problems from chapter 2", "Do last year's midterm under time" — never "review the material" or "study more".
- Tailored to THIS item — never a generic textbook sequence. Follow what the user said: how many steps, what to cover, what is already done.
- In order: earlier steps unblock later ones. Mix quick wins with longer work.
- Each step is one sitting with a clear finish. title: under 60 characters, starts with a verb, specific ("Email Prof. Marino about the review session", not "Contact professor"). summary: one sentence — what it involves or why it matters.

Shapes — the request names one:
- next: only the 1–3 most immediate actions, each small enough to do right now. The first push past the blank page, not a plan.
- steps: 3–7 steps in order. Phases only when the work clearly has stages AND needs more than 7 steps.
- roadmap: 2–4 phases in order, each a stage with its own finish line, named for what finishes it ("Collect the survey data", "Ship the beta") — never "Phase 1" or "Prep"; 2–4 steps in each.

JSON only: {"phases":[{"title":"…","summary":"…","steps":[{"title":"…","summary":"…"}]}],"steps":[{"title":"…","summary":"…"}]} — phases filled for a roadmap (steps empty); steps filled otherwise (phases empty).`;

const STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary"],
  properties: { title: { type: "string" }, summary: { type: "string" } },
} as const;

export const STEPS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["phases", "steps"],
  properties: {
    phases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "steps"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          steps: { type: "array", items: STEP_SCHEMA },
        },
      },
    },
    steps: { type: "array", items: STEP_SCHEMA },
  },
} as const;

export interface StepsPromptItem {
  title: string;
  /** Plain label ("big task", "goal"). */
  typeLabel: string;
  description: string | null;
  targetDate: string | null;
  /** True when the item isn't in the graph yet — the steps come with it. */
  isNew: boolean;
}

export function buildStepsUserMessage(params: {
  today: string;
  shape: StepShape;
  item: StepsPromptItem;
  parent: { title: string; typeLabel: string } | null;
  children: Array<{ title: string; done: boolean }>;
  words: string;
}): string {
  const { item } = params;
  return [
    `Today: ${params.today}`,
    `Shape: ${params.shape}`,
    `Item: ${item.typeLabel} "${item.title}"${item.targetDate ? ` (due ${item.targetDate})` : ""}${item.isNew ? " — new, nothing under it yet" : ""}`,
    item.description ? `Description: ${item.description}` : null,
    params.parent ? `Under: ${params.parent.typeLabel} "${params.parent.title}"` : null,
    params.children.length > 0
      ? `Already under it:\n${params.children.map((c) => `- ${c.done ? "[done] " : ""}${c.title}`).join("\n")}`
      : null,
    params.words ? `What the user said: ${params.words}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
