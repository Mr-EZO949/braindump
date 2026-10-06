// AI provider abstraction for BrainDump.
// Application code talks ONLY to this interface — never to Gemini or Cohere SDKs directly.
// This allows swapping providers without rewriting route handlers.

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

// ---------------------------------------------------------------------------
// Provider interface
// Each method returns its output AND the partial ai_run record to be persisted.
// The caller is responsible for writing the ai_run to the database.
// ---------------------------------------------------------------------------

export interface AIProviderResult<T> {
  output: T;
  run: Omit<AIRun, "id" | "created_at">;
}

export interface AIProvider {
  /**
   * Extract proposed nodes from a raw brain dump.
   * Output must be validated against ProposedNode schema before DB write.
   */
  extractNodes(
    input: ExtractionInput
  ): Promise<AIProviderResult<ExtractionOutput>>;

  /**
   * Generate a semantic embedding vector for a piece of text.
   * Used for similarity search and retrieval.
   */
  generateEmbedding(
    input: EmbeddingInput
  ): Promise<AIProviderResult<EmbeddingOutput>>;

  /**
   * Embed several texts in one provider call. Used at ingestion for
   * relevance retrieval (dump segments) and semantic dedup (proposals).
   */
  generateEmbeddings(input: {
    texts: string[];
  }): Promise<AIProviderResult<{ embeddings: number[][] }>>;

  /**
   * Rerank a list of candidates by relevance to a query.
   * Used after vector retrieval to improve precision before edge inference.
   */
  rerankCandidates(
    input: RerankInput
  ): Promise<AIProviderResult<RerankOutput>>;

  /**
   * Infer which links several source nodes should get to their candidates —
   * one call for the whole group, only the links come back.
   * Output must be validated before creating a proposed_edge.
   */
  inferEdge(
    input: EdgeInferenceInput
  ): Promise<AIProviderResult<EdgeInferenceOutput>>;

  /**
   * Answer a user's question grounded in graph context.
   * Response should be streamed at the route handler level.
   */
  answerAssistant(
    input: AssistantInput
  ): Promise<AIProviderResult<AssistantOutput>>;

  /**
   * Generate a structured time-block plan from a candidate work set.
   */
  buildPlan(input: PlanInput): Promise<AIProviderResult<PlanOutput>>;

  /**
   * Verify whether two nodes represent the same entity and should be merged.
   * Called after embedding similarity filter to reduce false positives.
   */
  checkMerge(input: MergeCheckInput): Promise<AIProviderResult<MergeCheckOutput>>;
}

// ---------------------------------------------------------------------------
// Re-rank-only interface (Cohere is rerank-only, not a full LLM provider)
// ---------------------------------------------------------------------------

export interface RerankProvider {
  rerankCandidates(
    input: RerankInput
  ): Promise<AIProviderResult<RerankOutput>>;
}

// ---------------------------------------------------------------------------
// Provider registry
// Instantiated once at startup and used across all route handlers.
// Populated in Phase 2 when GeminiProvider and CohereRerankProvider are implemented.
// ---------------------------------------------------------------------------

let _provider: AIProvider | null = null;
let _rerankProvider: RerankProvider | null = null;

export function registerProvider(provider: AIProvider): void {
  _provider = provider;
}

export function registerRerankProvider(provider: RerankProvider): void {
  _rerankProvider = provider;
}

export function getProvider(): AIProvider {
  if (!_provider) {
    throw new Error(
      "AI provider not registered. Call registerProvider() during app initialization."
    );
  }
  return _provider;
}

export function getRerankProvider(): RerankProvider {
  if (!_rerankProvider) {
    throw new Error(
      "Rerank provider not registered. Call registerRerankProvider() during app initialization."
    );
  }
  return _rerankProvider;
}
