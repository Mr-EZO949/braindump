// AI configuration module for Thought Router.
// All tunables live here — never as magic numbers in route handlers or services.
// Every value here is a conscious decision, not a default left unchanged.

// ---------------------------------------------------------------------------
// Feature flags
// Default is FALSE. A flag is only enabled when its env var is explicitly "true".
// Missing or unset vars evaluate to false — no .env entry needed to keep them off.
// ---------------------------------------------------------------------------

export const AI_FLAGS = {
  EXTRACTION_ENABLED: process.env.AI_EXTRACTION_ENABLED === "true",
  EMBEDDING_ENABLED: process.env.AI_EMBEDDING_ENABLED === "true",
  EDGE_INFERENCE_ENABLED: process.env.AI_EDGE_INFERENCE_ENABLED === "true",
  PLANNER_ENABLED: process.env.AI_PLANNER_ENABLED === "true",
  MERGE_SUGGESTIONS_ENABLED:
    process.env.AI_MERGE_SUGGESTIONS_ENABLED === "true",
  LIFECYCLE_CASCADE_ENABLED:
    process.env.AI_LIFECYCLE_CASCADE_ENABLED === "true",
} as const;

// ---------------------------------------------------------------------------
// Model names
// ---------------------------------------------------------------------------

export const AI_MODELS = {
  // Primary LLM for extraction, inference, assistant, planning
  GEMINI_LLM: "gemini-2.5-flash",
  // Embedding model — 3072 dimensions (gemini-embedding-001)
  GEMINI_EMBEDDING: "gemini-embedding-001",
  // Cohere reranking
  COHERE_RERANK: "rerank-v3.5",
} as const;

// ---------------------------------------------------------------------------
// Temperature defaults
// Lower = more deterministic structured output; higher = more creative
// ---------------------------------------------------------------------------

export const AI_TEMPERATURE = {
  EXTRACTION: 0.1, // Structured JSON — want consistency
  EDGE_INFERENCE: 0.1, // Structured JSON — want consistency
  ASSISTANT: 0.7, // Conversational — allow some creativity
  PLANNER: 0.2, // Structured blocks — mostly deterministic
} as const;

// ---------------------------------------------------------------------------
// Confidence thresholds
// Values below these thresholds are filtered or flagged
// ---------------------------------------------------------------------------

export const AI_CONFIDENCE = {
  // Minimum extraction confidence to include in proposals (0–1)
  EXTRACTION_MIN: 0.6,
  // Minimum edge inference confidence to create a proposed_edge (0–1)
  // Low on purpose — proposals are reviewed by the user, so false positives
  // are fine. Missing real connections is the worse outcome.
  EDGE_INFERENCE_MIN: 0.3,
  // Minimum confidence to surface a merge suggestion (0–1)
  MERGE_DETECTION_MIN: 0.75,
} as const;

// ---------------------------------------------------------------------------
// Candidate limits
// Controls how many candidates go through each pipeline stage
// ---------------------------------------------------------------------------

export const AI_CANDIDATES = {
  // Top K results returned from embedding similarity search
  RETRIEVAL_K: 20,
  // Top N kept after Cohere reranking
  RERANK_N: 10,
  // Max candidates passed to edge inference per new node
  INFERENCE_MAX: 8,
  // Max duplicate candidates surfaced per node
  MERGE_MAX: 3,
} as const;

// ---------------------------------------------------------------------------
// Context window token budgets (per route)
// Approximate tokens available for context assembly.
// These are conservative ceilings — leave headroom for the system prompt
// and expected output tokens.
// ---------------------------------------------------------------------------

export const AI_TOKEN_BUDGETS = {
  // Assistant chat context (node details + neighbors + recent events)
  ASSISTANT_CHAT: 8_000,
  // Planner context (candidate nodes + workspace summary)
  PLANNER: 12_000,
  // Edge inference context (source + target + surrounding nodes)
  EDGE_INFERENCE: 2_000,
  // Extraction context (raw entry text)
  EXTRACTION: 4_000,
} as const;

// ---------------------------------------------------------------------------
// Cost estimates (USD per 1M tokens)
// Used for tracking; update when pricing changes.
// These are estimates — reconcile against actual API invoices monthly.
// ---------------------------------------------------------------------------

export const AI_COST_PER_1M_TOKENS = {
  // Gemini 2.0 Flash (input / output)
  GEMINI_FLASH_INPUT: 0.075,
  GEMINI_FLASH_OUTPUT: 0.3,
  // Gemini text-embedding-004 (input only)
  GEMINI_EMBEDDING_INPUT: 0.0001,
  // Cohere Rerank v3.5 (per 1K search units; mapped to per-call below)
  COHERE_RERANK_PER_CALL: 0.002,
} as const;

// ---------------------------------------------------------------------------
// Edge decay
// Controls how quickly edges lose weight after connected nodes complete
// ---------------------------------------------------------------------------

export const AI_DECAY = {
  // Days before a completed-node edge starts decaying
  DECAY_START_DAYS: 3,
  // Days until an edge reaches minimum weight after completion
  DECAY_FULL_DAYS: 30,
  // Minimum decay_factor floor (never fully zero while node exists)
  DECAY_FLOOR: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Deduplication / merge detection
// ---------------------------------------------------------------------------

export const AI_DEDUP = {
  // Cosine similarity threshold above which two nodes are considered merge candidates
  // Start at 0.92 and tune based on false-positive rate.
  SIMILARITY_THRESHOLD: 0.92,
} as const;

// ---------------------------------------------------------------------------
// Ingestion limits
// ---------------------------------------------------------------------------

export const AI_INGESTION = {
  // Maximum characters accepted in a single brain dump before rejection/chunking
  MAX_CHARS: 10_000,
  // Number of retry attempts for extraction before marking raw_entry as failed
  EXTRACTION_MAX_RETRIES: 2,
  // Number of retry attempts for embedding before queuing for later
  EMBEDDING_MAX_RETRIES: 3,
} as const;

// ---------------------------------------------------------------------------
// Assistant / lifecycle
// ---------------------------------------------------------------------------

export const AI_ASSISTANT = {
  // Hours to include recently completed nodes in assistant context
  COMPLETED_NODE_CONTEXT_WINDOW_HOURS: 48,
} as const;
