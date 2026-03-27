// AI provider registry entry point.
// Route handlers import from here — never from gemini.ts or cohere.ts directly.
// Providers are initialised lazily on first access (safe for Next.js serverless).

import { GeminiProvider } from "./gemini";
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

  const geminiKey = process.env.GEMINI_API_KEY;
  const cohereKey = process.env.COHERE_API_KEY;

  if (!geminiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local before using AI features."
    );
  }
  if (!cohereKey) {
    throw new Error(
      "COHERE_API_KEY is not set. Add it to .env.local before using AI features."
    );
  }

  registerProvider(new GeminiProvider(geminiKey));
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
