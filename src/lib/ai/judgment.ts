// AI node judgment — per-node importance score from a Haiku call.
//
// Called event-driven only: on new-node creation (single-node scoring) and on
// explicit `rerank_importance` (batch scoring across the workspace). Never on
// a timer.
//
// Writes to `ai_node_judgments`. The latest row per node is read by
// computeWorkspaceScores as the `ai_judgment_score` signal.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AI_MODELS } from "./config";
import { claudeCostUSD, readClaudeUsage, totalInputTokens, type UsageTotals } from "./usage";
import { persistAIRun } from "./telemetry";
import type { AIRunType } from "@/types/ai";
import type { WorkspaceProfile } from "@/types/graph";

const MAX_TITLE_CHARS = 140;
const MAX_SUMMARY_CHARS = 280;

interface JudgmentNodeInput {
  id: string;
  title: string;
  summary: string | null;
  node_type: string;
  parent_title?: string | null;
  child_count?: number;
}

interface JudgmentResult {
  node_id: string;
  score: number;
  reason: string;
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

export const JUDGMENT_PROMPT_VERSION = "judgment_v3";

// Output budget per node: a short ref, the score and a ≤90-char reason come to
// ~35 tokens compact; 80 leaves room for a model that pretty-prints. Nodes are
// judged in chunks so the budget never hits the 4000 cap (v2 used 50/node with
// full UUIDs and silently lost whole reranks to truncated JSON).
const OUTPUT_TOKENS_PER_NODE = 80;
const OUTPUT_TOKENS_BASE = 150;
const MAX_NODES_PER_CALL = 40;

function buildSystemPrompt(): string {
  return [
    "You are a ranking assistant that scores how SIGNIFICANT individual nodes are in a user's thinking graph — how much each matters to their life and stated goals.",
    "Each node is a goal (a measurable outcome), project (a body of work), big_task (one deliverable that takes several sittings), task (one sitting), habit, area (an ongoing part of life — structure, not work), class, idea, or note (something to remember).",
    "Areas and notes are context: score an area by how active the life domain is, and a note low unless the user's focus depends on it.",
    "Judge significance only, not timing: deadlines, stakes and what the user asked to focus on are scored separately, so never raise a score because something is due soon.",
    "",
    "Rate significance 0–100 where:",
    "- 90–100: central to the user's life right now (a top-level goal they've named, or work it can't happen without)",
    "- 70–89: clearly important — directly serves a stated goal",
    "- 40–69: relevant — supports a goal indirectly, or is a dormant area",
    "- 10–39: minor — loosely connected, exploratory, or low-leverage",
    "- 0–9: noise — stale fragments or disconnected ideas",
    "",
    "Reason: ONE short sentence (≤90 chars) on the node's role in the user's world, not generic statements.",
    "",
    "Return compact JSON on one line — no indentation, no prose outside the JSON.",
  ].join("\n");
}

function buildUserPrompt(params: {
  nodes: Array<JudgmentNodeInput & { ref: string }>;
  workspaceProfile: WorkspaceProfile | null;
  focusHint: string | null;
}): string {
  const { nodes, workspaceProfile, focusHint } = params;
  const lines: string[] = [];

  lines.push("## Workspace context");
  if (workspaceProfile) {
    if (workspaceProfile.role) lines.push(`Role: ${workspaceProfile.role}`);
    if (workspaceProfile.current_focus)
      lines.push(`Current focus: ${workspaceProfile.current_focus}`);
    if (workspaceProfile.success_title)
      lines.push(`Success: ${workspaceProfile.success_title}`);
    if (workspaceProfile.goals?.length) {
      lines.push(`Stated goals: ${workspaceProfile.goals.slice(0, 6).join("; ")}`);
    }
  } else {
    lines.push("(no workspace profile — use node context only)");
  }

  if (focusHint) lines.push(`\nUser-provided focus for this rerank: ${focusHint}`);

  lines.push("\n## Nodes to score");
  for (const n of nodes) {
    const parts = [
      `[${n.ref}]`,
      `type=${n.node_type}`,
      `title="${truncate(n.title, MAX_TITLE_CHARS)}"`,
    ];
    if (n.summary) parts.push(`summary="${truncate(n.summary, MAX_SUMMARY_CHARS)}"`);
    if (n.parent_title) parts.push(`parent="${truncate(n.parent_title, 60)}"`);
    if (typeof n.child_count === "number") parts.push(`children=${n.child_count}`);
    lines.push("- " + parts.join(" "));
  }

  lines.push(
    "\n## Output format",
    'Return JSON: {"results":[{"ref":"<ref from the brackets>","score":<0-100>,"reason":"<=90 chars"}]}',
    "One entry per node. score is an integer. No extra keys.",
  );

  return lines.join("\n");
}

export function parseJudgmentResponse(text: string, idByRef: Map<string, string>): JudgmentResult[] {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: JudgmentResult[] = [];
  for (const r of parsed.results) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const ref = typeof row.ref === "string" ? row.ref : typeof row.node_id === "string" ? row.node_id : null;
    const node_id = ref ? (idByRef.get(ref) ?? null) : null;
    const score = typeof row.score === "number" ? row.score : Number(row.score);
    const reason = typeof row.reason === "string" ? row.reason : "";
    if (!node_id || !Number.isFinite(score)) continue;
    out.push({
      node_id,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reason: reason.slice(0, 240),
    });
  }
  return out;
}

// One Haiku call for up to MAX_NODES_PER_CALL nodes. Nodes go in as short refs
// (n1, n2, …) — full UUIDs cost ~22 output tokens each — and a response cut
// off at max_tokens counts as a failure instead of silently scoring nothing.
async function judgeChunk(params: {
  client: Anthropic;
  systemPrompt: string;
  chunk: JudgmentNodeInput[];
  workspaceProfile: WorkspaceProfile | null;
  focusHint: string | null;
  runType: AIRunType;
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<JudgmentResult[]> {
  const { client, systemPrompt, chunk, workspaceProfile, focusHint, runType, supabase, userId, workspaceId } = params;
  const withRefs = chunk.map((n, i) => ({ ...n, ref: `n${i + 1}` }));
  const idByRef = new Map(withRefs.map((n) => [n.ref, n.id]));
  const userPrompt = buildUserPrompt({ nodes: withRefs, workspaceProfile, focusHint });

  const startedAt = Date.now();
  let results: JudgmentResult[] = [];
  let usage: UsageTotals | null = null;
  let status: "success" | "failed" = "success";
  let errorText: string | null = null;

  try {
    const res = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: Math.min(4000, OUTPUT_TOKENS_BASE + chunk.length * OUTPUT_TOKENS_PER_NODE),
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    usage = readClaudeUsage(res.usage);

    if (res.stop_reason === "max_tokens") {
      throw new Error(`output cut off at max_tokens (${chunk.length} nodes)`);
    }
    const block = res.content.find((b) => b.type === "text");
    if (block && block.type === "text") {
      results = parseJudgmentResponse(block.text, idByRef);
    }
    if (results.length === 0) throw new Error("no usable scores in the response");
  } catch (err) {
    status = "failed";
    results = [];
    errorText = err instanceof Error ? err.message : String(err);
    console.error("[judgment] Haiku call failed:", errorText);
  }

  await persistAIRun({
    supabase,
    userId,
    workspaceId,
    source: "judgment",
    run: {
      run_type: runType,
      provider: "claude",
      model_name: AI_MODELS.CLAUDE_HAIKU,
      prompt_version: JUDGMENT_PROMPT_VERSION,
      input_hash: null,
      output_hash: null,
      input_tokens: usage ? totalInputTokens(usage) : null,
      output_tokens: usage?.output ?? null,
      latency_ms: Date.now() - startedAt,
      estimated_cost: usage ? claudeCostUSD(AI_MODELS.CLAUDE_HAIKU, usage) : null,
      status,
      error_text: errorText,
    },
  }).catch(() => {});

  return results;
}

export async function scoreNodesJudgment(params: {
  nodes: JudgmentNodeInput[];
  workspaceProfile: WorkspaceProfile | null;
  focusHint?: string | null;
  runType?: AIRunType;
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<JudgmentResult[]> {
  const {
    nodes,
    workspaceProfile,
    focusHint = null,
    runType = "node_judgment",
    supabase,
    userId,
    workspaceId,
  } = params;

  if (nodes.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[judgment] ANTHROPIC_API_KEY not set — skipping");
    return [];
  }

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt();

  const results: JudgmentResult[] = [];
  for (let offset = 0; offset < nodes.length; offset += MAX_NODES_PER_CALL) {
    const chunk = nodes.slice(offset, offset + MAX_NODES_PER_CALL);
    results.push(
      ...(await judgeChunk({ client, systemPrompt, chunk, workspaceProfile, focusHint, runType, supabase, userId, workspaceId })),
    );
  }

  if (results.length === 0) return [];

  const rows = results.map((r) => ({
    node_id: r.node_id,
    workspace_id: workspaceId,
    user_id: userId,
    score: r.score,
    reason: r.reason || null,
    model_name: AI_MODELS.CLAUDE_HAIKU,
  }));

  const { error } = await supabase.from("ai_node_judgments").insert(rows);
  if (error) {
    console.error("[judgment] insert failed:", error.message);
  }

  return results;
}

// Convenience wrapper for single-node scoring (extraction accept, etc.)
export async function scoreSingleNodeJudgment(params: {
  node: JudgmentNodeInput;
  workspaceProfile: WorkspaceProfile | null;
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<JudgmentResult | null> {
  const results = await scoreNodesJudgment({
    nodes: [params.node],
    workspaceProfile: params.workspaceProfile,
    supabase: params.supabase,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
  return results[0] ?? null;
}
