// Gemini provider implementation.
// Implements the AIProvider interface using @google/generative-ai.
// Never import this directly in route handlers — use getProvider() from index.ts.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { createHash } from "crypto";

import type { AIProvider, AIProviderResult } from "./provider";
import type {
  ExtractionInput,
  ExtractionOutput,
  EmbeddingInput,
  EmbeddingOutput,
  RerankInput,
  RerankOutput,
  EdgeInferenceInput,
  EdgeInferenceOutput,
  AssistantInput,
  AssistantOutput,
  PlanInput,
  PlanOutput,
  AIRun,
} from "@/types/ai";
import {
  AI_MODELS,
  AI_TEMPERATURE,
  AI_COST_PER_1M_TOKENS,
} from "./config";
import { MalformedAIResponseError } from "./errors";
import {
  validateExtractionOutput,
  validateEdgeInferenceOutput,
  validatePlanOutput,
  validateEmbeddingOutput,
  validateRerankOutput,
} from "./validation";
import {
  buildExtractionPrompt,
  EXTRACT_PROMPT_VERSION,
} from "./prompts/extract";
import {
  buildEdgeInferencePrompt,
  INFER_EDGE_PROMPT_VERSION,
} from "./prompts/infer-edge";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "./prompts/assistant";
import {
  buildPlanPrompt,
  PLAN_PROMPT_VERSION,
} from "./prompts/plan";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.GEMINI_FLASH_INPUT +
    (outputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.GEMINI_FLASH_OUTPUT
  );
}

function baseRun(
  run_type: AIRun["run_type"],
  prompt_version: string,
  inputText: string,
  model_name: string
): Omit<AIRun, "id" | "created_at"> {
  return {
    run_type,
    provider: "gemini",
    model_name,
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

function malformedResponse(params: {
  message: string;
  rawOutput: string;
  runType: AIRun["run_type"];
  modelName: string;
  promptVersion: string;
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
    provider: "gemini",
    modelName: params.modelName,
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
// GeminiProvider
// ---------------------------------------------------------------------------

export class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  // -------------------------------------------------------------------------
  // extractNodes
  // -------------------------------------------------------------------------

  async extractNodes(
    input: ExtractionInput
  ): Promise<AIProviderResult<ExtractionOutput>> {
    const prompt = buildExtractionPrompt(input);
    const run = baseRun("extract", EXTRACT_PROMPT_VERSION, prompt, AI_MODELS.GEMINI_FAST);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_FAST,
      generationConfig: {
        temperature: AI_TEMPERATURE.EXTRACTION,
        responseMimeType: "application/json",
      },
    });

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

    let output: ExtractionOutput;
    try {
      const parsed = JSON.parse(text);
      output = validateExtractionOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Extraction output was malformed",
        rawOutput: text,
        runType: "extract",
        modelName: AI_MODELS.GEMINI_FAST,
        promptVersion: EXTRACT_PROMPT_VERSION,
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
  // generateEmbedding
  // -------------------------------------------------------------------------

  async generateEmbedding(
    input: EmbeddingInput
  ): Promise<AIProviderResult<EmbeddingOutput>> {
    const run: Omit<AIRun, "id" | "created_at"> = {
      run_type: "embed",
      provider: "gemini",
      model_name: AI_MODELS.GEMINI_EMBEDDING,
      prompt_version: "embed-v1",
      input_hash: shortHash(input.text),
      output_hash: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      estimated_cost: null,
      status: "success",
      error_text: null,
    };

    const start = Date.now();
    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_EMBEDDING,
    });

    const result = await model.embedContent(input.text);
    const embedding = result.embedding.values;

    const tokenCount = embedding.length > 0 ? null : null; // Gemini embedding API doesn't return token count

    const costPerM = AI_COST_PER_1M_TOKENS.GEMINI_EMBEDDING_INPUT;
    const estimated_cost = costPerM / 1_000_000; // treat as ~1 token unit per call
    const latencyMs = Date.now() - start;

    let output: EmbeddingOutput;
    try {
      output = validateEmbeddingOutput({
        embedding,
        token_count: tokenCount,
      });
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Embedding output was malformed",
        rawOutput: JSON.stringify({
          embedding,
          token_count: tokenCount,
        }),
        runType: "embed",
        modelName: AI_MODELS.GEMINI_EMBEDDING,
        promptVersion: "embed-v1",
        inputHash: run.input_hash,
        outputHash: shortHash(embedding.slice(0, 8).join(",")),
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCost: estimated_cost,
        cause: error,
      });
    }

    return {
      output,
      run: {
        ...run,
        output_hash: shortHash(embedding.slice(0, 8).join(",")),
        latency_ms: latencyMs,
        estimated_cost,
      },
    };
  }

  // -------------------------------------------------------------------------
  // rerankCandidates (fallback — prefer CohereRerankProvider)
  // Scores candidates by simple string overlap as a degraded fallback.
  // -------------------------------------------------------------------------

  async rerankCandidates(
    input: RerankInput
  ): Promise<AIProviderResult<RerankOutput>> {
    const run: Omit<AIRun, "id" | "created_at"> = {
      run_type: "rerank",
      provider: "gemini-fallback",
      model_name: "lexical",
      prompt_version: "rerank-fallback-v1",
      input_hash: shortHash(input.query),
      output_hash: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      estimated_cost: 0,
      status: "success",
      error_text: null,
    };

    const start = Date.now();
    const queryTerms = input.query.toLowerCase().split(/\s+/);

    const ranked = input.candidates
      .map(({ id, text }) => {
        const lower = text.toLowerCase();
        const score =
          queryTerms.filter((t) => lower.includes(t)).length /
          Math.max(queryTerms.length, 1);
        return { id, score };
      })
      .sort((a, b) => b.score - a.score);
    const latencyMs = Date.now() - start;

    let output: RerankOutput;
    try {
      output = validateRerankOutput({ ranked });
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Rerank output was malformed",
        rawOutput: JSON.stringify({ ranked }),
        runType: "rerank",
        modelName: "lexical",
        promptVersion: "rerank-fallback-v1",
        inputHash: run.input_hash,
        outputHash: shortHash(ranked.map((r) => r.id).join(",")),
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCost: 0,
        cause: error,
      });
    }

    return {
      output,
      run: {
        ...run,
        output_hash: shortHash(ranked.map((r) => r.id).join(",")),
        latency_ms: latencyMs,
      },
    };
  }

  // -------------------------------------------------------------------------
  // inferEdge
  // -------------------------------------------------------------------------

  async inferEdge(
    input: EdgeInferenceInput
  ): Promise<AIProviderResult<EdgeInferenceOutput>> {
    const prompt = buildEdgeInferencePrompt({
      source_title: input.source_node.title,
      source_summary: input.source_node.summary,
      target_title: input.target_node.title,
      target_summary: input.target_node.summary,
      workspace_context: input.workspace_context,
    });

    const run = baseRun("infer_edge", INFER_EDGE_PROMPT_VERSION, prompt, AI_MODELS.GEMINI_PRO);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_PRO,
      generationConfig: {
        temperature: AI_TEMPERATURE.EDGE_INFERENCE,
        responseMimeType: "application/json",
      },
    });

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

    let output: EdgeInferenceOutput;
    try {
      const parsed = JSON.parse(text);
      output = validateEdgeInferenceOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Edge inference output was malformed",
        rawOutput: text,
        runType: "infer_edge",
        modelName: AI_MODELS.GEMINI_PRO,
        promptVersion: INFER_EDGE_PROMPT_VERSION,
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
    input: AssistantInput
  ): Promise<AIProviderResult<AssistantOutput>> {
    const systemPrompt = buildAssistantSystemPrompt();
    const userPrompt = buildAssistantUserPrompt(input);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const run = baseRun("assistant", ASSISTANT_PROMPT_VERSION, fullPrompt, AI_MODELS.GEMINI_FAST);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_FAST,
      generationConfig: {
        temperature: AI_TEMPERATURE.ASSISTANT,
      },
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(userPrompt);
    const response = result.response;
    const answer = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    return {
      output: { answer, prompt_version: ASSISTANT_PROMPT_VERSION },
      run: {
        ...run,
        output_hash: shortHash(answer),
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
    const windowMinutes: Record<string, number> = {
      "1h": 60,
      "2h": 120,
      day: 480,
      custom: 60,
    };
    const totalMinutes = windowMinutes[input.planning_window] ?? 60;

    const prompt = buildPlanPrompt({
      planning_window: input.planning_window,
      total_minutes: totalMinutes,
      candidate_nodes: input.candidate_nodes,
      workspace_context: input.workspace_context,
    });

    const run = baseRun("plan", PLAN_PROMPT_VERSION, prompt, AI_MODELS.GEMINI_FAST);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_FAST,
      generationConfig: {
        temperature: AI_TEMPERATURE.PLANNER,
        responseMimeType: "application/json",
      },
    });

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

    let output: PlanOutput;
    try {
      const parsed = JSON.parse(text);
      output = validatePlanOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message: error instanceof Error ? error.message : "Plan output was malformed",
        rawOutput: text,
        runType: "plan",
        modelName: AI_MODELS.GEMINI_FAST,
        promptVersion: PLAN_PROMPT_VERSION,
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

  // checkMerge is a Claude-only task — Gemini provider does not implement it.
  // In practice the registered hybrid provider always routes this to Claude.
  async checkMerge(): Promise<never> {
    throw new Error("checkMerge is not supported by GeminiProvider. Use ClaudeProvider.");
  }
}
