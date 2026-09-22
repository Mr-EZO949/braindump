// Claude provider implementation.
// Handles all LLM tasks: extraction, edge inference, assistant, planning.
// generateEmbedding is NOT supported — embeddings still go through Gemini.
// Never import this directly in route handlers — use aiProvider() from index.ts.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

import type { AIProviderResult } from "./provider";
import type {
  ExtractionInput,
  ExtractionOutput,
  EdgeInferenceInput,
  EdgeInferenceOutput,
  AssistantInput,
  AssistantOutput,
  PlanInput,
  PlanOutput,
  MergeCheckInput,
  MergeCheckOutput,
  AIRun,
} from "@/types/ai";
import { AI_MODELS, AI_TEMPERATURE, AI_COST_PER_1M_TOKENS, claudeRequestTuning } from "./config";
import { MalformedAIResponseError } from "./errors";
import {
  validateExtractionOutput,
  validateEdgeInferenceOutput,
  validatePlanOutput,
  validateMergeCheckOutput,
} from "./validation";
import { buildExtractionPromptParts, EXTRACT_PROMPT_VERSION } from "./prompts/extract";

// Cache the extract rubric only when the brain dump is large enough that a
// single session is likely to trigger the 3+ repeat calls needed to beat the
// 1.25× cache-write surcharge. Short one-shot dumps skip caching.
const EXTRACT_CACHE_MIN_DUMP_CHARS = 2000;
import {
  buildEdgeInferencePromptParts,
  INFER_EDGE_PROMPT_VERSION,
} from "./prompts/infer-edge";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "./prompts/assistant";
import { buildPlanPrompt, PLAN_PROMPT_VERSION } from "./prompts/plan";
import { buildMergeCheckPrompt, MERGE_CHECK_PROMPT_VERSION } from "./prompts/merge-check";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Anthropic returns input in THREE buckets: input_tokens (base rate),
// cache_creation_input_tokens (billed 1.25×), cache_read_input_tokens (billed
// 0.1×). Counting only input_tokens undercounts cache writes and overcounts
// cache reads, so logged COGS drifts from the real invoice. readUsage pulls all
// buckets; claudeCost prices each at its real rate. (Cost telemetry only — no
// effect on generation.)
type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

function readUsage(u: ClaudeUsage) {
  const input = u.input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return { input, cacheWrite, cacheRead, output, totalInput: input + cacheWrite + cacheRead };
}

function claudeCost(
  model: "sonnet" | "haiku",
  t: { input: number; cacheWrite: number; cacheRead: number; output: number },
): number {
  const r =
    model === "haiku"
      ? { i: AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_INPUT, o: AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_OUTPUT }
      : { i: AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_INPUT, o: AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_OUTPUT };
  return (
    (t.input / 1_000_000) * r.i +
    (t.cacheWrite / 1_000_000) * r.i * 1.25 +
    (t.cacheRead / 1_000_000) * r.i * 0.1 +
    (t.output / 1_000_000) * r.o
  );
}

function baseRun(
  run_type: AIRun["run_type"],
  prompt_version: string,
  inputText: string,
  modelName: string = AI_MODELS.CLAUDE_SONNET,
): Omit<AIRun, "id" | "created_at"> {
  return {
    run_type,
    provider: "claude",
    model_name: modelName,
    prompt_version,
    input_hash: shortHash(inputText),
    output_hash: null,
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
    estimated_cost: null,
    status: "success",
    error_text: null,
  };
}

// Strips markdown code fences if Claude wraps JSON in ```json ... ```
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

function malformedResponse(params: {
  message: string;
  rawOutput: string;
  runType: AIRun["run_type"];
  promptVersion: string;
  modelName?: string;
  inputHash: string | null;
  outputHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  estimatedCost: number | null;
  cause: unknown;
}): MalformedAIResponseError {
  return new MalformedAIResponseError({
    message: params.message,
    rawOutput: params.rawOutput,
    runType: params.runType,
    provider: "claude",
    modelName: params.modelName ?? AI_MODELS.CLAUDE_SONNET,
    promptVersion: params.promptVersion,
    inputHash: params.inputHash,
    outputHash: params.outputHash,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    latencyMs: params.latencyMs,
    estimatedCost: params.estimatedCost,
    cause: params.cause,
  });
}

// ---------------------------------------------------------------------------
// ClaudeProvider — LLM methods only
// ---------------------------------------------------------------------------

export class ClaudeProvider {
  private client: Anthropic;
  private modelName: string;

  constructor(apiKey: string, modelName: string = AI_MODELS.CLAUDE_SONNET) {
    this.client = new Anthropic({ apiKey });
    this.modelName = modelName;
  }

  // -------------------------------------------------------------------------
  // extractNodes
  // -------------------------------------------------------------------------

  async extractNodes(
    input: ExtractionInput,
  ): Promise<AIProviderResult<ExtractionOutput>> {
    const { rubricBlock, variableBlock } = buildExtractionPromptParts(input);
    // Hash the full prompt so telemetry/input-hash matches the concatenated form.
    const fullPrompt = `${rubricBlock}\n\n${variableBlock}`;
    const run = baseRun("extract", EXTRACT_PROMPT_VERSION, fullPrompt, this.modelName);
    const start = Date.now();

    // Gate caching on dump size — small one-shot dumps won't hit the ~3 reads
    // needed to amortize the 1.25× cache-write cost. Large dumps signal an
    // engaged session likely to re-extract (edits, retries, follow-ups).
    const shouldCache = input.raw_text.length >= EXTRACT_CACHE_MIN_DUMP_CHARS;
    const rubricContent = shouldCache
      ? { type: "text" as const, text: rubricBlock, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text: rubricBlock };

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 8192,
      ...claudeRequestTuning(this.modelName, AI_TEMPERATURE.EXTRACTION),
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text, no explanation — just the raw JSON object.",
      messages: [
        {
          role: "user",
          content: [rubricContent, { type: "text", text: variableBlock }],
        },
      ],
    });

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        "Extraction output was truncated (max_tokens reached). Input may be too dense — try a shorter brain dump.",
      );
    }

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const u = readUsage(response.usage);
    const inputTokens = u.totalInput;
    const outputTokens = u.output;
    const latencyMs = Date.now() - start;
    const estimatedCost = claudeCost("sonnet", u);

    let output: ExtractionOutput;
    try {
      const parsed = JSON.parse(extractJson(text));
      output = validateExtractionOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Extraction output was malformed",
        rawOutput: text,
        runType: "extract",
        promptVersion: EXTRACT_PROMPT_VERSION,
        modelName: this.modelName,
        inputHash: run.input_hash,
        outputHash: shortHash(text),
        inputTokens,
        outputTokens,
        latencyMs,
        estimatedCost,
        cause: error,
      });
    }

    return {
      output,
      run: {
        ...run,
        output_hash: shortHash(text),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latencyMs,
        estimated_cost: estimatedCost,
      },
    };
  }

  // -------------------------------------------------------------------------
  // inferEdge
  // -------------------------------------------------------------------------

  async inferEdge(
    input: EdgeInferenceInput,
  ): Promise<AIProviderResult<EdgeInferenceOutput>> {
    const { stablePrefix, variableBlock } = buildEdgeInferencePromptParts({
      source_title: input.source_node.title,
      source_summary: input.source_node.summary,
      candidates: input.candidates,
      workspace_context: input.workspace_context,
    });
    // Hash tracks the full prompt so duplicate-detection and telemetry match
    // what the old single-string form produced.
    const fullPrompt = `${stablePrefix}\n\n${variableBlock}`;

    // inferEdge runs on Haiku — a structured binary-plus-enum verdict per
    // candidate, which Haiku handles at Sonnet-parity in offline comparison
    // (100% cross-model agreement on related-flag, ~100% on edge_type in the
    // haiku-vs-sonnet-inferedge.ts test). 3× cheaper, and this fires on every
    // new node so it dominates inferEdge cost. Extract stays on Sonnet
    // because soft_links quality diverged there.
    const inferModel = AI_MODELS.CLAUDE_HAIKU;
    const run = baseRun("infer_edge", INFER_EDGE_PROMPT_VERSION, fullPrompt, inferModel);
    const start = Date.now();

    const maxTokens = Math.min(4096, 256 + input.candidates.length * 180);

    const response = await this.client.messages.create({
      model: inferModel,
      max_tokens: maxTokens,
      ...claudeRequestTuning(inferModel, AI_TEMPERATURE.EDGE_INFERENCE),
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      // Split into two user content blocks so the stable prefix (rules +
      // hoisted workspace context) can hit the prompt cache on repeated calls.
      // Note: cache won't fire at current workspace sizes on Haiku either
      // (its floor is 2048 tokens), but the marker is cheap to leave in
      // place for when larger workspaces push the prefix past the floor.
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: stablePrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: variableBlock },
          ],
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const u = readUsage(response.usage);
    const inputTokens = u.totalInput;
    const outputTokens = u.output;
    const latencyMs = Date.now() - start;
    const estimatedCost = claudeCost("haiku", u);

    let output: EdgeInferenceOutput;
    try {
      const parsed = JSON.parse(extractJson(text));
      output = validateEdgeInferenceOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Edge inference output was malformed",
        rawOutput: text,
        runType: "infer_edge",
        promptVersion: INFER_EDGE_PROMPT_VERSION,
        modelName: inferModel,
        inputHash: run.input_hash,
        outputHash: shortHash(text),
        inputTokens,
        outputTokens,
        latencyMs,
        estimatedCost,
        cause: error,
      });
    }

    return {
      output,
      run: {
        ...run,
        output_hash: shortHash(text),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latencyMs,
        estimated_cost: estimatedCost,
      },
    };
  }

  // -------------------------------------------------------------------------
  // answerAssistant
  // -------------------------------------------------------------------------

  async answerAssistant(
    input: AssistantInput,
  ): Promise<AIProviderResult<AssistantOutput>> {
    const systemPrompt = buildAssistantSystemPrompt(input.mode ?? "explain");
    const userPrompt = buildAssistantUserPrompt(input);

    const run = baseRun("assistant", ASSISTANT_PROMPT_VERSION, userPrompt, this.modelName);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 2048,
      ...claudeRequestTuning(this.modelName, AI_TEMPERATURE.ASSISTANT),
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const u = readUsage(response.usage);
    const inputTokens = u.totalInput;
    const outputTokens = u.output;

    return {
      output: { answer: text, prompt_version: ASSISTANT_PROMPT_VERSION },
      run: {
        ...run,
        output_hash: shortHash(text),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: Date.now() - start,
        estimated_cost: claudeCost("sonnet", u),
      },
    };
  }

  // -------------------------------------------------------------------------
  // buildPlan
  // -------------------------------------------------------------------------

  async buildPlan(input: PlanInput): Promise<AIProviderResult<PlanOutput>> {
    const totalMinutes =
      input.planning_window === "1h"
        ? 60
        : input.planning_window === "2h"
          ? 120
          : input.planning_window === "day"
            ? 480
            : input.planning_window === "custom"
              ? Math.max(15, Math.min(600, Math.round(input.custom_minutes ?? 60)))
              : 60;

    const prompt = buildPlanPrompt({
      planning_window: input.planning_window,
      total_minutes: totalMinutes,
      candidate_nodes: input.candidate_nodes,
      workspace_context: input.workspace_context,
    });

    // Planner runs on Sonnet: the strict time-block JSON + realistic per-task
    // durations need it — Haiku produced malformed output (the user-facing
    // "AI returned an invalid response") and weak durations. Planning is a
    // low-volume call (a few per day), so the cost is negligible. One auto-retry
    // absorbs a rare JSON hiccup so the user never sees a malformed-response error.
    const plannerModel = AI_MODELS.CLAUDE_SONNET;
    const run = baseRun("plan", PLAN_PROMPT_VERSION, prompt, plannerModel);
    const start = Date.now();

    let text = "{}";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    let output: PlanOutput | null = null;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.client.messages.create({
        model: plannerModel,
        max_tokens: 4096,
        ...claudeRequestTuning(plannerModel, AI_TEMPERATURE.PLANNER),
        system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
        messages: [{ role: "user", content: prompt }],
      });
      text = response.content[0].type === "text" ? response.content[0].text : "{}";
      const u = readUsage(response.usage);
      inputTokens += u.input;
      outputTokens += u.output;
      cacheWrite += u.cacheWrite;
      cacheRead += u.cacheRead;
      try {
        const parsed = JSON.parse(extractJson(text));
        output = validatePlanOutput(parsed, totalMinutes);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    const latencyMs = Date.now() - start;
    const estimatedCost = claudeCost("sonnet", { input: inputTokens, cacheWrite, cacheRead, output: outputTokens });
    inputTokens = inputTokens + cacheWrite + cacheRead; // store total billed input

    if (!output) {
      throw malformedResponse({
        message: lastError instanceof Error ? lastError.message : "Plan output was malformed",
        rawOutput: text,
        runType: "plan",
        promptVersion: PLAN_PROMPT_VERSION,
        modelName: plannerModel,
        inputHash: run.input_hash,
        outputHash: shortHash(text),
        inputTokens,
        outputTokens,
        latencyMs,
        estimatedCost,
        cause: lastError,
      });
    }

    return {
      output,
      run: {
        ...run,
        output_hash: shortHash(text),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latencyMs,
        estimated_cost: estimatedCost,
      },
    };
  }

  // -------------------------------------------------------------------------
  // checkMerge
  // -------------------------------------------------------------------------

  async checkMerge(input: MergeCheckInput): Promise<AIProviderResult<MergeCheckOutput>> {
    const prompt = buildMergeCheckPrompt({
      new_title: input.new_node.title,
      new_summary: input.new_node.summary,
      new_type: input.new_node.node_type,
      existing_title: input.existing_node.title,
      existing_summary: input.existing_node.summary,
      existing_type: input.existing_node.node_type,
      similarity: input.similarity,
    });

    // mergeCheck runs on Haiku — binary same_entity verdict + confidence + one
    // sentence of reasoning. Sonnet/Haiku matched 7/7 with 100% agreement on
    // the haiku-vs-sonnet-mergecheck.ts comparison (covered the rubric trap
    // "Financial Independence vs SaaS Revenue", cross-type goal-vs-habit,
    // task-vs-parent granularity, and near-synonyms). 3× cheaper per call.
    const mergeModel = AI_MODELS.CLAUDE_HAIKU;
    const run = baseRun("merge_check", MERGE_CHECK_PROMPT_VERSION, prompt, mergeModel);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: mergeModel,
      max_tokens: 256,
      ...claudeRequestTuning(mergeModel, AI_TEMPERATURE.MERGE_CHECK),
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const u = readUsage(response.usage);
    const inputTokens = u.totalInput;
    const outputTokens = u.output;
    const latencyMs = Date.now() - start;
    const estimatedCost = claudeCost("haiku", u);

    let output: MergeCheckOutput;
    try {
      const parsed = JSON.parse(extractJson(text));
      output = validateMergeCheckOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Merge check output was malformed",
        rawOutput: text,
        runType: "merge_check",
        promptVersion: MERGE_CHECK_PROMPT_VERSION,
        modelName: mergeModel,
        inputHash: run.input_hash,
        outputHash: shortHash(text),
        inputTokens,
        outputTokens,
        latencyMs,
        estimatedCost,
        cause: error,
      });
    }

    return {
      output,
      run: {
        ...run,
        output_hash: shortHash(text),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: latencyMs,
        estimated_cost: estimatedCost,
      },
    };
  }
}
