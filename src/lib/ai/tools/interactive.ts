// Interactive tools — they don't read or mutate the graph; they pause the agent
// loop to ask the USER something, then resume with the user's answer as the
// tool_result. Like mutation tools, the handler never runs eagerly: the pause
// is surfaced as an inline card and the resume endpoint feeds the answer back.

import type { ToolDefinition } from "./read-only";

// ask_choice — forced-choice clarifying question. The model calls this when the
// user's intent is genuinely ambiguous and a wrong guess would waste real
// effort. The client renders the options as buttons; the picked option comes
// back as the tool_result so the loop continues with the answer known.
const ASK_CHOICE: ToolDefinition = {
  schema: {
    name: "ask_choice",
    description:
      "Ask ONE forced-choice question (2–4 short, mutually exclusive options) when their intent is genuinely ambiguous and a wrong guess would waste real effort. Not for open questions, things you can infer, or offering next actions. After they pick, continue as if they'd said it. The card shows the options — don't repeat them in text.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One sentence" },
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
      },
      required: ["question", "options"],
    },
  },
  // Never executed: ask_choice pauses the loop and is resolved by the user's
  // pick at the resume endpoint. If this ever runs, it's a wiring bug.
  handler: async () => {
    throw new Error("ask_choice is resolved via the inline choice card, not executed.");
  },
};

export const INTERACTIVE_TOOLS: ToolDefinition[] = [ASK_CHOICE];

export type ChoiceResolution = { ok: true; chosen: string } | { ok: false };

// Validate a user's ask_choice pick against the options that were actually
// offered. Pure + total so the resume route can trust an arbitrary client body
// without re-deriving the rules inline (and so it's unit-testable).
//
// Guards two real hazards: `options` arriving as a non-array (a string would
// make `.includes` do SUBSTRING matching — a tampered choice like "," could
// sneak through), and the empty-string option (a tagged union avoids the
// `!picked` falsy trap that would 400 a legitimately-offered "").
export function resolveChoice(options: unknown, choice: unknown): ChoiceResolution {
  if (!Array.isArray(options)) return { ok: false };
  const valid = options.filter((o): o is string => typeof o === "string");
  if (typeof choice === "string" && valid.includes(choice)) {
    return { ok: true, chosen: choice };
  }
  return { ok: false };
}
