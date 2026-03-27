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
import {
  validateExtractionOutput,
  validateEdgeInferenceOutput,
  validatePlanOutput,
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
  inputText: string
): Omit<AIRun, "id" | "created_at"> {
  return {
    run_type,
    provider: "gemini",
    model_name: AI_MODELS.GEMINI_LLM,
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
    const run = baseRun("extract", EXTRACT_PROMPT_VERSION, prompt);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_LLM,
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

    const parsed = JSON.parse(text);
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

    return {
      output: { embedding, token_count: tokenCount },
      run: {
        ...run,
        output_hash: shortHash(embedding.slice(0, 8).join(",")),
        latency_ms: Date.now() - start,
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

    return {
      output: { ranked },
      run: {
        ...run,
        output_hash: shortHash(ranked.map((r) => r.id).join(",")),
        latency_ms: Date.now() - start,
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

    const run = baseRun("infer_edge", INFER_EDGE_PROMPT_VERSION, prompt);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_LLM,
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

    const parsed = JSON.parse(text);
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
    input: AssistantInput
  ): Promise<AIProviderResult<AssistantOutput>> {
    const systemPrompt = buildAssistantSystemPrompt();
    const userPrompt = buildAssistantUserPrompt(input);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const run = baseRun("assistant", ASSISTANT_PROMPT_VERSION, fullPrompt);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_LLM,
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

    const run = baseRun("plan", PLAN_PROMPT_VERSION, prompt);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_LLM,
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

    const parsed = JSON.parse(text);
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
