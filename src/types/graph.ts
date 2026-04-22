export type NodeType =
  | "project"
  | "task"
  | "class"
  | "concept"
  | "idea"
  | "goal"
  | "habit";

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
  current_importance_score?: number | null;
  // When set, overrides the heuristic scorer for this node.
  manual_weight?: number | null;
  manual_weight_set_at?: string | null;
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
}

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

export type GraphEditOperation =
  | { op: "move"; node: string; new_parent: string }
  | { op: "remove_edge"; source: string; target: string; edge_type?: string }
  | { op: "rename"; node: string; new_title: string }
  | { op: "archive"; node: string };

export interface CreateNodeInput {
  custom_type: string;
  importance_index: number;
  // When set in the edit sheet, writes to nodes.manual_weight — overrides
  // the scorer for this node. null in create flow (scorer decides).
  manual_weight: number | null;
  node_type: "goal" | "task" | "project" | "concept" | "class" | "habit" | "custom";
  raw_text: string;
  summary: string;
  title: string;
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
