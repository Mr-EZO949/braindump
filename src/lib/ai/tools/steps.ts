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
      "Steps the user did NOT list, for one item (\"break X into steps\", \"a roadmap for X\", \"where do I start\"): a specialist writes them from its description and what is under it; they wait on a card as a suggestion. node_id when the item is in the graph; otherwise title (+ node_type, parent_node_id) creates it with its steps.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        title: { type: "string", description: "Only for an item not in the graph" },
        node_type: { type: "string", enum: ["goal", "project", "big_task", "task"], description: "With title" },
        parent_node_id: { type: "string", description: "With title: where it goes" },
        shape: {
          type: "string",
          enum: [...STEP_SHAPES],
          description:
            "steps (default): 3–7 ordered steps. roadmap: phases with steps (a roadmap, phases, a plan for a goal). next: only the first 1–3 actions (\"where do I start\").",
        },
        note: {
          type: "string",
          description:
            "Usually omit — the specialist reads the message. Only for what it doesn't say: the breakdown they just said yes to, what \"deeper\" refers to.",
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
