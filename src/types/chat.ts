import type { AssistantMode } from "@/types/ai";
import type { EdgeType, Importance, NodeStatus, NodeType } from "@/types/graph";

export type { AssistantMode };

export type RailTab = "details" | "chat" | "planner";

export type ChatScope =
  | {
      kind: "workspace";
      workspaceName: string;
    }
  | {
      kind: "node";
      workspaceName: string;
      node: ChatNodeContext;
    };

export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "ready" | "error";

export interface ChatNodeContext {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  importance: Importance;
  importanceIndex: number;
  currentImportanceScore?: number | null;
  status: NodeStatus | null;
  connectedNodeTitles: string[];
  edgeTypes: EdgeType[];
}

export interface ChatMessageSection {
  label: string;
  value: string;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  body: string;
  createdAt: string;
  sections?: ChatMessageSection[];
  status?: ChatMessageStatus;
}
