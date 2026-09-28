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
import { AI_MODELS, AI_TEMPERATURE, claudeRequestTuning } from "./config";
import { MalformedAIResponseError } from "./errors";
import {
  addUsage,
  claudeCostUSD,
  EMPTY_USAGE,
  readClaudeUsage,
  totalInputTokens,
  type ClaudeUsage,
} from "./usage";
import {
  validateExtractionOutput,
  validateEdgeInferenceOutput,
  validatePlanOutput,
  validateMergeCheckOutput,
} from "./validation";
import { buildExtractionPromptParts, EXTRACT_PROMPT_VERSION } from "./prompts/extract";
import { buildLightExtractionPromptParts, EXTRACT_LIGHT_PROMPT_VERSION } from "./prompts/extract-light";
import {
  buildEdgeInferencePromptParts,
  INFER_EDGE_PROMPT_VERSION,
} from "./prompts/infer-edge";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "./prompts/assistant";
import { buildPlanPrompt, PLAN_OUTPUT_SCHEMA, PLAN_PROMPT_VERSION } from "./prompts/plan";
import { buildMergeCheckPrompt, MERGE_CHECK_PROMPT_VERSION } from "./prompts/merge-check";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Every usage bucket (fresh / cache write 5m·1h / cache read / output) priced
// at its real rate — see usage.ts. totalInput is what ai_runs stores.
function readUsage(u: ClaudeUsage) {
  const t = readClaudeUsage(u);
  return { ...t, totalInput: totalInputTokens(t) };
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
    // Short update dumps take the light path: the slim rubric
    // (prompts/extract-light.ts), still on Sonnet — Haiku was tested on it and
    // wrongly completed whole projects from partial progress and invented
    // details. Same model, ~1/4 of the input → ~3× cheaper per update.
    const light = input.variant === "light";
    const model = this.modelName;
    const promptVersion = light ? EXTRACT_LIGHT_PROMPT_VERSION : EXTRACT_PROMPT_VERSION;
    const { rubricBlock, variableBlock } = light
      ? buildLightExtractionPromptParts(input)
      : buildExtractionPromptParts(input);
    // Hash the full prompt so telemetry/input-hash matches the concatenated form.
    const fullPrompt = `${rubricBlock}\n\n${variableBlock}`;
    const run = baseRun("extract", promptVersion, fullPrompt, model);
    const start = Date.now();

    // The rubric (~9K tokens) is byte-identical for every dump from every
    // user and the prompt cache is shared org-wide, so whether to cache it is
    // a traffic decision made by the caller (extraction.ts).
    const rubricContent = input.rubric_cache_ttl && !light
      ? {
          type: "text" as const,
          text: rubricBlock,
          cache_control: { type: "ephemeral" as const, ttl: input.rubric_cache_ttl },
        }
      : { type: "text" as const, text: rubricBlock };

    const response = await this.client.messages.create(
      {
        model,
        // Sonnet 5's tokenizer emits ~30% more tokens than 4.6 for the same JSON,
        // and multi-domain dumps now yield larger extractions (18-20 nodes). 8192
        // brushed the cap and truncated → stop_reason "max_tokens" → invalid JSON
        // that reads as a failed extraction. 16000 is the safe non-streaming
        // ceiling (stays under the SDK HTTP timeout) and is a pure guard — the
        // model still stops at end_turn once the JSON is complete.
        max_tokens: 16000,
        ...claudeRequestTuning(model, AI_TEMPERATURE.EXTRACTION),
        system: "You always respond with valid JSON only. No markdown code blocks, no extra text, no explanation — just the raw JSON object.",
        messages: [
          {
            role: "user",
            content: [rubricContent, { type: "text", text: variableBlock }],
          },
        ],
      },
      // Client cancel → stop the (expensive) Sonnet call instead of paying for
      // output nobody will see.
      input.signal ? { signal: input.signal } : undefined,
    );

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
    const estimatedCost = claudeCostUSD(model, u);

    let output: ExtractionOutput;
    try {
      const parsed = JSON.parse(extractJson(text));
      output = validateExtractionOutput(parsed, {
        workspace_id: input.workspace_id,
        user_id: input.user_id,
        prompt_version: promptVersion,
      });
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Extraction output was malformed",
        rawOutput: text,
        runType: "extract",
        promptVersion,
        modelName: model,
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
    const estimatedCost = claudeCostUSD(inferModel, u);

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
      // Headroom for Sonnet 5's tokenizer (~30% more tokens for the same text).
      // A pure truncation guard — the model stops at end_turn when done.
      max_tokens: 3072,
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
        estimated_cost: claudeCostUSD(this.modelName, u),
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

    // Short sessions (≤3h) plan on Haiku with the JSON schema ENFORCED — the
    // schema removes the malformed output that originally ruled Haiku out, and
    // in the 2026-09-28 eval its 2h plans matched Sonnet's at ~40% of the cost.
    // Full days stay on Sonnet: Haiku left ~2.5h of an 8h day empty and dropped
    // every habit. If the Haiku attempt still fails, the retry uses Sonnet.
    let plannerModel: string =
      totalMinutes <= 180 ? AI_MODELS.CLAUDE_HAIKU : AI_MODELS.CLAUDE_SONNET;
    const run = baseRun("plan", PLAN_PROMPT_VERSION, prompt, plannerModel);
    const start = Date.now();

    let text = "{}";
    let usage = EMPTY_USAGE;
    let estimatedCost = 0; // priced per attempt — a retry may switch model
    let output: PlanOutput | null = null;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) plannerModel = AI_MODELS.CLAUDE_SONNET;
      const enforceSchema = plannerModel === AI_MODELS.CLAUDE_HAIKU;
      const response = await this.client.messages.create({
        model: plannerModel,
        ...(enforceSchema
          ? { output_config: { format: { type: "json_schema" as const, schema: PLAN_OUTPUT_SCHEMA } } }
          : {}),
        // Headroom for Sonnet 5's tokenizer (~30% more tokens for the same
        // text) — a fuller day-plan JSON could otherwise brush the old cap.
        // Pure truncation guard; the model stops at end_turn when done.
        max_tokens: 6144,
        ...claudeRequestTuning(plannerModel, AI_TEMPERATURE.PLANNER),
        system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
        messages: [{ role: "user", content: prompt }],
      });
      text = response.content[0].type === "text" ? response.content[0].text : "{}";
      const attemptUsage = readClaudeUsage(response.usage);
      usage = addUsage(usage, attemptUsage);
      estimatedCost += claudeCostUSD(plannerModel, attemptUsage);
      try {
        const parsed = JSON.parse(extractJson(text));
        output = validatePlanOutput(parsed, totalMinutes);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    const latencyMs = Date.now() - start;
    const inputTokens = totalInputTokens(usage);
    const outputTokens = usage.output;

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
        model_name: plannerModel,
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
    const estimatedCost = claudeCostUSD(mergeModel, u);

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
