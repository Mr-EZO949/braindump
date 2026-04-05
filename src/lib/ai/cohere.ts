// Cohere rerank provider implementation.
// Implements the RerankProvider interface using cohere-ai.
// Never import this directly in route handlers — use getRerankProvider() from index.ts.

import { CohereClient } from "cohere-ai";
import { createHash } from "crypto";

import type { RerankProvider, AIProviderResult } from "./provider";
import type { RerankInput, RerankOutput, AIRun } from "@/types/ai";
import { AI_MODELS, AI_CANDIDATES, AI_COST_PER_1M_TOKENS } from "./config";
import { MalformedAIResponseError } from "./errors";
import { validateRerankOutput } from "./validation";

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export class CohereRerankProvider implements RerankProvider {
  private client: CohereClient;

  constructor(apiKey: string) {
    this.client = new CohereClient({ token: apiKey });
  }

  async rerankCandidates(
    input: RerankInput
  ): Promise<AIProviderResult<RerankOutput>> {
    const run: Omit<AIRun, "id" | "created_at"> = {
      run_type: "rerank",
      provider: "cohere",
      model_name: AI_MODELS.COHERE_RERANK,
      prompt_version: "rerank-v1",
      input_hash: shortHash(input.query + input.candidates.map((c) => c.id).join(",")),
      output_hash: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      estimated_cost: AI_COST_PER_1M_TOKENS.COHERE_RERANK_PER_CALL,
      status: "success",
      error_text: null,
    };

    const start = Date.now();

    const response = await this.client.rerank({
      model: AI_MODELS.COHERE_RERANK,
      query: input.query,
      documents: input.candidates.map((c) => c.text),
      topN: AI_CANDIDATES.RERANK_N,
    });

    const ranked = response.results.map((r) => ({
      id: input.candidates[r.index].id,
      score: r.relevanceScore,
    }));
    const latencyMs = Date.now() - start;

    let output: RerankOutput;
    try {
      output = validateRerankOutput({ ranked });
    } catch (error) {
      throw new MalformedAIResponseError({
        message: error instanceof Error ? error.message : "Rerank output was malformed",
        rawOutput: JSON.stringify({ ranked }),
        runType: "rerank",
        provider: "cohere",
        modelName: AI_MODELS.COHERE_RERANK,
        promptVersion: "rerank-v1",
        inputHash: run.input_hash,
        outputHash: shortHash(ranked.map((r) => r.id).join(",")),
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCost: AI_COST_PER_1M_TOKENS.COHERE_RERANK_PER_CALL,
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
}
