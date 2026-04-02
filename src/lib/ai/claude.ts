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
  AIRun,
} from "@/types/ai";
import { AI_MODELS, AI_TEMPERATURE, AI_COST_PER_1M_TOKENS } from "./config";
import {
  validateExtractionOutput,
  validateEdgeInferenceOutput,
  validatePlanOutput,
} from "./validation";
import { buildExtractionPrompt, EXTRACT_PROMPT_VERSION } from "./prompts/extract";
import { buildEdgeInferencePrompt, INFER_EDGE_PROMPT_VERSION } from "./prompts/infer-edge";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "./prompts/assistant";
import { buildPlanPrompt, PLAN_PROMPT_VERSION } from "./prompts/plan";

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
): Omit<AIRun, "id" | "created_at"> {
  return {
    run_type,
    provider: "claude",
    model_name: AI_MODELS.CLAUDE_SONNET,
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

// ---------------------------------------------------------------------------
// ClaudeProvider — LLM methods only
// ---------------------------------------------------------------------------

export class ClaudeProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  // -------------------------------------------------------------------------
  // extractNodes
  // -------------------------------------------------------------------------

  async extractNodes(
    input: ExtractionInput,
  ): Promise<AIProviderResult<ExtractionOutput>> {
    const prompt = buildExtractionPrompt(input);
    const run = baseRun("extract", EXTRACT_PROMPT_VERSION, prompt);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
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

    const parsed = JSON.parse(extractJson(text));
    const output = validateExtractionOutput(parsed);

    return {
      output,
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

    const run = baseRun("infer_edge", INFER_EDGE_PROMPT_VERSION, prompt);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 512,
      temperature: AI_TEMPERATURE.EDGE_INFERENCE,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    const parsed = JSON.parse(extractJson(text));
    const output = validateEdgeInferenceOutput(parsed);

    return {
      output,
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
  // answerAssistant
  // -------------------------------------------------------------------------

  async answerAssistant(
    input: AssistantInput,
  ): Promise<AIProviderResult<AssistantOutput>> {
    const systemPrompt = buildAssistantSystemPrompt(input.mode ?? "explain");
    const userPrompt = buildAssistantUserPrompt(input);

    const run = baseRun("assistant", ASSISTANT_PROMPT_VERSION, userPrompt);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
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

    const run = baseRun("plan", PLAN_PROMPT_VERSION, prompt);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 4096,
      temperature: AI_TEMPERATURE.PLANNER,
      system: "You always respond with valid JSON only. No markdown code blocks, no extra text — just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    const parsed = JSON.parse(extractJson(text));
    const output = validatePlanOutput(parsed);

    return {
      output,
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
}
