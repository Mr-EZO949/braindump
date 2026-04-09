// AI configuration module for BrainDump.
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
  // Claude — all LLM tasks (extraction, edge inference, assistant, planning)
  CLAUDE_SONNET: "claude-sonnet-4-6",
  // Gemini — embeddings only (Claude has no embedding API)
  GEMINI_FAST: "gemini-2.5-flash",
  GEMINI_PRO: "gemini-2.5-flash",
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
  MERGE_CHECK: 0.1, // Binary classification — deterministic
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
  // Claude Sonnet 4.6 (input / output)
  CLAUDE_SONNET_INPUT: 3.0,
  CLAUDE_SONNET_OUTPUT: 15.0,
  // Gemini 2.5 Flash — kept for embeddings only
  GEMINI_FLASH_INPUT: 0.075,
  GEMINI_FLASH_OUTPUT: 0.3,
  // Gemini embedding (input only)
  GEMINI_EMBEDDING_INPUT: 0.0001,
  // Cohere Rerank v3.5 (per 1K search units)
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
  // Cosine similarity threshold above which two nodes are considered merge candidates.
  // 0.85 catches semantically identical nodes with different wording (e.g. "Learn Rust"
  // vs "Study Rust programming"). The AI merge-check LLM filters false positives.
  SIMILARITY_THRESHOLD: 0.85,
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
// Deferred retry queue
// Used for non-blocking AI work that should recover after transient failures.
// ---------------------------------------------------------------------------

export const AI_RETRY_QUEUE = {
  // Number of queued jobs to process in one opportunistic drain pass
  BATCH_SIZE: 5,
  // Delay before a queued retry becomes eligible again
  DELAY_MS: 15_000,
  // Hard cap before a queued job is marked failed
  MAX_ATTEMPTS: 10,
} as const;

// ---------------------------------------------------------------------------
// Async jobs
// Durable queue for non-interactive or large AI workloads.
// ---------------------------------------------------------------------------

export const AI_JOBS = {
  // Max jobs to drain in one worker pass
  BATCH_SIZE: 5,
  // Default retry budget for durable async jobs
  MAX_ATTEMPTS: 5,
  // Large analyze batches can be safely queued instead of blocking the route
  ANALYZE_ASYNC_THRESHOLD: Infinity,
} as const;

// ---------------------------------------------------------------------------
// Assistant / lifecycle
// ---------------------------------------------------------------------------

export const AI_ASSISTANT = {
  // Hours to include recently completed nodes in assistant context
  COMPLETED_NODE_CONTEXT_WINDOW_HOURS: 48,
} as const;

// ---------------------------------------------------------------------------
// Node retention (auto-deletion)
// Nodes past these thresholds are permanently deleted by the nightly cron.
// All FK-cascaded child rows (edges, embeddings, events) are removed too.
// ---------------------------------------------------------------------------

export const AI_LIFECYCLE = {
  // Days after completion before a completed node is permanently deleted
  COMPLETED_DELETE_AFTER_DAYS: 30,
  // Days after archiving before an archived node is permanently deleted
  ARCHIVED_DELETE_AFTER_DAYS: 30,
} as const;

// ---------------------------------------------------------------------------
// Rate limits
// Checked against recent ai_runs / raw_entries counts per user.
// Purpose: prevent runaway scripts; not microsecond-precision enforcement.
// ---------------------------------------------------------------------------

export const AI_RATE_LIMITS = {
  // Brain-dump extractions per hour
  EXTRACTIONS_PER_HOUR: Infinity,
  // Assistant chat messages per hour
  CHAT_PER_HOUR: Infinity,
  // AI planning sessions per hour
  PLANS_PER_HOUR: Infinity,
  // Connection-analysis batches per hour
  ANALYSES_PER_HOUR: Infinity,
  // Max characters in a single chat message
  CHAT_MESSAGE_MAX_CHARS: 4_000,
  // Max characters in a semantic search query
  SEARCH_QUERY_MAX_CHARS: 500,
} as const;
