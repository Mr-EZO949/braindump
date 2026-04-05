// AI provider registry entry point.
// Route handlers import from here — never from gemini.ts, claude.ts, or cohere.ts directly.
// Providers are initialised lazily on first access (safe for Next.js serverless).
//
// Architecture:
//   LLM tasks (extract, infer_edge, assistant, plan) → Claude Sonnet 4.6
//   Embeddings → Gemini (Claude has no embedding API)
//   Reranking   → Cohere

import { GeminiProvider } from "./gemini";
import { ClaudeProvider } from "./claude";
import { CohereRerankProvider } from "./cohere";
import {
  registerProvider,
  registerRerankProvider,
  getProvider,
  getRerankProvider,
} from "./provider";

let initialised = false;

function init() {
  if (initialised) return;
  initialised = true;

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const cohereKey = process.env.COHERE_API_KEY;

  if (!claudeKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local before using AI features.",
    );
  }
  if (!geminiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. It is still required for embeddings — add it to .env.local.",
    );
  }
  if (!cohereKey) {
    throw new Error(
      "COHERE_API_KEY is not set. Add it to .env.local before using AI features.",
    );
  }

  const claude = new ClaudeProvider(claudeKey);
  const gemini = new GeminiProvider(geminiKey);

  // Hybrid provider: Claude handles all LLM tasks, Gemini handles embeddings/rerank fallback.
  registerProvider({
    extractNodes: (input) => claude.extractNodes(input),
    inferEdge: (input) => claude.inferEdge(input),
    answerAssistant: (input) => claude.answerAssistant(input),
    buildPlan: (input) => claude.buildPlan(input),
    checkMerge: (input) => claude.checkMerge(input),
    generateEmbedding: (input) => gemini.generateEmbedding(input),
    rerankCandidates: (input) => gemini.rerankCandidates(input),
  });
  registerRerankProvider(new CohereRerankProvider(cohereKey));
}

// Convenience accessors — call init() transparently on first use.
export function aiProvider() {
  init();
  return getProvider();
}

export function aiRerankProvider() {
  init();
  return getRerankProvider();
}

// Re-export types that route handlers need
export type { AIProvider, RerankProvider, AIProviderResult } from "./provider";
