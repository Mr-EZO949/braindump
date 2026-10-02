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
  MergeCheckInput,
  MergeCheckOutput,
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
  validateMergeCheckOutput,
} from "./validation";
import {
  buildExtractionPromptParts,
  EXTRACT_PROMPT_VERSION,
} from "./prompts/extract";
import {
  buildEdgeInferencePromptParts,
  INFER_EDGE_PROMPT_VERSION,
} from "./prompts/infer-edge";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "./prompts/assistant";
import {
  buildPlanPromptParts,
  PLAN_PROMPT_VERSION,
} from "./prompts/plan";
import {
  buildMergeCheckPromptParts,
  MERGE_CHECK_PROMPT_VERSION,
} from "./prompts/merge-check";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function estimateProCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.GEMINI_PRO_INPUT +
    (outputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.GEMINI_PRO_OUTPUT
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
    const { rubricBlock, variableBlock } = buildExtractionPromptParts(input);
    // Hash the concatenated form so telemetry/input_hash is stable across
    // the split vs. single-string representations.
    const fullPrompt = `${rubricBlock}\n\n${variableBlock}`;
    const run = baseRun("extract", EXTRACT_PROMPT_VERSION, fullPrompt, AI_MODELS.GEMINI_PRO);
    const start = Date.now();

    // Put the stable rubric in systemInstruction so Gemini 2.5's implicit
    // cache can reuse it across calls. Only variable per-request data
    // (session ids, workspace context, brain dump) goes in the user turn.
    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_PRO,
      generationConfig: {
        temperature: AI_TEMPERATURE.EXTRACTION,
        responseMimeType: "application/json",
      },
      systemInstruction: rubricBlock,
    });

    const result = await model.generateContent(variableBlock);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateProCost(inputTokens, outputTokens);

    let output: ExtractionOutput;
    try {
      const parsed = JSON.parse(text);
      output = validateExtractionOutput(parsed, {
        workspace_id: input.workspace_id,
        user_id: input.user_id,
        prompt_version: EXTRACT_PROMPT_VERSION,
        today: input.today,
      });
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Extraction output was malformed",
        rawOutput: text,
        runType: "extract",
        modelName: AI_MODELS.GEMINI_PRO,
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
    const estimated_cost = (costPerM / 1_000_000) * Math.ceil(input.text.length / 4);
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
  // generateEmbeddings — several texts in ONE API call (batchEmbedContents).
  // Ingestion embeds a dump's segments (retrieval) and every proposal (dedup);
  // batching turns ~20 round-trips into one.
  // -------------------------------------------------------------------------

  async generateEmbeddings(input: {
    texts: string[];
  }): Promise<AIProviderResult<{ embeddings: number[][] }>> {
    const joined = input.texts.join("\u241E");
    const run: Omit<AIRun, "id" | "created_at"> = {
      run_type: "embed",
      provider: "gemini",
      model_name: AI_MODELS.GEMINI_EMBEDDING,
      prompt_version: "embed-batch-v1",
      input_hash: shortHash(joined),
      output_hash: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      estimated_cost: null,
      status: "success",
      error_text: null,
    };
    if (input.texts.length === 0) {
      return { output: { embeddings: [] }, run: { ...run, latency_ms: 0, estimated_cost: 0 } };
    }

    const start = Date.now();
    const model = this.genAI.getGenerativeModel({ model: AI_MODELS.GEMINI_EMBEDDING });
    const result = await model.batchEmbedContents({
      requests: input.texts.map((text) => ({
        content: { role: "user", parts: [{ text }] },
      })),
    });
    const embeddings = (result.embeddings ?? []).map((e) => e.values ?? []);
    const latencyMs = Date.now() - start;

    if (
      embeddings.length !== input.texts.length ||
      embeddings.some((v) => !Array.isArray(v) || v.length === 0)
    ) {
      throw malformedResponse({
        message: `Batch embedding returned ${embeddings.length} vectors for ${input.texts.length} texts`,
        rawOutput: JSON.stringify({ count: embeddings.length }),
        runType: "embed",
        modelName: AI_MODELS.GEMINI_EMBEDDING,
        promptVersion: "embed-batch-v1",
        inputHash: run.input_hash,
        outputHash: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCost: null,
        cause: null,
      });
    }

    const costPerM = AI_COST_PER_1M_TOKENS.GEMINI_EMBEDDING_INPUT;
    return {
      output: { embeddings },
      run: {
        ...run,
        output_hash: shortHash(embeddings.map((v) => v.slice(0, 2).join(",")).join("|")),
        latency_ms: latencyMs,
        estimated_cost: (costPerM / 1_000_000) * Math.ceil(joined.length / 4),
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
    const { stablePrefix, variableBlock } = buildEdgeInferencePromptParts({
      source_title: input.source_node.title,
      source_summary: input.source_node.summary,
      source_node_type: input.source_node.node_type,
      source_has_parent: input.source_node.has_parent,
      candidates: input.candidates,
      workspace_context: input.workspace_context,
    });
    const fullPrompt = `${stablePrefix}\n\n${variableBlock}`;

    const run = baseRun("infer_edge", INFER_EDGE_PROMPT_VERSION, fullPrompt, AI_MODELS.GEMINI_PRO);
    const start = Date.now();

    // Stable prefix (rules + hoisted workspace context) → systemInstruction
    // for implicit caching. A full edge-inference batch fires one call per
    // source node, all sharing the same prefix when the caller hoists
    // workspace_context once per batch.
    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_PRO,
      generationConfig: {
        temperature: AI_TEMPERATURE.EDGE_INFERENCE,
        responseMimeType: "application/json",
      },
      systemInstruction: stablePrefix,
    });

    const result = await model.generateContent(variableBlock);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateProCost(inputTokens, outputTokens);

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

    const run = baseRun("assistant", ASSISTANT_PROMPT_VERSION, fullPrompt, AI_MODELS.GEMINI_PRO);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_PRO,
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
        estimated_cost: estimateProCost(inputTokens, outputTokens),
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
    };
    const totalMinutes =
      input.planning_window === "custom"
        ? Math.max(15, Math.min(600, Math.round(input.custom_minutes ?? 60)))
        : windowMinutes[input.planning_window] ?? 60;
    // A class inside the session: plan the free time only (see claude.ts).
    const planMinutes = input.busy ? Math.max(15, input.busy.free_minutes) : totalMinutes;

    const { rubricBlock, variableBlock } = buildPlanPromptParts({
      planning_window: input.planning_window,
      total_minutes: planMinutes,
      candidate_nodes: input.candidate_nodes,
      workspace_context: input.workspace_context,
      busy_lines: input.busy?.lines,
    });
    const fullPrompt = `${rubricBlock}\n\n${variableBlock}`;

    const run = baseRun("plan", PLAN_PROMPT_VERSION, fullPrompt, AI_MODELS.GEMINI_PRO);
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_PRO,
      generationConfig: {
        temperature: AI_TEMPERATURE.PLANNER,
        responseMimeType: "application/json",
      },
      systemInstruction: rubricBlock,
    });

    const result = await model.generateContent(variableBlock);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateProCost(inputTokens, outputTokens);

    let output: PlanOutput;
    try {
      const parsed = JSON.parse(text);
      output = validatePlanOutput(parsed, planMinutes);
    } catch (error) {
      throw malformedResponse({
        message: error instanceof Error ? error.message : "Plan output was malformed",
        rawOutput: text,
        runType: "plan",
        modelName: AI_MODELS.GEMINI_PRO,
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

  async checkMerge(
    input: MergeCheckInput,
  ): Promise<AIProviderResult<MergeCheckOutput>> {
    const { rubricBlock, variableBlock } = buildMergeCheckPromptParts({
      new_title: input.new_node.title,
      new_summary: input.new_node.summary,
      new_type: input.new_node.node_type,
      existing_title: input.existing_node.title,
      existing_summary: input.existing_node.summary,
      existing_type: input.existing_node.node_type,
      similarity: input.similarity,
    });
    const fullPrompt = `${rubricBlock}\n\n${variableBlock}`;

    const run = baseRun(
      "merge_check",
      MERGE_CHECK_PROMPT_VERSION,
      fullPrompt,
      AI_MODELS.GEMINI_PRO,
    );
    const start = Date.now();

    const model = this.genAI.getGenerativeModel({
      model: AI_MODELS.GEMINI_PRO,
      generationConfig: {
        temperature: AI_TEMPERATURE.MERGE_CHECK,
        responseMimeType: "application/json",
      },
      systemInstruction: rubricBlock,
    });

    const result = await model.generateContent(variableBlock);
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const latencyMs = Date.now() - start;
    const estimatedCost = estimateProCost(inputTokens, outputTokens);

    let output: MergeCheckOutput;
    try {
      const parsed = JSON.parse(text);
      output = validateMergeCheckOutput(parsed);
    } catch (error) {
      throw malformedResponse({
        message:
          error instanceof Error ? error.message : "Merge check output was malformed",
        rawOutput: text,
        runType: "merge_check",
        modelName: AI_MODELS.GEMINI_PRO,
        promptVersion: MERGE_CHECK_PROMPT_VERSION,
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
