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
  // Long-form description (so what / why it matters / next step). Optional
  // because older nodes / minimal proposals may not have one filled in.
  body?: string | null;
  node_type: NodeType;
  importance: Importance;
  importanceIndex: number;
  currentImportanceScore?: number | null;
  importanceReason?: string | null;
  importanceTopSignals?: string[] | null;
  stakes?: number | null;
  waitingFor?: string | null;
  resumeOn?: string | null;
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
  // A change-set card accepted in part: the rows the user kept.
  acceptedIndexes?: number[];
}

// A change chat already applied (update_priorities) — shown as a card with an
// Undo instead of an Accept/Reject gate. `undo` is the server's snapshot of
// what the change touched; it goes back to /api/assistant/priorities/undo.
export type AppliedActionStatus = "applied" | "undoing" | "undone" | "error";

export interface AppliedActionItem {
  nodeId: string;
  title: string;
  action: string;
  detail: string;
  scoreBefore: number | null;
  scoreAfter: number | null;
}

export interface AppliedAction {
  toolName: string;
  items: AppliedActionItem[];
  failed: { title: string; action: string; error: string }[];
  undo: unknown;
  status: AppliedActionStatus;
  errorMessage?: string;
}

// What one brain dump came to, shown as ONE card under the assistant's reply
// (docs/unified-turn.md). The priority changes ride in the message's
// `appliedAction`, the changes that wait for the user in its `pendingAction`;
// everything else the card shows is here.
export type TurnAddedStatus = "applied" | "undoing" | "undone" | "error";

export interface TurnAddedNode {
  id: string;
  // The ledger row (proposed_nodes) — what Undo sends back.
  proposalId: string | null;
  title: string;
  nodeType: string;
  parentTitle: string | null;
}

export interface TurnCardData {
  added: TurnAddedNode[];
  addedStatus: TurnAddedStatus;
  done: string[];
  links: Array<{ sourceTitle: string; targetTitle: string; edgeType: string }>;
  // Fixed weekly times the dump named (saved already, with its own Undo).
  commitments?: AppliedAction;
  questions: Array<{ text: string; answer?: string }>;
}

// Links the connection engine noticed after a turn added nodes — a card in
// the same thread (replaces the "Suggested connections" modal there).
export interface ConnectionsCardData {
  edges: Array<{
    id: string;
    sourceTitle: string;
    targetTitle: string;
    edgeType: string;
    explanation: string | null;
  }>;
  status: "awaiting" | "saving" | "added" | "dismissed" | "error";
  // The links the user kept (status "added").
  acceptedIds?: string[];
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  body: string;
  createdAt: string;
  sections?: ChatMessageSection[];
  status?: ChatMessageStatus;
  pendingAction?: PendingAction;
  appliedAction?: AppliedAction;
  turn?: TurnCardData;
  connections?: ConnectionsCardData;
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
