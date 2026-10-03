// AI-specific types for the BrainDump AI layer.
// These complement graph.ts types and cover proposals, runs, feedback, and lifecycle.

import type { NodeType, EdgeType, NodeStatus, EdgeStatus } from "./graph";

// Re-export so consumers can import all AI-related types from one place.
export type { NodeStatus, EdgeStatus };

export type ProposalStatus = "pending_review" | "accepted" | "rejected";

export type EdgeProposalStatus = "pending_review" | "accepted" | "rejected";

export type RawEntrySourceType =
  | "brain_dump"
  | "assistant_save"
  | "voice"
  | "planner_convert";

export type RawEntryStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export type AIRunType =
  | "extract"
  | "embed"
  | "rerank"
  | "infer_edge"
  | "assistant"
  | "plan"
  | "merge_check"
  | "lifecycle_cascade"
  | "node_judgment"
  | "rerank_importance"
  // Small Haiku helpers (classifiers, duration estimates, cluster naming, …)
  | "auxiliary";

export interface AINodeJudgment {
  id: string;
  node_id: string;
  workspace_id: string;
  user_id: string;
  score: number;
  reason: string | null;
  model_name: string;
  computed_at: string;
}

export type AIRunStatus = "success" | "failed" | "retrying";

export type AIRetryJobType = "embed_node" | "analyze_node";

export type AIRetryJobStatus = "queued" | "processing" | "completed" | "failed";

export type AIJobType =
  | "embedding_backfill"
  | "score_recompute"
  | "lifecycle_cascade"
  | "connection_batch"
  | "duplicate_detection";

export type AIJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "dead_lettered";

export type FeedbackEventType =
  | "accept_node"
  | "reject_node"
  | "reject_edge"
  | "confirm_edge"
  | "edit_plan"
  | "dismiss_merge"
  | "complete_node"
  | "reopen_node"
  | "archive_node"
  | "boost_node"
  | "demote_node";

export type LifecycleAction =
  | "score_recomputed"
  | "edge_decayed"
  | "unblocked"
  | "suggested_archive";

export type PlanBlockType = "focus" | "admin" | "break" | "buffer";

export type PlanBlockCompletionStatus = "pending" | "completed" | "skipped";

export type PlanningWindow = "1h" | "2h" | "day" | "custom";

export type ExtractionSoftLinkType =
  | "supports"
  | "related_to"
  | "prerequisite_for"
  | "useful_for"
  | "inspired_by";

export interface ExtractionSoftLink {
  target_local_ref: string;
  edge_type: ExtractionSoftLinkType;
  rationale: string | null;
}

// ---------------------------------------------------------------------------
// Raw ingestion
// ---------------------------------------------------------------------------

export interface RawEntry {
  id: string;
  user_id: string;
  workspace_id: string;
  raw_text: string;
  source_type: RawEntrySourceType;
  status: RawEntryStatus;
  error_message: string | null;
  retry_count: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface ProposedNode {
  id: string;
  raw_entry_id: string;
  workspace_id: string;
  user_id: string;
  ai_run_id: string;
  local_ref: string | null;
  primary_parent_local_ref: string | null;
  existing_parent_node_id: string | null;
  depends_on_local_refs: string[];
  soft_links: ExtractionSoftLink[];
  accepted_node_id: string | null;
  proposed_title: string;
  proposed_summary: string | null;
  // Long-form description (so what / why it matters / next step). Filled
  // by the extractor when there's enough signal in the dump; null when
  // the dump didn't say enough to write something honest.
  proposed_body: string | null;
  proposed_node_type: NodeType;
  proposed_target_date: string | null;
  extraction_confidence: number;
  source_span: string | null;
  proposal_status: ProposalStatus;
  created_at: string;
}

export interface ProposedEdge {
  id: string;
  workspace_id: string;
  user_id: string;
  ai_run_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  confidence: number;
  explanation: string | null;
  proposal_status: EdgeProposalStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// AI provenance
// ---------------------------------------------------------------------------

export interface AIRun {
  id: string;
  run_type: AIRunType;
  provider: string;
  model_name: string;
  prompt_version: string;
  input_hash: string | null;
  output_hash: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  estimated_cost: number | null;
  status: AIRunStatus;
  error_text: string | null;
  created_at: string;
}

export interface AIArtifact {
  id: string;
  ai_run_id: string;
  artifact_type: string;
  payload: Record<string, unknown>;
  linked_entity_ids: string[] | null;
  created_at: string;
}

export interface AIRetryJob {
  id: string;
  user_id: string;
  workspace_id: string | null;
  job_type: AIRetryJobType;
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: AIRetryJobStatus;
  attempt_count: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIJob {
  id: string;
  user_id: string;
  workspace_id: string | null;
  job_type: AIJobType;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: AIJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  dead_letter_reason: string | null;
  result_summary: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Feedback and scoring
// ---------------------------------------------------------------------------

export interface FeedbackEvent {
  id: string;
  event_type: FeedbackEventType;
  entity_type: string;
  entity_id: string;
  user_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface NodeScore {
  id: string;
  node_id: string;
  score_version: string;
  urgency_score: number;
  goal_alignment_score: number;
  planner_score: number;
  recency_score: number;
  graph_centrality_score: number;
  user_confirmation_score: number;
  ai_prior_score: number;
  blocker_resolved_bonus: number;
  final_score: number;
  computed_at: string;
}

export interface EdgeScore {
  id: string;
  edge_id: string;
  confidence: number;
  confirmation_count: number;
  rejection_count: number;
  stale: boolean;
  decay_factor: number;
  final_weight: number;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface LifecycleEvent {
  id: string;
  node_id: string;
  previous_status: NodeStatus;
  new_status: NodeStatus;
  user_id: string;
  cascade_triggered: boolean;
  created_at: string;
}

export interface CascadeResult {
  id: string;
  lifecycle_event_id: string;
  affected_node_id: string;
  action_taken: LifecycleAction;
  details: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanSession {
  id: string;
  workspace_id: string;
  user_id: string;
  planning_window: PlanningWindow;
  // Set only when planning_window === "custom"; the chosen total length.
  custom_minutes: number | null;
  scope: string | null;
  status: string;
  created_at: string;
}

export interface PlanBlock {
  id: string;
  plan_session_id: string;
  node_id: string | null;
  title: string;
  start_offset: number;
  duration_minutes: number;
  reason: string | null;
  block_type: PlanBlockType;
  completion_status: PlanBlockCompletionStatus;
}

export interface PlanFeedback {
  id: string;
  plan_session_id: string;
  accepted: boolean;
  edited: boolean;
  rejected: boolean;
  completion_status: string | null;
}

// ---------------------------------------------------------------------------
// Provider method I/O shapes
// ---------------------------------------------------------------------------

export interface ExtractionInput {
  raw_text: string;
  workspace_id: string;
  user_id: string;
  workspace_context?: string;
  existing_nodes?: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: NodeType;
    // Where this node sits in the tree ("under: X") — lets the model attach to
    // the right level instead of guessing from a flat list.
    parent_title?: string | null;
  }>;
  // The user's local date (YYYY-MM-DD) for resolving "by Friday", "tomorrow".
  today?: string;
  // Cancels the provider call when the client aborts the request.
  signal?: AbortSignal;
  // Prompt-cache the static rubric for this long, or send it uncached (null /
  // absent). Picked from app-wide traffic in extraction.ts.
  rubric_cache_ttl?: "1h" | null;
  // "light": short update dumps → slim prompt on Haiku (extract-light.ts).
  variant?: "full" | "light";
  // Streams the answer and calls this with the text so far — the builder
  // starts its edit pass as soon as edit_requests is complete (extraction.ts).
  on_text?: (snapshot: string) => void;
}

// What one brain dump came to (POST /api/entries, docs/unified-turn.md) — the
// content of the single card the dump's thread shows. The changes that wait
// for the user travel next to it as `pending_action`, priorities and weekly
// commitments as `priority_update` / `commitment_update`.
export interface DumpTurn {
  // The assistant's answer to the human part of the dump (venting, a direct
  // question); null when the dump was only items.
  reply: string | null;
  // Applied already.
  added: Array<{
    id: string;
    // The ledger row (proposed_nodes) — what Undo sends back.
    proposal_id: string | null;
    title: string;
    node_type: string;
    parent_title: string | null;
  }>;
  done: string[];
  // removed: a link the turn took away ("A and B aren't related").
  links: Array<{ source_title: string; target_title: string; edge_type: string; removed?: boolean }>;
  // Things the builder or the priority read could not settle.
  questions: string[];
  // How to put back each applied section (lib/graph/change-undo.ts steps).
  undo?: TurnUndo;
}

// What a turn applied at once, for its card (a chat message's or a dump's;
// the dump's reply travels separately).
export type TurnApplied = Omit<DumpTurn, "reply">;

// Undo steps per section of a turn's card. Typed loosely here (types/ stays
// free of lib imports); lib/graph/change-undo.ts parses them on the way back.
export interface TurnUndo {
  added: unknown[];
  done: unknown[];
  links: unknown[];
}

// An edit to an EXISTING node the builder asks for alongside the nodes it adds
// (extract-v25 / extract-light-v5). `new_parent`, `source` and `target` take an
// existing node id or the local_ref of a node proposed in the same output.
export type BuilderLinkType = "supports" | "useful_for" | "required_for" | "related_to" | "inspired_by";

export type BuilderChange =
  | { kind: "move"; node_id: string; new_parent: string }
  | { kind: "update"; node_id: string; title?: string; node_type?: NodeType; summary?: string }
  | { kind: "link"; source: string; target: string; edge_type: BuilderLinkType; rationale?: string | null };

export interface ExtractionOutput {
  proposed_nodes: Omit<
    ProposedNode,
    "id" | "ai_run_id" | "raw_entry_id" | "created_at"
  >[];
  // Moves, renames/retypes and lateral links on nodes that already exist.
  changes: BuilderChange[];
  // The user's sentences that ask to change EXISTING nodes, quoted by the long
  // prompt (extract-v26), which no longer plans edits itself: the builder runs
  // these through the short prompt (extraction.ts, the edit pass). Always
  // empty from the short prompt.
  edit_requests: string[];
  // Questions the extractor wants the user to answer before more nodes can
  // be usefully extracted — vague ideas, ambiguous references, meta-questions
  // like "idk what to focus on". Empty when the dump is fully actionable.
  clarifying_questions: string[];
  // Existing workspace nodes the user mentioned as DONE in this dump
  // ("did the long run", "shipped X", "survived the layoff round"). The
  // entries route applies status → completed on each so the AI stops
  // duplicating retrospective event nodes.
  complete_existing_node_ids: string[];
  // local_refs of newly-proposed nodes that should be created in the
  // "completed" state — e.g. user mentions a milestone they just hit that
  // doesn't have a pre-existing parent task. Lets the AI capture a
  // historical artifact (for streak / journaling purposes) without
  // creating an active-but-already-done task.
  auto_complete_local_refs: string[];
  prompt_version: string;
}

export interface EmbeddingInput {
  text: string;
}

export interface EmbeddingOutput {
  embedding: number[];
  token_count: number | null;
}

export interface RerankInput {
  query: string;
  candidates: { id: string; text: string }[];
}

export interface RerankOutput {
  ranked: { id: string; score: number }[];
}

export interface EdgeInferenceInput {
  source_node: {
    id: string;
    title: string;
    summary: string | null;
    node_type?: string | null;
    // Whether it already sits under a parent (belongs_to is then off the table).
    has_parent?: boolean;
  };
  candidates: { id: string; title: string; summary: string | null; node_type?: string | null }[];
  workspace_context?: string;
}

export interface EdgeInferenceResult {
  candidate_id: string;
  related: boolean;
  edge_type: EdgeType | null;
  // Which end the link starts at: "source" = source → candidate.
  from: "source" | "candidate";
  confidence: number;
  explanation: string;
}

export interface EdgeInferenceOutput {
  results: EdgeInferenceResult[];
  prompt_version: string;
}

export type AssistantMode = "explain" | "plan" | "transform";

export interface AssistantInput {
  message: string;
  context: string;
  scope: string;
  mode?: AssistantMode;
}

export interface AssistantOutput {
  answer: string;
  prompt_version: string;
}

export interface PlanInput {
  planning_window: PlanningWindow;
  // Total minutes to fill when planning_window === "custom". Clamped to
  // 15–600 by the provider; ignored for the fixed 1h/2h/day windows.
  custom_minutes?: number | null;
  candidate_nodes: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: NodeType;
    planning_signals?: string[];
  }>;
  workspace_context?: string;
  // Fixed commitments inside the session (docs/commitments.md): only the free
  // minutes get planned, and the Session block says where the gaps are.
  busy?: { free_minutes: number; lines: string[] } | null;
}

export interface PlanOutput {
  blocks: Omit<PlanBlock, "id" | "plan_session_id">[];
  prompt_version: string;
}

export interface MergeCheckInput {
  new_node: { title: string; summary: string | null; node_type: NodeType };
  existing_node: { title: string; summary: string | null; node_type: NodeType };
  similarity: number;
}

export interface MergeCheckOutput {
  same_entity: boolean;
  confidence: number;
  reason: string;
  prompt_version: string;
}

export type MergeSuggestionStatus = "pending" | "dismissed" | "merged" | "never";

export interface MergeSuggestion {
  id: string;
  workspace_id: string;
  user_id: string;
  new_node_id: string;
  existing_node_id: string;
  similarity: number;
  ai_confidence: number | null;
  ai_reason: string | null;
  status: MergeSuggestionStatus;
  created_at: string;
}
