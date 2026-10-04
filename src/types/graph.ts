// Node taxonomy v2 (docs/node-types.md; rules and helpers in
// src/lib/graph/node-types.ts). "concept" is retired: old rows were migrated
// to area/note, and normalizeNodeType maps any straggler to note.
export type NodeType =
  | "goal"
  | "project"
  | "big_task"
  | "task"
  | "habit"
  | "area"
  | "class"
  | "idea"
  | "note";

// Added in AI Phase 1A — lifecycle status for nodes and edges.
export type NodeStatus = "active" | "completed" | "paused" | "archived";
export type EdgeStatus = "active" | "decayed" | "orphaned" | "user_rejected";

export type Importance = "low" | "medium" | "high";

export type EdgeType =
  | "supports"
  | "related_to"
  | "prerequisite_for"
  | "required_for"
  | "belongs_to"
  | "useful_for"
  | "blocks"
  | "inspired_by"
  | "depends_on";

export interface Node {
  id: string;
  user_id: string;
  workspace_id?: string | null;
  title: string;
  summary: string | null;
  // Long-form description answering "so what?", "why it matters?", and
  // "what should be done?" — kept compact (~400 chars) so cards stay
  // glanceable. Filled by AI extraction; user-editable on create/edit.
  body: string | null;
  raw_text: string | null;
  node_type: NodeType;
  importance: Importance;
  importance_index?: number | null;
  position_x?: number | null;
  position_y?: number | null;
  manual_position?: boolean | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  // AI Phase 1A columns — optional so existing queries don't break before migration
  status?: NodeStatus | null;
  completed_at?: string | null;
  archived_at?: string | null;
  current_importance_score?: number | null;
  // Explainability for the importance score — populated by computeWorkspaceScores
  // on every recompute. `importance_reason` is the AI judgment's one-line
  // explanation; `importance_top_signals` lists the 1-3 highest-weighted
  // signals that drove the score (e.g. ['urgency', 'goal_alignment']).
  importance_reason?: string | null;
  importance_top_signals?: string[] | null;
  // When set, overrides the heuristic scorer for this node.
  manual_weight?: number | null;
  manual_weight_set_at?: string | null;
  // Ranking v2 (docs/ranking.md): -1 low · null normal · 1 high stakes, and
  // what a paused node is waiting on + when to check back.
  stakes?: number | null;
  waiting_for?: string | null;
  resume_on?: string | null;
  // Optional ISO date deadline. Drives the Roadmap view: any goal/project
  // with a target_date appears there grouped by month/quarter. Null means
  // no deadline — the node lives only in the timeless graph view.
  target_date?: string | null;
  // Habit-only: the day the user marks as the official "start" of the habit.
  // Stats (% done, missed) are computed from this day forward. Null = no
  // anchor set; UI falls back to the earliest completion or fetched window.
  habit_started_on?: string | null;
  // Habit-only: cadence target — completions wanted per ISO week (1–7).
  // 7 = daily, 3 = "3× a week", 1 = weekly. Null = no cadence tracked.
  // Drives the planner's CADENCE_DUE boost (Focus surfaces it when due).
  habit_target_per_week?: number | null;
  // Optional narrative position within the workspace (ascending). Drives the
  // reading view's Prev/Next. Independent of edges — never derived from or
  // turned into edges. Null = unordered (Next falls back to strongest edge).
  reading_order?: number | null;
}

export interface Edge {
  id: string;
  user_id: string;
  workspace_id?: string | null;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  created_at: string;
  // AI Phase 1A columns — optional so existing queries don't break before migration
  status?: EdgeStatus | null;
  confidence?: number | null;
  explanation?: string | null;
  user_rejected?: boolean | null;
  user_confirmed?: boolean | null;
  updated_at?: string | null;
}

export interface Workspace {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  profile_role?: string | null;
  profile_summary?: string | null;
  profile_payload?: WorkspaceProfile | null;
  bootstrap_root_node_id?: string | null;
  bootstrap_completed_at?: string | null;
  // Public sharing — see 20260808020000_workspace_public_sharing.
  is_public?: boolean | null;
  public_slug?: string | null;
  shared_at?: string | null;
}

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

export interface CreateNodeInput {
  custom_type: string;
  importance_index: number;
  // When set in the edit sheet, writes to nodes.manual_weight — overrides
  // the scorer for this node. null in create flow (scorer decides).
  manual_weight: number | null;
  node_type: NodeType | "custom";
  raw_text: string;
  summary: string;
  // Optional long-form context (so what / why it matters / what's next).
  // Empty string = none. ~400 chars is the soft cap.
  body: string;
  title: string;
  // Optional ISO date deadline (YYYY-MM-DD). Empty string = no deadline.
  // Surfaced in the create/edit form as a date picker.
  target_date: string;
  // Create sheet only: the new node's parent ("" = top level). Written as a
  // belongs_to edge through lib/graph/hierarchy.ts setNodeParent.
  parent_id?: string;
}

export type WorkspaceProfileAreaType =
  | "academic"
  | "project"
  | "career"
  | "health"
  | "life_admin"
  | "personal";

export interface WorkspaceProfileArea {
  title: string;
  area_type: WorkspaceProfileAreaType;
}

export interface WorkspaceProfile {
  version: number;
  role: string | null;
  current_focus: string | null;
  success_title: string | null;
  goals: string[];
  areas: WorkspaceProfileArea[];
}

// User-level "about you" identity — captured once at sign-up (see the
// `profiles` table / 20260824000000_user_profiles) and injected into every
// workspace's AI context. Distinct from WorkspaceProfile, which is
// workspace-specific. Every field here is read by at least one AI prompt.
export interface UserProfile {
  full_name: string | null;
  occupation: string | null;
  // What tends to make the user freeze / procrastinate — the assistant reads
  // this to tailor how it unblocks them.
  paralysis_triggers: string | null;
  // Typical working hours / energy pattern — the planner reads this.
  working_hours: string | null;
  // How the user relates to deadlines — milder planner signal.
  deadline_cadence: string | null;
  // Set once the first-run intake is finished or skipped. Null = not answered.
  intake_completed_at: string | null;
}
