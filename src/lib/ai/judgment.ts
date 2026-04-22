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
import { AI_COST_PER_1M_TOKENS, AI_MODELS } from "./config";
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

function buildSystemPrompt(): string {
  return [
    "You are a ranking assistant that scores how important individual nodes are in a user's thinking graph.",
    "Each node is a task, goal, project, class, concept, idea, or habit.",
    "",
    "Rate importance 0–100 where:",
    "- 90–100: critical, central to the user's current focus (a top-level goal they've named, or a task blocking it)",
    "- 70–89: clearly important — directly serves a stated goal or is near-term actionable",
    "- 40–69: relevant but not urgent — supports a goal indirectly, or is a dormant area",
    "- 10–39: minor or stale — loosely connected, exploratory, or low-leverage",
    "- 0–9: noise — stale fragments or disconnected ideas",
    "",
    "Reason should be ONE short sentence (≤120 chars) explaining the score. Focus on the node's role in the user's world, not generic statements.",
    "",
    "Return strictly valid JSON. No prose outside the JSON.",
  ].join("\n");
}

function buildUserPrompt(params: {
  nodes: JudgmentNodeInput[];
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
      `[${n.id}]`,
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
    'Return JSON: {"results":[{"node_id":"<id>","score":<0-100>,"reason":"<=120 chars"}]}',
    "One entry per node. score is an integer. No extra keys.",
  );

  return lines.join("\n");
}

function parseJudgmentResponse(text: string): JudgmentResult[] {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: JudgmentResult[] = [];
  for (const r of parsed.results) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const node_id = typeof row.node_id === "string" ? row.node_id : null;
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
  const userPrompt = buildUserPrompt({ nodes, workspaceProfile, focusHint });

  const startedAt = Date.now();
  let results: JudgmentResult[] = [];
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let status: "success" | "failed" = "success";
  let errorText: string | null = null;

  try {
    const res = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: Math.min(4000, 120 + nodes.length * 50),
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    inputTokens = res.usage?.input_tokens ?? null;
    outputTokens = res.usage?.output_tokens ?? null;

    const block = res.content.find((b) => b.type === "text");
    if (block && block.type === "text") {
      results = parseJudgmentResponse(block.text);
    }
  } catch (err) {
    status = "failed";
    errorText = err instanceof Error ? err.message : String(err);
    console.error("[judgment] Haiku call failed:", errorText);
  }

  const latencyMs = Date.now() - startedAt;

  const estimatedCost =
    inputTokens != null && outputTokens != null
      ? (inputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_INPUT +
        (outputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_OUTPUT
      : null;

  await persistAIRun({
    supabase,
    userId,
    workspaceId,
    source: "judgment",
    run: {
      run_type: runType,
      provider: "claude",
      model_name: AI_MODELS.CLAUDE_HAIKU,
      prompt_version: "judgment_v1",
      input_hash: null,
      output_hash: null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: latencyMs,
      estimated_cost: estimatedCost,
      status,
      error_text: errorText,
    },
  }).catch(() => {});

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
