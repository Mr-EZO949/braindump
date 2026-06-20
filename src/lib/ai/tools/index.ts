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
import { INTERACTIVE_TOOLS } from "./interactive";

export type { ToolContext, ToolDefinition, ToolSchema, ToolHandler } from "./read-only";

// Read-only tools execute eagerly inside the agent loop. Mutation tools and
// interactive tools (ask_choice) PAUSE the loop — the resume endpoint runs the
// mutation handler after Accept, or feeds the user's pick back for ask_choice.
const ALL_MUTATION_TOOLS: ToolDefinition[] = [...MUTATION_TOOLS, ...PLANNER_MUTATION_TOOLS];
const REGISTRY: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  ...ALL_MUTATION_TOOLS,
  ...INTERACTIVE_TOOLS,
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.schema.name, t]));
const READ_ONLY_NAMES = new Set(READ_ONLY_TOOLS.map((t) => t.schema.name));
const MUTATION_NAMES = new Set(ALL_MUTATION_TOOLS.map((t) => t.schema.name));
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
