// Prompt registry — Phase 9.5
// Central index of all prompt builders and their current versions.
// Import from here instead of individual files to keep prompt usage traceable.

export {
  EXTRACT_PROMPT_VERSION,
  buildExtractionPrompt,
} from "./extract";

export {
  INFER_EDGE_PROMPT_VERSION,
  buildEdgeInferencePrompt,
} from "./infer-edge";

export {
  ASSISTANT_PROMPT_VERSION,
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
} from "./assistant";

export {
  PLAN_PROMPT_VERSION,
  buildPlanPrompt,
} from "./plan";

export {
  MERGE_CHECK_PROMPT_VERSION,
  buildMergeCheckPrompt,
} from "./merge-check";

// ---------------------------------------------------------------------------
// Version map — single source of truth for all prompt versions
// Used by eval harness to tag results and by observability for cost tracking.
// ---------------------------------------------------------------------------

export const PROMPT_VERSIONS = {
  extract: "extract-v7",
  infer_edge: "infer-edge-v3",
  assistant: "assistant-v2",
  plan: "plan-v2",
  merge_check: "merge-check-v1",
  embed: "embed-v1",
  rerank: "rerank-v1",
} as const;

export type PromptVersionKey = keyof typeof PROMPT_VERSIONS;
