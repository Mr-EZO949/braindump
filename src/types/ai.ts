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
  | "intent";

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
  proposed_node_type: NodeType;
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
  }>;
}

export interface ExtractionOutput {
  proposed_nodes: Omit<
    ProposedNode,
    "id" | "ai_run_id" | "raw_entry_id" | "created_at"
  >[];
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
  source_node: { id: string; title: string; summary: string | null };
  target_node: { id: string; title: string; summary: string | null };
  workspace_context?: string;
}

export interface EdgeInferenceOutput {
  related: boolean;
  edge_type: EdgeType | null;
  confidence: number;
  explanation: string;
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
  candidate_nodes: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: NodeType;
    planning_signals?: string[];
  }>;
  workspace_context?: string;
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

// ---------------------------------------------------------------------------
// Intent router (unified command bar)
// ---------------------------------------------------------------------------

export type IntentType =
  | "braindump"
  | "question"
  | "plan"
  | "edit"
  | "status"
  | "unclear";

export interface IntentInput {
  message: string;
  workspace_context?: string;
  has_graph: boolean;
}

export interface IntentOutput {
  intent: IntentType;
  confidence: number;
  rationale: string;
  clarifying_question: string | null;
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
