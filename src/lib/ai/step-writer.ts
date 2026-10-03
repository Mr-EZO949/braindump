// The step-writer: ONE focused model call that writes the steps for one item
// and returns them as change-set ops (create_node under the item, phases as
// big tasks with their steps under them). Shared by chat's write_steps tool
// (tools/steps.ts) and the Details panel's Generate steps
// (api/nodes/suggest-steps), so both produce the same steps — and both show
// them as a Suggested card: the user didn't write them.
//
// Model: Sonnet for steps and roadmaps (owner, 2026-10-03: Sonnet writes the
// steps, but not the whole chat turn); Haiku for "next" (the 1–3 immediate
// actions). JSON schema enforced on both.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChangeOp } from "@/lib/graph/change-set";
import { isNodeType, NODE_TYPE_INFO, normalizeNodeType } from "@/lib/graph/node-types";
import type { NodeType } from "@/types/graph";
import { AI_MODELS, claudeRequestTuning } from "./config";
import { hashText } from "./errors";
import {
  buildStepsUserMessage,
  STEPS_OUTPUT_SCHEMA,
  STEPS_PROMPT_VERSION,
  STEPS_SYSTEM,
  type StepShape,
} from "./prompts/steps";
import { recordClaudeRun } from "./telemetry";
import { readClaudeUsage } from "./usage";

export type { StepShape } from "./prompts/steps";
export const STEP_SHAPES: readonly StepShape[] = ["next", "steps", "roadmap"];

const MAX_OUTPUT_TOKENS = 2000;
const MAX_WORDS_CHARS = 1000;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_CHILDREN = 30;
// Caps per shape: what the prompt asks for, plus a little slack.
const MAX_FLAT: Record<StepShape, number> = { next: 3, steps: 8, roadmap: 8 };
const MAX_PHASES = 4;
const MAX_STEPS_PER_PHASE = 5;
const TITLE_MAX = 120;
const STEP_TEMPERATURE = 0.4;

export interface StepTarget {
  /** An existing node to break down. */
  node_id?: string;
  /** Or a new item the steps come with (not in the graph yet). */
  title?: string;
  node_type?: string;
  parent_node_id?: string;
}

export type StepsResult =
  | { ok: true; ops: ChangeOp[]; title: string; model: string; count: number }
  | { ok: false; error: string };

type Step = { title: string; summary: string };
type Phase = Step & { steps: Step[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const key = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function readSteps(raw: unknown, max: number): Step[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({ title: str((s as Step)?.title).slice(0, TITLE_MAX), summary: str((s as Step)?.summary) }))
    .filter((s) => s.title)
    .slice(0, max);
}

/**
 * The model's JSON → ops under the item (`parent` = its id, or the local_ref
 * of a new item created first). Steps already under the item are dropped, and
 * so is a phase left with no steps. Pure.
 */
export function stepsToOps(
  text: string,
  params: { shape: StepShape; parent: { node_id: string } | { local_ref: string }; existingTitles: string[]; refPrefix?: string },
): ChangeOp[] {
  let parsed: { phases?: unknown; steps?: unknown };
  try {
    parsed = JSON.parse(text) as { phases?: unknown; steps?: unknown };
  } catch {
    return [];
  }
  const seen = new Set(params.existingTitles.map(key));
  const fresh = (s: Step) => {
    const k = key(s.title);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const prefix = params.refPrefix ?? "";
  const under =
    "node_id" in params.parent ? { parent_node_id: params.parent.node_id } : { parent_local_ref: params.parent.local_ref };
  const ops: ChangeOp[] = [];
  const pushStep = (s: Step, parent: typeof under | { parent_local_ref: string }) =>
    ops.push({
      kind: "create_node",
      local_ref: `${prefix}t${ops.length + 1}`,
      title: s.title,
      node_type: "task",
      ...(s.summary ? { summary: s.summary } : {}),
      ...parent,
    });

  const phases: Phase[] =
    params.shape === "next" || !Array.isArray(parsed.phases)
      ? []
      : parsed.phases
          .map((p) => ({
            title: str((p as Phase)?.title).slice(0, TITLE_MAX),
            summary: str((p as Phase)?.summary),
            steps: readSteps((p as Phase)?.steps, MAX_STEPS_PER_PHASE),
          }))
          .filter((p) => p.title && p.steps.length > 0)
          .slice(0, MAX_PHASES);

  if (phases.length > 0) {
    for (const phase of phases) {
      if (!fresh(phase)) continue;
      const steps = phase.steps.filter(fresh);
      if (steps.length === 0) continue;
      const ref = `${prefix}p${ops.length + 1}`;
      ops.push({
        kind: "create_node",
        local_ref: ref,
        title: phase.title,
        node_type: "big_task",
        ...(phase.summary ? { summary: phase.summary } : {}),
        ...under,
      });
      for (const step of steps) pushStep(step, { parent_local_ref: ref });
    }
    if (ops.length > 0) return ops;
  }
  for (const step of readSteps(parsed.steps, MAX_FLAT[params.shape]).filter(fresh)) pushStep(step, under);
  return ops;
}

const typeLabel = (type: string) => NODE_TYPE_INFO[normalizeNodeType(type, "task")].label.toLowerCase();

// The item, its parent and what is already under it — all the call sees.
async function loadItem(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string },
  nodeId: string,
) {
  const [{ data: node }, { data: links }] = await Promise.all([
    supabase
      .from("nodes")
      .select("id, title, node_type, summary, body, target_date, status")
      .eq("id", nodeId)
      .eq("user_id", scope.userId)
      .eq("workspace_id", scope.workspaceId)
      .maybeSingle(),
    supabase
      .from("edges")
      .select("source_node_id, target_node_id")
      .eq("user_id", scope.userId)
      .eq("workspace_id", scope.workspaceId)
      .eq("edge_type", "belongs_to")
      .eq("status", "active")
      .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`),
  ]);
  if (!node) return null;
  const rows = (links ?? []) as Array<{ source_node_id: string; target_node_id: string }>;
  const parentId = rows.find((e) => e.source_node_id === nodeId)?.target_node_id ?? null;
  const childIds = rows.filter((e) => e.target_node_id === nodeId).map((e) => e.source_node_id).slice(0, MAX_CHILDREN);
  const ids = [...(parentId ? [parentId] : []), ...childIds];
  const { data: related } = ids.length
    ? await supabase
        .from("nodes")
        .select("id, title, node_type, status")
        .eq("user_id", scope.userId)
        .eq("workspace_id", scope.workspaceId)
        .in("id", ids)
    : { data: [] };
  const byId = new Map(
    ((related ?? []) as Array<{ id: string; title: string; node_type: string; status: string | null }>).map((n) => [n.id, n]),
  );
  const parent = parentId ? byId.get(parentId) ?? null : null;
  return {
    node: node as {
      id: string;
      title: string;
      node_type: string;
      summary: string | null;
      body: string | null;
      target_date: string | null;
    },
    parent: parent ? { title: parent.title, typeLabel: typeLabel(parent.node_type) } : null,
    children: childIds
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => !!n && n.status !== "archived")
      .map((n) => ({ title: n.title, done: n.status === "completed" })),
  };
}

export async function writeSteps(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  today: string;
  target: StepTarget;
  shape: StepShape;
  /** The user's words: the chat message, or the button's directions. */
  words?: string;
  signal?: AbortSignal;
  /** ai_runs source: "assistant-steps" (chat) or "suggest-steps" (button). */
  source: string;
  /** Keeps local_refs apart when several items' steps share one card. */
  refPrefix?: string;
}): Promise<StepsResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "AI is not configured." };
  const scope = { userId: params.userId, workspaceId: params.workspaceId };
  const prefix = params.refPrefix ?? "";

  // The item: an existing node, or a new one the steps come with.
  let item: Parameters<typeof buildStepsUserMessage>[0]["item"];
  let parent: { title: string; typeLabel: string } | null = null;
  let children: Array<{ title: string; done: boolean }> = [];
  let head: ChangeOp[] = [];
  let under: { node_id: string } | { local_ref: string };
  const nodeId = str(params.target.node_id);
  if (nodeId) {
    const loaded = UUID.test(nodeId) ? await loadItem(params.supabase, scope, nodeId) : null;
    if (!loaded) return { ok: false, error: `No node ${nodeId} in this workspace — use an id from the snapshot or search_nodes.` };
    const description = [loaded.node.summary, loaded.node.body].map(str).filter(Boolean).join(" — ");
    item = {
      title: loaded.node.title,
      typeLabel: typeLabel(loaded.node.node_type),
      description: description ? description.slice(0, MAX_DESCRIPTION_CHARS) : null,
      targetDate: loaded.node.target_date,
      isNew: false,
    };
    parent = loaded.parent;
    children = loaded.children;
    under = { node_id: loaded.node.id };
  } else {
    const title = str(params.target.title).slice(0, TITLE_MAX);
    if (!title) return { ok: false, error: "Give node_id (an existing node) or the title of the new item." };
    const rawType = str(params.target.node_type).toLowerCase().replace(/[\s-]+/g, "_");
    const nodeType: NodeType = isNodeType(rawType) ? rawType : "big_task";
    const parentId = str(params.target.parent_node_id);
    if (parentId) {
      if (!UUID.test(parentId)) return { ok: false, error: `No node ${parentId} in this workspace.` };
      const { data } = await params.supabase
        .from("nodes")
        .select("title, node_type")
        .eq("id", parentId)
        .eq("user_id", params.userId)
        .eq("workspace_id", params.workspaceId)
        .maybeSingle();
      if (!data) return { ok: false, error: `No node ${parentId} in this workspace.` };
      parent = { title: data.title as string, typeLabel: typeLabel(data.node_type as string) };
    }
    item = { title, typeLabel: typeLabel(nodeType), description: null, targetDate: null, isNew: true };
    const ref = `${prefix}item`;
    head = [{ kind: "create_node", local_ref: ref, title, node_type: nodeType, ...(parentId ? { parent_node_id: parentId } : {}) }];
    under = { local_ref: ref };
  }

  const model = params.shape === "next" ? AI_MODELS.CLAUDE_HAIKU : AI_MODELS.CLAUDE_SONNET;
  const userMessage = buildStepsUserMessage({
    today: params.today,
    shape: params.shape,
    item,
    parent,
    children,
    words: str(params.words).slice(0, MAX_WORDS_CHARS),
  });
  const client = new Anthropic({ apiKey });
  const startedAt = Date.now();
  let text = "";
  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...claudeRequestTuning(model, STEP_TEMPERATURE),
        output_config: { format: { type: "json_schema", schema: STEPS_OUTPUT_SCHEMA } },
        system: STEPS_SYSTEM,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal: params.signal },
    );
    text = response.content.find((b) => b.type === "text")?.text ?? "";
    const cutOff = response.stop_reason === "max_tokens";
    await recordClaudeRun({
      scope: { supabase: params.supabase, userId: params.userId, workspaceId: params.workspaceId },
      source: params.source,
      model,
      promptVersion: `${STEPS_PROMPT_VERSION}:${params.shape}`,
      usage: readClaudeUsage(response.usage),
      latencyMs: Date.now() - startedAt,
      status: cutOff ? "failed" : "success",
      errorText: cutOff ? "output cut off at max_tokens" : null,
      inputHash: hashText(userMessage),
    });
    if (cutOff) return { ok: false, error: "The steps came back cut off — try again." };
  } catch (err) {
    if (params.signal?.aborted) return { ok: false, error: "Cancelled." };
    console.warn("[step-writer] call failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Couldn't write steps right now — try again." };
  }

  const steps = stepsToOps(text, {
    shape: params.shape,
    parent: under,
    existingTitles: children.map((c) => c.title),
    refPrefix: prefix,
  });
  if (steps.length === 0) return { ok: false, error: `No new steps for "${item.title}" — what's under it already covers it.` };
  return {
    ok: true,
    ops: [...head, ...steps],
    title: item.title,
    model,
    count: steps.filter((op) => op.kind === "create_node" && op.node_type === "task").length,
  };
}
