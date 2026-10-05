// Tool registry + dispatcher for the assistant agent loop.
//
// The agent loop lives in /api/assistant/chat. It:
//   1. Sends a message to Claude with `tools: getToolSchemas()`
//   2. If the response's stop_reason is "tool_use", runs each tool_use block
//      through `dispatchTool`, collects tool_result blocks, and re-invokes
//      Claude with the extended message history.
//   3. Streams text deltas to the client throughout.
//
// Tool handlers are server-side only. Never expose this module to the browser.

import { READ_ONLY_TOOLS, type ToolContext, type ToolDefinition } from "./read-only";
import { CHANGE_TOOL, CHANGE_TOOLS, planChange, type TurnPlan } from "./change";
import { CHANGE_KINDS } from "@/lib/graph/change-set";
import { PLANNER_MUTATION_TOOLS } from "./planner-mutations";
import { PRIORITY_MUTATION_TOOLS } from "./priority-mutations";
import { COMMITMENT_MUTATION_TOOLS } from "./commitment-mutations";
import { REPLAN_TOOLS } from "./replan";
import { INTERACTIVE_TOOLS } from "./interactive";
import { BUILD_GRAPH_TOOL, BUILD_TOOLS, planBuild } from "./build";
import { planSteps, STEP_TOOLS, WRITE_STEPS_TOOL } from "./steps";
import { actionSucceeded, looksMultiStep } from "./confirmations";
import { adviceRows } from "./advice-guard";
import type { AppliedMarkerPayload } from "@/lib/chat/applied-marker";
import type { TurnApplied } from "@/types/ai";

export type { ToolContext, ToolDefinition, ToolSchema, ToolHandler } from "./read-only";

// Read-only tools execute eagerly inside the agent loop. Mutation tools and
// interactive tools (ask_choice) PAUSE the loop — the resume endpoint runs the
// mutation handler after Accept, or feeds the user's pick back for ask_choice.
// Direct tools (update_priorities, set_commitments, replan_today) change things WITHOUT a
// pause: they run eagerly and hand the browser an Undo instead (dispatchEager
// below). Only fully reversible changes belong here — and only what the user
// said: a direct tool call the model marks source "suggestion" waits on a
// card like any mutation (owner, 2026-10-02: advice stays advice until OK'd).
// change and build_graph are PLANNED mutations: the dump policy runs before
// the model hears back (tools/change.ts) — part applied now, part on a card.
// write_steps is planned too: the step-writer runs, the steps wait on a card.
const ALL_MUTATION_TOOLS: ToolDefinition[] = [
  ...CHANGE_TOOLS,
  ...BUILD_TOOLS,
  ...STEP_TOOLS,
  ...PLANNER_MUTATION_TOOLS,
];
const PLANNED_TOOLS = new Set([CHANGE_TOOL, BUILD_GRAPH_TOOL, WRITE_STEPS_TOOL]);
const DIRECT_TOOLS: ToolDefinition[] = [...PRIORITY_MUTATION_TOOLS, ...COMMITMENT_MUTATION_TOOLS, ...REPLAN_TOOLS];
const REGISTRY: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  ...ALL_MUTATION_TOOLS,
  ...DIRECT_TOOLS,
  ...INTERACTIVE_TOOLS,
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.schema.name, t]));
const READ_ONLY_NAMES = new Set(READ_ONLY_TOOLS.map((t) => t.schema.name));
const MUTATION_NAMES = new Set(ALL_MUTATION_TOOLS.map((t) => t.schema.name));
const DIRECT_NAMES = new Set(DIRECT_TOOLS.map((t) => t.schema.name));
const INTERACTIVE_NAMES = new Set(INTERACTIVE_TOOLS.map((t) => t.schema.name));

export function getToolSchemas() {
  return REGISTRY.map((t) => t.schema);
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_NAMES.has(name);
}

export function isMutationTool(name: string): boolean {
  return MUTATION_NAMES.has(name);
}

export function isDirectTool(name: string): boolean {
  return DIRECT_NAMES.has(name);
}

export function isInteractiveTool(name: string): boolean {
  return INTERACTIVE_NAMES.has(name);
}

// A direct tool's call that only suggests — the user didn't ask for it.
export function isSuggestedDirectCall(name: string, input: unknown): boolean {
  return DIRECT_NAMES.has(name) && (input as { source?: unknown } | null)?.source === "suggestion";
}

// Tools that pause the agent loop for the user (mutations await confirmation;
// interactive tools await an answer). Anything else runs eagerly.
export function isPausingTool(name: string, input?: unknown): boolean {
  return MUTATION_NAMES.has(name) || INTERACTIVE_NAMES.has(name) || isSuggestedDirectCall(name, input);
}

export interface DispatchResult {
  name: string;
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

// Runs one tool_use block. Returns a tool_result-ready payload.
// Handler errors are caught and reported to Claude as is_error:true so the
// model can respond gracefully instead of the whole loop aborting.
export async function dispatchTool(params: {
  name: string;
  input: unknown;
  tool_use_id: string;
  ctx: ToolContext;
}): Promise<DispatchResult> {
  const { name, input, tool_use_id, ctx } = params;
  const tool = BY_NAME.get(name);

  if (!tool) {
    return {
      name,
      tool_use_id,
      content: JSON.stringify({ error: `Unknown tool: ${name}` }),
      is_error: true,
    };
  }

  try {
    const result = await tool.handler(input, ctx);
    return {
      name,
      tool_use_id,
      content: JSON.stringify(result ?? {}),
      is_error: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tools] ${name} failed:`, message);
    return {
      name,
      tool_use_id,
      content: JSON.stringify({ error: message }),
      is_error: true,
    };
  }
}

export interface EagerDispatch {
  /** Model-facing result (a direct tool's undo snapshot stripped out). */
  result: DispatchResult;
  /** Set when a direct tool changed something — the browser shows it + Undo. */
  applied: AppliedMarkerPayload | null;
}

// Runs a non-pausing tool inside the agent loop. For a direct tool the undo
// snapshot goes to the browser (in the applied marker), not to the model —
// it's noise in the prompt and would only cost tokens.
export async function dispatchEager(params: {
  name: string;
  input: unknown;
  tool_use_id: string;
  ctx: ToolContext;
}): Promise<EagerDispatch> {
  const result = await dispatchTool(params);
  if (!isDirectTool(params.name) || result.is_error) return { result, applied: null };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
    return { result, applied: null };
  }
  const { undo, ...forModel } = parsed;
  const appliedRows = Array.isArray(parsed.applied) ? (parsed.applied as AppliedMarkerPayload["applied"]) : [];
  return {
    result: { ...result, content: JSON.stringify(forModel) },
    applied:
      parsed.accepted === true && appliedRows.length > 0
        ? {
            tool_name: params.name,
            applied: appliedRows,
            failed: Array.isArray(parsed.failed) ? (parsed.failed as AppliedMarkerPayload["failed"]) : [],
            undo: undo ?? null,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// One assistant turn's tool calls
// ---------------------------------------------------------------------------

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

// A tool call set aside while the user answers a card. `result` is there when
// it already ran (a direct tool, or a planned tool with nothing to confirm);
// the resume route then replays that result instead of running or rejecting it.
export interface DeferredToolUse extends ToolUse {
  result?: { content: string; is_error: boolean };
}

export interface TurnTools {
  // The call the user must answer — with its final input (a planned tool's
  // input IS the plan) — or null when nothing pauses.
  pending: ToolUse | null;
  // A planned tool's card: what it applied at once (with Undo), its
  // questions; the pending rows show inside it.
  turns: TurnApplied[];
  // Everything else in the turn, when something pauses.
  deferred: DeferredToolUse[];
  // Changes direct tools made: the browser shows each with an Undo.
  applied: AppliedMarkerPayload[];
  // When nothing pauses: one result per call, in order.
  results: DispatchResult[];
}

// Decides what one assistant turn's tool calls come to. Shared by the chat
// and resume routes, which used to carry a copy each.
//   • The first pausing call becomes the card. change and build_graph are
//     planned first: what the policy applies now goes on a turn card; with
//     nothing left to confirm the call turns into a plain result and the next
//     pausing call (if any) takes its place.
//   • Direct tools run even when a card is pending — "took the exam, waiting
//     on the result, and add these three things" must not lose the first half
//     (it used to be auto-rejected as a second action).
//   • Read-only calls next to a card wait for the resume, as before.
export async function runTurnTools(modelBlocks: ToolUse[], ctx: ToolContext): Promise<TurnTools> {
  const done = new Map<string, DispatchResult>();
  const applied: AppliedMarkerPayload[] = [];
  const turns: TurnApplied[] = [];
  let pending: ToolUse | null = null;
  const blocks: ToolUse[] = [];
  for (const block of modelBlocks) blocks.push(await separateAdvice(asChangeOp(block), ctx, applied));

  for (const block of blocks) {
    if (!isPausingTool(block.name, block.input)) continue;
    if (!PLANNED_TOOLS.has(block.name)) {
      pending = block;
      break;
    }
    const plan: TurnPlan =
      block.name === BUILD_GRAPH_TOOL
        ? await planBuild(block.input, ctx)
        : block.name === WRITE_STEPS_TOOL
          ? await planSteps(block.input, ctx)
          : await planChange(block.input, ctx);
    if (plan.turn) turns.push(plan.turn);
    if (plan.waiting) {
      pending = { ...block, input: plan.waiting };
      break;
    }
    done.set(block.id, {
      name: block.name,
      tool_use_id: block.id,
      content: JSON.stringify(plan.result),
      is_error: plan.result.accepted === false && typeof plan.result.error === "string",
    });
  }

  const runEager = async (block: ToolUse): Promise<DispatchResult> => {
    const ran = await dispatchEager({ name: block.name, input: block.input, tool_use_id: block.id, ctx });
    if (ran.applied) applied.push(ran.applied);
    return ran.result;
  };

  if (!pending) {
    const results = await Promise.all(blocks.map((block) => done.get(block.id) ?? runEager(block)));
    return { pending: null, turns, deferred: [], applied, results };
  }

  const deferred: DeferredToolUse[] = [];
  for (const block of blocks) {
    if (block.id === pending.id) continue;
    const result =
      done.get(block.id) ??
      (isDirectTool(block.name) && !isSuggestedDirectCall(block.name, block.input) ? await runEager(block) : null);
    deferred.push({
      id: block.id,
      name: block.name,
      input: block.input ?? {},
      ...(result ? { result: { content: result.content, is_error: result.is_error } } : {}),
    });
  }
  return { pending, turns, deferred, applied, results: [] };
}


// After a turn's tool calls ran and nothing waits for the user: is every call
// already on screen as a card? Then a follow-up model call would only say
// "Done" while re-sending the whole prompt (eval 2026-10-03: "did the gym and
// finished my CV — stats or internship?" took a second round, 30K input
// tokens, to add a line after the cards). A planned change (change,
// build_graph, write_steps) counts when it applied without leaving anything
// out; a direct tool when it applied in full. A lookup's result, a failure or
// a change nothing showed for is for the model to read. A direct change
// alone may be step one of "X is done, then add Y" (looksMultiStep). The
// caller still checks what the cards can't carry (needsStepAfterChange) and
// an answer the reply still owes (answerStillOwed).
export function turnNeedsNoFollowUp(turn: TurnTools, message: string): boolean {
  if (turn.pending || turn.results.length === 0) return false;
  for (const result of turn.results) {
    if (!actionSucceeded(result.content, result.is_error)) return false;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(result.content) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (PLANNED_TOOLS.has(result.name)) {
      if (parsed.left_out) return false;
      continue;
    }
    if (isDirectTool(result.name)) {
      const failed = Array.isArray(parsed.failed) ? parsed.failed.length : 0;
      const applied = Array.isArray(parsed.applied) ? parsed.applied.length : 0;
      if (failed > 0 || applied === 0) return false;
      continue;
    }
    return false;
  }
  return turn.turns.length > 0 || !looksMultiStep(message);
}

// Advice stays advice (advice-guard.ts): an update_priorities call marked as
// the user's that carries the assistant's answer to their question splits —
// the rows the user stated apply now (their card, with Undo); the advice rows
// become a suggestion that waits on a card for OK.
async function separateAdvice(block: ToolUse, ctx: ToolContext, applied: AppliedMarkerPayload[]): Promise<ToolUse> {
  const input = block.input as { source?: unknown; changes?: unknown } | null;
  if (block.name !== "update_priorities" || input?.source !== "user" || !Array.isArray(input.changes) || !ctx.userMessage) {
    return block;
  }
  const changes = input.changes as unknown[];
  const advice = new Set(adviceRows(ctx.userMessage, changes as Array<{ action?: unknown }>));
  if (advice.size === 0) return block;
  const stated = changes.filter((_, i) => !advice.has(i));
  if (stated.length > 0) {
    const ran = await dispatchEager({ name: block.name, input: { ...input, changes: stated }, tool_use_id: block.id, ctx });
    if (ran.applied) applied.push(ran.applied);
  }
  return { ...block, input: { ...input, source: "suggestion", changes: changes.filter((_, i) => advice.has(i)) } };
}

// A change op called as if it were a tool ("remove_edge" with the two ids —
// Haiku did it once, 2026-10-04) is that op inside a change call, instead of
// an "Unknown tool" error and a second model round. Without a source it is
// treated as a suggestion, like a change call without one (planChange).
export function asChangeOp(block: ToolUse): ToolUse {
  if (BY_NAME.has(block.name) || !(CHANGE_KINDS as readonly string[]).includes(block.name)) return block;
  const { source, ...op } = (block.input ?? {}) as Record<string, unknown>;
  return {
    ...block,
    name: CHANGE_TOOL,
    input: { source: source === "user" ? "user" : "suggestion", changes: [{ kind: block.name, ...op }] },
  };
}
