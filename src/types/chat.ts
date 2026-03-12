import type { EdgeType, Importance, NodeType } from "@/types/graph";

export type RailTab = "details" | "chat";

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
