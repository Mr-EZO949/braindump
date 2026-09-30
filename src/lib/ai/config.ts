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
  // Claude — production LLM
  CLAUDE_SONNET: "claude-sonnet-5",
  // Haiku — cheap structured tasks (history compression, node judgment)
  CLAUDE_HAIKU: "claude-haiku-4-5-20251001",
  // Gemini — embeddings always; also the dev-tier LLM when AI_PRIMARY_PROVIDER=gemini
  GEMINI_FAST: "gemini-2.5-flash",
  GEMINI_PRO: "gemini-2.5-pro",
  GEMINI_EMBEDDING: "gemini-embedding-001",
  // Plain-question chat turns (chat-router.ts → gemini-chat.ts).
  GEMINI_CHAT_QA: "gemini-3.1-flash-lite",
  // Cohere reranking
  COHERE_RERANK: "rerank-v3.5",
} as const;

// Primary LLM provider for extraction/edge/assistant/plan/merge.
// "gemini" routes everything through GeminiProvider (useful in dev on the free tier).
// Default "claude" keeps production behaviour.
export const AI_PRIMARY_PROVIDER: "claude" | "gemini" =
  process.env.AI_PRIMARY_PROVIDER === "gemini" ? "gemini" : "claude";

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

// Newer Claude models (Sonnet 5, Opus 4.7+) REJECT `temperature`/`top_p`/`top_k`
// with a 400, and default to *adaptive thinking* when `thinking` is omitted —
// which would spend thinking tokens against our small max_tokens budgets and
// add latency to the capture flow. Haiku 4.5 (and older) still accept
// `temperature` and run thinking-off by default.
//
// `claudeRequestTuning` returns the correct per-model request params so a call
// site stays correct whether it targets the Sonnet tier or Haiku. On the Sonnet
// tier we disable thinking explicitly to preserve the pre-migration (Sonnet 4.6,
// thinking-off) behavior: same latency, same cost shape, no truncation. Adaptive
// thinking is a per-route quality lever we can opt into later (with max_tokens
// headroom) — see the Sonnet 5 migration notes.
const CLAUDE_MODELS_REJECTING_SAMPLING = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable",
];

export function claudeRequestTuning(
  model: string,
  temperature: number,
): { temperature: number } | { thinking: { type: "disabled" } } {
  const rejectsSampling = CLAUDE_MODELS_REJECTING_SAMPLING.some((prefix) =>
    model.startsWith(prefix),
  );
  return rejectsSampling ? { thinking: { type: "disabled" } } : { temperature };
}

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
  // Per-kind floors for what edge inference actually proposes (connection.ts).
  // A dependency blocks its target in Focus / the planner, so it has to be
  // clear; a lateral link is just a line on the graph the user can reject.
  EDGE_DEPENDENCY_MIN: 0.75,
  EDGE_LATERAL_MIN: 0.6,
  // "related_to" is the weakest claim, so it needs a bit more than the rest.
  // (0.8 cut "faceless content ↔ personal brand" at 0.75 in the 2026-09-30
  // eval — a link the owner had called out himself.)
  EDGE_RELATED_MIN: 0.7,
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
  // Max candidates passed to edge inference per new node.
  // Dropped from 8 → 5 — ranks 6-8 from the reranker are usually noise paying
  // input tokens + an output verdict each. Sharpens LLM judgment and cuts
  // ~30% of per-call tokens.
  INFERENCE_MAX: 5,
  // Max lateral links (supports / useful_for / related_to / inspired_by)
  // proposed per analysed node. Was 1, which with the old dependency-first
  // prompt meant a 25-node dump got none at all.
  LATERAL_PER_NODE: 2,
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
  // Claude Sonnet 5 (input / output) — cheaper than Sonnet 4.6's $3/$15
  CLAUDE_SONNET_INPUT: 2.0,
  CLAUDE_SONNET_OUTPUT: 10.0,
  // Claude Haiku 4.5 (input / output)
  CLAUDE_HAIKU_INPUT: 1.0,
  CLAUDE_HAIKU_OUTPUT: 5.0,
  // Gemini 2.5 Flash
  GEMINI_FLASH_INPUT: 0.3,
  GEMINI_FLASH_OUTPUT: 2.5,
  // Gemini Flash-Lite (chat Q&A). Implicitly-cached input bills at 0.1×.
  GEMINI_FLASH_LITE_25_INPUT: 0.1,
  GEMINI_FLASH_LITE_25_OUTPUT: 0.4,
  GEMINI_FLASH_LITE_31_INPUT: 0.25,
  GEMINI_FLASH_LITE_31_OUTPUT: 1.5,
  // Gemini 2.5 Pro (≤200k context tier; free-tier calls price at 0 regardless)
  GEMINI_PRO_INPUT: 1.25,
  GEMINI_PRO_OUTPUT: 10.0,
  // gemini-embedding-001 (input only). The API returns no token count, so
  // callers estimate ~4 chars per token.
  GEMINI_EMBEDDING_INPUT: 0.15,
  // Cohere Rerank v3.5 (per 1K search units)
  COHERE_RERANK_PER_CALL: 0.002,
} as const;

// ---------------------------------------------------------------------------
// Dump size tiers
// A dump's cost is driven mainly by how many NODES it extracts (output tokens),
// not raw input length — so the authoritative tier keys off node count, with a
// character estimate used only as a pre-submit hint (before we know the node
// count). Used to (a) tell the user "that was a big dump" and (b) meter usage
// per plan later (detection now, enforcement not wired yet).
// ---------------------------------------------------------------------------

export const DUMP_SIZE = {
  // Authoritative: number of extracted nodes.
  MEDIUM_MIN_NODES: 5, // 1-4 = small, 5-12 = medium, 13+ = big
  BIG_MIN_NODES: 13,
  // Pre-submit estimate from character count (rough — a dense list of 5 tasks
  // in 200 chars still bills like a medium dump once extracted).
  MEDIUM_MIN_CHARS: 220,
  BIG_MIN_CHARS: 900,
} as const;

export type DumpSizeTier = "small" | "medium" | "big";

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
  // Dumps up to this length take the light extraction path (slim prompt on
  // Haiku, ~1/5 the cost) — daily updates, not multi-domain brain dumps.
  LIGHT_DUMP_MAX_CHARS: 700,
  // Number of retry attempts for embedding before queuing for later
  EMBEDDING_MAX_RETRIES: 3,
  // A dump offers "add this area" chips only while the workspace root has
  // fewer branches than this; past it the tree already has its domains.
  AREA_CHIPS_MAX_BRANCHES: 3,
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
  // Full-workspace AI rerank: 5 per 24h (rolling)
  RERANK_IMPORTANCE_PER_DAY: 5,
} as const;

// ---------------------------------------------------------------------------
// Ranking v2 (docs/ranking.md) — deadline pressure, stakes, steering, holds.
// Pure math lives in src/lib/graph/priority-signals.ts; importance in
// scoring.ts (v9), start priority in planner.ts. Change numbers HERE.
// ---------------------------------------------------------------------------

export const RANKING = {
  // Work sessions (~1–2h) a user realistically gives one deadline per day.
  // Converts "5 steps left" into days of runway for the slack calculation.
  SESSIONS_PER_DAY: 2,
  // Pressure starts rising when slack (days left − days of work) drops below
  // this many days, and is full at zero slack.
  PRESSURE_HORIZON_DAYS: 10,
  // Stakes stretch or shrink the horizon (high stakes → start caring earlier)
  // and scale the pressure itself.
  STAKES_HORIZON_FACTOR: { low: 0.6, normal: 1, high: 1.4 },
  STAKES_PRESSURE_FACTOR: { low: 0.8, normal: 1, high: 1.15 },
  // Semantic-weight shift for stakes (points on the 0–100 semantic signal).
  STAKES_SEMANTIC_SHIFT: 10,
  // Work estimate in sessions: a task is one sitting, a big task without steps
  // is ~3, and a dated goal/project/class with nothing under it yet is ~3.
  SESSIONS_TASK: 1,
  SESSIONS_BIG_TASK: 3,
  SESSIONS_UNKNOWN_OWNER: 3,
  SESSIONS_CAP: 30,
  // Overdue: full pressure for this many days past the date, then fades.
  OVERDUE_GRACE_DAYS: 2,
  OVERDUE_FADE_PER_DAY: 10,
  OVERDUE_FLOOR: 40,
  // How far up the parent chain a deadline / stakes / steering is inherited.
  MAX_INHERIT_DEPTH: 6,
  // Inherited pressure on descendants (importance). The deadline's owner gets
  // full pressure; its open steps a little less so the owner stays biggest.
  INHERITED_PRESSURE_FACTOR: 0.85,
  // Steering ("focus on X" / "X can wait") decays with this half-life.
  STEER_HALF_LIFE_DAYS: 7,
  STEER_CAP: 2,
  STEER_INHERIT_FACTOR: 0.8,
  // Hold factors on importance.
  HOLD_SELF_FACTOR: 0.32,
  HOLD_CHECK_BACK_FACTOR: 0.6,
  HOLD_ANCESTOR_FACTOR: 0.5,
} as const;
