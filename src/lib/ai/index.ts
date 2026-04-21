// AI provider registry entry point.
// Route handlers import from here — never from gemini.ts, claude.ts, or cohere.ts directly.
// Providers are initialised lazily on first access (safe for Next.js serverless).
//
// Architecture:
//   LLM tasks (extract, infer_edge, assistant, plan, merge_check) → Claude Sonnet 4.6
//     (or Gemini 2.5 Pro when AI_PRIMARY_PROVIDER=gemini, for dev on the free tier)
//   Embeddings → Gemini (Claude has no embedding API)
//   Reranking  → Cohere

import { GeminiProvider } from "./gemini";
import { ClaudeProvider } from "./claude";
import { CohereRerankProvider } from "./cohere";
import { AI_PRIMARY_PROVIDER } from "./config";
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

  if (!geminiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. It is required for embeddings — add it to .env.local.",
    );
  }
  if (!cohereKey) {
    throw new Error(
      "COHERE_API_KEY is not set. Add it to .env.local before using AI features.",
    );
  }
  if (AI_PRIMARY_PROVIDER === "claude" && !claudeKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local or set AI_PRIMARY_PROVIDER=gemini to run the dev tier.",
    );
  }

  const gemini = new GeminiProvider(geminiKey);
  const llm = AI_PRIMARY_PROVIDER === "gemini" ? gemini : new ClaudeProvider(claudeKey!);

  registerProvider({
    extractNodes: (input) => llm.extractNodes(input),
    inferEdge: (input) => llm.inferEdge(input),
    answerAssistant: (input) => llm.answerAssistant(input),
    buildPlan: (input) => llm.buildPlan(input),
    checkMerge: (input) => llm.checkMerge(input),
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
