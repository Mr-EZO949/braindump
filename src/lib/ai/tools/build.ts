// build_graph — chat's door to the graph builder (docs/unified-turn.md).
//
// The chat model (Haiku) decides THAT a message needs structural work — a
// restructure, a multi-item capture. The builder (lib/ai/extraction.ts
// runBuilder: Sonnet on the narrow extraction prompt, with relevance retrieval
// and deduplication) decides WHAT the work is. So the same brain places and
// regroups nodes whether the words arrive in the Brain Dump box or in chat,
// and Sonnet no longer carries a whole chat turn to do it.
//
// A "planned" tool: the plan is computed server-side (planBuild) before the
// user is asked, the card shows the builder's change set, and the handler
// applies exactly that set after Accept.

import { builderToOps } from "@/lib/ai/builder-ops";
import { runBuilder } from "@/lib/ai/extraction";
import { applyChangeSet, type ChangeOp } from "@/lib/graph/change-set";

import type { ToolContext, ToolDefinition } from "./read-only";

export const BUILD_GRAPH_TOOL = "build_graph";

// What the card shows and the handler applies. `origin: "dump"` marks a set a
// brain dump asked for (api/entries) — its Accept never goes back to a model.
export interface BuildPlanInput {
  changes: ChangeOp[];
  questions?: string[];
  notes?: string[];
  origin?: "chat" | "dump";
}

export type BuildPlan =
  // Something to confirm: the tool pauses on it.
  | { kind: "changes"; input: BuildPlanInput }
  // Nothing to confirm: the model gets this back at once and carries on.
  | { kind: "none"; result: Record<string, unknown> };

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

export async function planBuild(input: unknown, ctx: ToolContext): Promise<BuildPlan> {
  const args = (input ?? {}) as { note?: unknown };
  const note = typeof args.note === "string" ? args.note.trim().slice(0, 1500) : "";
  const rawText = builderText(ctx.userMessage, note);
  if (!rawText) {
    return { kind: "none", result: { accepted: false, error: "Nothing to build from — pass a note." } };
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
    return { kind: "none", result: { accepted: false, error: built.userMessage } };
  }

  const changes = builderToOps({
    nodes: built.nodes,
    changes: built.changes,
    completeExistingNodeIds: built.completeExistingNodeIds,
    autoCompleteLocalRefs: built.autoCompleteLocalRefs,
  });
  const questions = built.clarifyingQuestions;
  if (changes.length === 0) {
    return {
      kind: "none",
      result: {
        built: 0,
        message: "The builder found nothing to add or change.",
        ...(questions.length > 0
          ? { questions, next: "Ask the user these in your own words, briefly — no card was shown." }
          : {}),
      },
    };
  }

  const titleByRef = new Map(built.nodes.map((n) => [n.local_ref, n.proposed_title]));
  const notes = built.possibleDuplicates.map(
    (dup) => `"${titleByRef.get(dup.localRef) ?? "A new item"}" looks like your existing "${dup.existingTitle}".`,
  );
  return {
    kind: "changes",
    input: {
      changes,
      ...(questions.length > 0 ? { questions } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
}

// Applies an accepted plan. The confirmation is written here — counts, what
// didn't land, and the builder's open questions — so the usual Accept needs
// no follow-up model call.
export async function applyBuildPlan(
  plan: BuildPlanInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const { results } = await applyChangeSet(ctx, plan.changes, {
    source: plan.origin === "dump" ? "dump" : "chat",
  });
  const okCount = results.filter((r) => r.ok).length;
  const failedCount = results.length - okCount;
  const questions = (plan.questions ?? []).filter((q) => typeof q === "string" && q.trim());
  const done = okCount === 1 ? "Done ✓" : `Applied ${okCount} changes ✓`;
  return {
    accepted: okCount > 0,
    applied: okCount,
    total: results.length,
    results,
    // A partial failure goes back to the model (actionSucceeded reads
    // `error`) so it can say what didn't land instead of a bare "Done".
    ...(failedCount > 0
      ? { error: `${failedCount} of ${results.length} changes failed — see results` }
      : { message: questions.length > 0 ? `${done}\n\n${questions.join("\n")}` : done }),
  };
}

const BUILD_GRAPH: ToolDefinition = {
  schema: {
    name: BUILD_GRAPH_TOOL,
    description:
      "Hand structural work to the graph builder: it reads the user's message against their existing nodes and works out every new node, parent, rename, move and link in one pass, without creating duplicates. Use it for (1) reorganizing EXISTING nodes beyond one plain move — regroup, split, 'X should be its own project with A and B in it', 'X isn't a Y thing, it's more of a Z thing but it still helps Y'; (2) a message that adds several things at once or reads like a brain dump / update — new items mixed with things done and things to change. The builder sees the user's message word for word, so do NOT restate it. The user gets ONE card listing every change and accepts once.",
    input_schema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description:
            "Usually leave this out. Two uses only: (1) the user's message says 'it' / 'that' / 'this one' → name the node they mean by its exact title; (2) the user just said 'yes' / 'do it' to a change you described → write that change out in full, with exact node titles. Never summarize or rephrase the user's message, and never add your own reading of what they did or want — a wrong paraphrase makes the builder change the wrong thing.",
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
