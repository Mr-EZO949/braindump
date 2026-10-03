// write_steps — chat's door to the step-writer (lib/ai/step-writer.ts).
//
// Until 2026-10-03 "break X into steps" ran its WHOLE chat turn on Sonnet
// (chat-router.ts usesSonnet): ~13K tokens of chat prompt, tools and graph at
// Sonnet prices, ~$0.075, and the follow-ups stayed on Sonnet. Now chat stays
// on Haiku, which only decides THAT steps are wanted and for which node; one
// focused Sonnet call writes them (fix list #7).
//
// A "planned" tool like change and build_graph: the steps are written before
// the model hears back, and they wait on the card as a suggestion — the user
// didn't write them. The handler applies the rows accepted there.

import { STEP_SHAPES, writeSteps, type StepShape } from "@/lib/ai/step-writer";

import { applyBuildPlan, type BuildPlanInput } from "./apply-plan";
import type { TurnPlan } from "./change";
import type { ToolContext, ToolDefinition } from "./read-only";

export const WRITE_STEPS_TOOL = "write_steps";

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// What the step-writer reads as the user's words: their message, word for
// word, and the chat model's note only for what the message leaves out
// ("yes" to a breakdown it offered, "make it deeper").
export function stepWords(userMessage: string | undefined, note: string): string {
  const message = (userMessage ?? "").trim();
  if (!note) return message;
  if (!message) return note;
  return `${message}\n(From the conversation: ${note})`;
}

export async function planSteps(input: unknown, ctx: ToolContext): Promise<TurnPlan> {
  const args = (input ?? {}) as Record<string, unknown>;
  const shape: StepShape = (STEP_SHAPES as readonly string[]).includes(str(args.shape))
    ? (str(args.shape) as StepShape)
    : "steps";
  const written = await writeSteps({
    supabase: ctx.supabase,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    today: ctx.today ?? new Date().toISOString().slice(0, 10),
    target: {
      node_id: str(args.node_id) || undefined,
      title: str(args.title) || undefined,
      node_type: str(args.node_type) || undefined,
      parent_node_id: str(args.parent_node_id) || undefined,
    },
    shape,
    words: stepWords(ctx.userMessage, str(args.note).slice(0, 500)),
    signal: ctx.signal,
    source: "assistant-steps",
  });
  if (!written.ok) return { turn: null, waiting: null, result: { accepted: false, error: written.error } };
  return {
    turn: { added: [], done: [], links: [], questions: [] },
    waiting: { changes: written.ops, origin: "chat", suggested: true },
    result: {},
  };
}

const WRITE_STEPS: ToolDefinition = {
  schema: {
    name: WRITE_STEPS_TOOL,
    description:
      "Write steps the user did NOT list — \"break X into steps\", \"subtasks for X\", \"a roadmap for X\", \"how do I start X\", \"where do I begin\". A specialist writes them for one item from its description, what is already under it and the user's words, and they show on a card as a suggestion for the user to tick. Give node_id when the item is in the graph; otherwise title (+ node_type, parent_node_id) and the item is created with its steps. Steps the user named themselves go in change (source user), not here.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The node to break down — its id from the snapshot or search_nodes." },
        title: { type: "string", description: "Only when the item isn't in the graph: its title." },
        node_type: { type: "string", enum: ["goal", "project", "big_task", "task"], description: "With title: the new item's type." },
        parent_node_id: { type: "string", description: "With title: where the new item goes (an existing node id)." },
        shape: {
          type: "string",
          enum: [...STEP_SHAPES],
          description:
            "steps (default) = 3–7 ordered steps. roadmap = phases with steps, when they ask for a roadmap, phases or a plan for a goal or project. next = only the first 1–3 actions (\"where do I start\", \"just the next step\").",
        },
        note: {
          type: "string",
          description:
            "Usually leave out — the specialist reads the user's message itself. Only for what the message doesn't say: the breakdown the user just said yes to, or what \"deeper\" / \"smaller\" refers to.",
        },
      },
    },
  },
  // Runs only for the rows the user accepted on the card.
  handler: async (input, ctx: ToolContext) => {
    const plan = (input ?? {}) as Partial<BuildPlanInput>;
    if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
      return { accepted: false, error: "No steps to apply — call write_steps again." };
    }
    return applyBuildPlan(plan as BuildPlanInput, ctx);
  },
};

export const STEP_TOOLS: ToolDefinition[] = [WRITE_STEPS];
