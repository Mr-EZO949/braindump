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
import { MUTATION_TOOLS } from "./mutations";
import { PLANNER_MUTATION_TOOLS } from "./planner-mutations";
import { PRIORITY_MUTATION_TOOLS } from "./priority-mutations";
import { COMMITMENT_MUTATION_TOOLS } from "./commitment-mutations";
import { INTERACTIVE_TOOLS } from "./interactive";
import { BUILD_GRAPH_TOOL, BUILD_TOOLS, planBuild } from "./build";
import type { AppliedMarkerPayload } from "@/lib/chat/applied-marker";

export type { ToolContext, ToolDefinition, ToolSchema, ToolHandler } from "./read-only";

// Read-only tools execute eagerly inside the agent loop. Mutation tools and
// interactive tools (ask_choice) PAUSE the loop — the resume endpoint runs the
// mutation handler after Accept, or feeds the user's pick back for ask_choice.
// Direct tools (update_priorities, set_commitments) change things WITHOUT a
// pause: they run eagerly and hand the browser an Undo instead (dispatchEager
// below). Only fully reversible changes belong here.
// build_graph is a PLANNED mutation: its proposal is worked out server-side
// (the graph builder) before the user is asked — see runTurnTools.
const ALL_MUTATION_TOOLS: ToolDefinition[] = [
  ...MUTATION_TOOLS,
  ...BUILD_TOOLS,
  ...PLANNER_MUTATION_TOOLS,
];
const DIRECT_TOOLS: ToolDefinition[] = [...PRIORITY_MUTATION_TOOLS, ...COMMITMENT_MUTATION_TOOLS];
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

// Tools that pause the agent loop for the user (mutations await confirmation;
// interactive tools await an answer). Anything else runs eagerly.
export function isPausingTool(name: string): boolean {
  return MUTATION_NAMES.has(name) || INTERACTIVE_NAMES.has(name);
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
  // Everything else in the turn, when something pauses.
  deferred: DeferredToolUse[];
  // Changes direct tools made: the browser shows each with an Undo.
  applied: AppliedMarkerPayload[];
  // When nothing pauses: one result per call, in order.
  results: DispatchResult[];
}

// Decides what one assistant turn's tool calls come to. Shared by the chat
// and resume routes, which used to carry a copy each.
//   • The first pausing call becomes the card. build_graph is planned first:
//     with nothing to confirm it turns into a plain result and the next
//     pausing call (if any) takes its place.
//   • Direct tools run even when a card is pending — "took the exam, waiting
//     on the result, and add these three things" must not lose the first half
//     (it used to be auto-rejected as a second action).
//   • Read-only calls next to a card wait for the resume, as before.
export async function runTurnTools(blocks: ToolUse[], ctx: ToolContext): Promise<TurnTools> {
  const done = new Map<string, DispatchResult>();
  const applied: AppliedMarkerPayload[] = [];
  let pending: ToolUse | null = null;

  for (const block of blocks) {
    if (!isPausingTool(block.name)) continue;
    if (block.name !== BUILD_GRAPH_TOOL) {
      pending = block;
      break;
    }
    const plan = await planBuild(block.input, ctx);
    if (plan.kind === "changes") {
      pending = { ...block, input: plan.input };
      break;
    }
    done.set(block.id, {
      name: block.name,
      tool_use_id: block.id,
      content: JSON.stringify(plan.result),
      is_error: false,
    });
  }

  const runEager = async (block: ToolUse): Promise<DispatchResult> => {
    const ran = await dispatchEager({ name: block.name, input: block.input, tool_use_id: block.id, ctx });
    if (ran.applied) applied.push(ran.applied);
    return ran.result;
  };

  if (!pending) {
    const results = await Promise.all(blocks.map((block) => done.get(block.id) ?? runEager(block)));
    return { pending: null, deferred: [], applied, results };
  }

  const deferred: DeferredToolUse[] = [];
  for (const block of blocks) {
    if (block.id === pending.id) continue;
    const result = done.get(block.id) ?? (isDirectTool(block.name) ? await runEager(block) : null);
    deferred.push({
      id: block.id,
      name: block.name,
      input: block.input ?? {},
      ...(result ? { result: { content: result.content, is_error: result.is_error } } : {}),
    });
  }
  return { pending, deferred, applied, results: [] };
}

