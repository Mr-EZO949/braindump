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
  IntentInput,
  IntentOutput,
  AIRun,
} from "@/types/ai";
import { AI_MODELS, AI_TEMPERATURE, AI_COST_PER_1M_TOKENS } from "./config";
import { MalformedAIResponseError } from "./errors";
import {
  validateExtractionOutput,
  validateEdgeInferenceOutput,
  validatePlanOutput,
  validateMergeCheckOutput,
  validateIntentOutput,
} from "./validation";
import { buildExtractionPrompt, EXTRACT_PROMPT_VERSION } from "./prompts/extract";
import { buildEdgeInferencePrompt, INFER_EDGE_PROMPT_VERSION } from "./prompts/infer-edge";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "./prompts/assistant";
import { buildPlanPrompt, PLAN_PROMPT_VERSION } from "./prompts/plan";
import { buildMergeCheckPrompt, MERGE_CHECK_PROMPT_VERSION } from "./prompts/merge-check";
import { buildIntentPrompt, INTENT_PROMPT_VERSION } from "./prompts/intent";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_INPUT +
    (outputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_OUTPUT
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
    const prompt = buildExtractionPrompt(input);
    const run = baseRun("extract", EXTRACT_PROMPT_VERSION, prompt, this.modelName);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 8192,
      temperature: AI_TEMPERATURE.EXTRACTION,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text, no explanation — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "max_tokens") {
      throw new Error(
        "Extraction output was truncated (max_tokens reached). Input may be too dense — try a shorter brain dump.",
      );
    }

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

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
    const prompt = buildEdgeInferencePrompt({
      source_title: input.source_node.title,
      source_summary: input.source_node.summary,
      target_title: input.target_node.title,
      target_summary: input.target_node.summary,
      workspace_context: input.workspace_context,
    });

    const run = baseRun("infer_edge", INFER_EDGE_PROMPT_VERSION, prompt, this.modelName);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 512,
      temperature: AI_TEMPERATURE.EDGE_INFERENCE,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

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
      temperature: AI_TEMPERATURE.ASSISTANT,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    return {
      output: { answer: text, prompt_version: ASSISTANT_PROMPT_VERSION },
      run: {
        ...run,
        output_hash: shortHash(text),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        latency_ms: Date.now() - start,
        estimated_cost: estimateCost(inputTokens, outputTokens),
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
            : 60;

    const prompt = buildPlanPrompt({
      planning_window: input.planning_window,
      total_minutes: totalMinutes,
      candidate_nodes: input.candidate_nodes,
      workspace_context: input.workspace_context,
    });

    const run = baseRun("plan", PLAN_PROMPT_VERSION, prompt, this.modelName);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 4096,
      temperature: AI_TEMPERATURE.PLANNER,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

    let output: PlanOutput;
    try {
      const parsed = JSON.parse(extractJson(text));
      output = validatePlanOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message: error instanceof Error ? error.message : "Plan output was malformed",
        rawOutput: text,
        runType: "plan",
        promptVersion: PLAN_PROMPT_VERSION,
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
  // checkMerge
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // classifyIntent
  // -------------------------------------------------------------------------

  async classifyIntent(
    input: IntentInput,
  ): Promise<AIProviderResult<IntentOutput>> {
    const prompt = buildIntentPrompt(input);
    const run = baseRun("intent", INTENT_PROMPT_VERSION, prompt, this.modelName);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 256,
      temperature: 0.1,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

    let output: IntentOutput;
    try {
      const parsed = JSON.parse(extractJson(text));
      output = validateIntentOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Intent output was malformed",
        rawOutput: text,
        runType: "intent",
        promptVersion: INTENT_PROMPT_VERSION,
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

    const run = baseRun("merge_check", MERGE_CHECK_PROMPT_VERSION, prompt, this.modelName);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: 256,
      temperature: AI_TEMPERATURE.MERGE_CHECK,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

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
}
