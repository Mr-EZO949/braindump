import type { EdgeType, Importance, NodeStatus, NodeType } from "@/types/graph";

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

// When Claude proposes a mutation tool, the server pauses the stream and
// emits a <<BRAINDUMP_PAUSE>> marker. The client parses it into this shape
// and renders an inline Accept/Reject card on the in-flight assistant bubble.
export type PendingActionStatus = "awaiting" | "accepted" | "rejected" | "error";

export interface PendingAction {
  runId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: PendingActionStatus;
  errorMessage?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  body: string;
  createdAt: string;
  sections?: ChatMessageSection[];
  status?: ChatMessageStatus;
  pendingAction?: PendingAction;
}

// M4.1 — Proactive nudge surfaced in the empty-chat state. Produced by
// GET /api/assistant/nudges; tapping a chip submits `starter` as the first
// user message.
export type NudgeKind =
  | "recent_completions"
  | "overdue_tasks"
  | "quiet_goals"
  | "recent_archives";

export interface Nudge {
  id: string;
  kind: NudgeKind;
  title: string;
  starter: string;
  count: number;
}
