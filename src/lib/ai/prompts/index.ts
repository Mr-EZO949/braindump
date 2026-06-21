// Prompt registry — Phase 9.5
// Central index of all prompt builders and their current versions.
// Import from here instead of individual files to keep prompt usage traceable.

import { EXTRACT_PROMPT_VERSION, buildExtractionPrompt } from "./extract";
import { INFER_EDGE_PROMPT_VERSION, buildEdgeInferencePrompt } from "./infer-edge";
import {
  ASSISTANT_PROMPT_VERSION,
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
} from "./assistant";
import { PLAN_PROMPT_VERSION, buildPlanPrompt } from "./plan";
import { MERGE_CHECK_PROMPT_VERSION, buildMergeCheckPrompt } from "./merge-check";

export {
  EXTRACT_PROMPT_VERSION,
  buildExtractionPrompt,
  INFER_EDGE_PROMPT_VERSION,
  buildEdgeInferencePrompt,
  ASSISTANT_PROMPT_VERSION,
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  PLAN_PROMPT_VERSION,
  buildPlanPrompt,
  MERGE_CHECK_PROMPT_VERSION,
  buildMergeCheckPrompt,
};

// ---------------------------------------------------------------------------
// Version map — single source of truth for all prompt versions.
// DERIVED from each prompt's own *_PROMPT_VERSION constant so it can never
// drift out of sync (it used to: was extract-v7 while the real one was v13).
// Used by the eval harness and observability for cost tracking. (embed/rerank
// have no builder module, so they stay literal.)
// ---------------------------------------------------------------------------

export const PROMPT_VERSIONS = {
  extract: EXTRACT_PROMPT_VERSION,
  infer_edge: INFER_EDGE_PROMPT_VERSION,
  assistant: ASSISTANT_PROMPT_VERSION,
  plan: PLAN_PROMPT_VERSION,
  merge_check: MERGE_CHECK_PROMPT_VERSION,
  embed: "embed-v1",
  rerank: "rerank-v1",
} as const;

export type PromptVersionKey = keyof typeof PROMPT_VERSIONS;
