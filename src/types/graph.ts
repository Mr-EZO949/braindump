export type NodeType =
  | "project"
  | "task"
  | "class"
  | "concept"
  | "idea"
  | "journal"
  | "question"
  | "goal";

export type Importance = "low" | "medium" | "high";

export type EdgeType =
  | "supports"
  | "related_to"
  | "prerequisite_for"
  | "required_for"
  | "belongs_to"
  | "useful_for"
  | "blocks"
  | "inspired_by";

export interface Node {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  raw_text: string | null;
  node_type: NodeType;
  importance: Importance;
  importance_index?: number | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface Edge {
  id: string;
  user_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  created_at: string;
}

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}
