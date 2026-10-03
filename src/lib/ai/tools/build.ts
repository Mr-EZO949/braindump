// build_graph — chat's door to the graph builder (docs/unified-turn.md).
//
// The chat model (Haiku) decides THAT a message needs structural work — a
// restructure, a multi-item capture. The builder (lib/ai/extraction.ts
// runBuilder: Sonnet on the narrow extraction prompt, with relevance retrieval
// and deduplication) decides WHAT the work is. So the same brain places and
// regroups nodes whether the words arrive in the Brain Dump box or in chat,
// and Sonnet no longer carries a whole chat turn to do it.
//
// A "planned" tool: the builder's change set goes through the same policy as
// a brain dump's (dump-turn.ts) before the model hears back — what the user
// reliably accepts is applied at once with Undo, the reorganizing waits on
// the card, and the handler applies exactly the rows accepted there.

import { builderToOps } from "@/lib/ai/builder-ops";
import { applyDumpChanges } from "@/lib/ai/dump-turn";
import { runBuilder } from "@/lib/ai/extraction";

import { applyBuildPlan, type BuildPlanInput } from "./apply-plan";
export { applyBuildPlan, type BuildPlanInput } from "./apply-plan";
import { appliedForModel, createChatEntry, type TurnPlan } from "./change";
import type { ToolContext, ToolDefinition } from "./read-only";

export const BUILD_GRAPH_TOOL = "build_graph";

// A message that only agrees to something the assistant offered.
const BARE_AGREEMENT =
  /^\s*(yes|yeah|yep|yup|ok|okay|sure|please do|do it|do that|go ahead|go for it|sounds good|exactly|right)\b[^\n]{0,24}$/i;
// From this length on a message says everything itself and the note is dropped.
const NOTE_MAX_MESSAGE_CHARS = 120;

// The text the builder reads: the user's own message, word for word. The chat
// model's note is only let in where the message can't stand alone:
//   • a bare "yes" → the note IS the request (the change the user agreed to);
//   • a short message → the note resolves "it" / "that", nothing more.
// A long message gets no note at all. In the first live eval Haiku paraphrased
// anyway, and one paraphrase was wrong: "finished the italian placement test"
// became "finished Italian Crash Course" — and the builder completed the
// course.
export function builderText(userMessage: string | undefined, note: string): string {
  const message = (userMessage ?? "").trim();
  if (!message) return note;
  if (!note) return message;
  if (message.length <= 40 && BARE_AGREEMENT.test(message)) return note;
  if (message.length >= NOTE_MAX_MESSAGE_CHARS) return message;
  return `${message}\n\n(What the user is referring to, from the conversation — use it only to resolve "it" / "that" / "this"; the user's own words above decide what changes: ${note})`;
}

export async function planBuild(input: unknown, ctx: ToolContext): Promise<TurnPlan> {
  const args = (input ?? {}) as { note?: unknown };
  const note = typeof args.note === "string" ? args.note.trim().slice(0, 1500) : "";
  const rawText = builderText(ctx.userMessage, note);
  if (!rawText) {
    return { turn: null, waiting: null, result: { accepted: false, error: "Nothing to build from — pass a note." } };
  }

  const built = await runBuilder({
    rawText,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    supabase: ctx.supabase,
    today: ctx.today,
    signal: ctx.signal,
    source: "assistant-build",
    expandChildren: true,
  });
  if (!built.ok) {
    return { turn: null, waiting: null, result: { accepted: false, error: built.userMessage } };
  }

  const ops = builderToOps({
    nodes: built.nodes,
    changes: built.changes,
    completeExistingNodeIds: built.completeExistingNodeIds,
    autoCompleteLocalRefs: built.autoCompleteLocalRefs,
  });
  const questions = built.clarifyingQuestions;
  if (ops.length === 0) {
    return {
      turn: null,
      waiting: null,
      result: {
        built: 0,
        message: "The builder found nothing to add or change.",
        ...(questions.length > 0
          ? { questions, next: "Ask the user these in your own words, briefly — no card was shown." }
          : {}),
      },
    };
  }

  // The ledger needs an entry to hang on; without one everything waits.
  const entryId = await createChatEntry(ctx);
  if (!entryId) {
    return {
      turn: { added: [], done: [], links: [], questions },
      waiting: { changes: ops, origin: "chat" },
      result: {},
    };
  }
  const changes = await applyDumpChanges({
    ctx,
    rawEntryId: entryId,
    built,
    completeExistingNodeIds: built.completeExistingNodeIds,
    autoApply: ctx.autoApply !== false,
    source: "chat",
  });
  const turn = { added: changes.added, done: changes.done, links: changes.links, questions, undo: changes.undo };
  return {
    turn,
    waiting:
      changes.waiting.length > 0
        ? { changes: changes.waiting, origin: "chat", ...(changes.notes.length > 0 ? { notes: changes.notes } : {}) }
        : null,
    result: appliedForModel(turn, changes.waiting.length),
  };
}

const BUILD_GRAPH: ToolDefinition = {
  schema: {
    name: BUILD_GRAPH_TOOL,
    description:
      "Hand structural work to the graph builder, which reads the user's message word for word against their nodes and plans every new node, parent, rename, move and link in one card, without duplicates. For (1) reorganizing existing nodes beyond one plain move — regroup, split, 'X should be its own project with A and B in it', 'X is more of a Z thing but still helps Y'; (2) a message that adds several things at once or reads like a brain dump / update.",
    input_schema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description:
            "Usually omit. Only (1) which node 'it' / 'that' means, by exact title, or (2) the full change they just said 'yes' to, with exact titles. Never summarize or rephrase their message — a wrong paraphrase changes the wrong thing.",
        },
      },
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const plan = (input ?? {}) as Partial<BuildPlanInput>;
    if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
      return { accepted: false, error: "No planned changes to apply — call build_graph again." };
    }
    return applyBuildPlan(plan as BuildPlanInput, ctx);
  },
};

export const BUILD_TOOLS: ToolDefinition[] = [BUILD_GRAPH];
