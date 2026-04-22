import type { ChatMessage, ChatScope } from "@/types/chat";

export interface ChatSessionMeta {
  id: string;
  workspace_id: string;
  scope_kind: "workspace" | "node";
  scope_node_id: string | null;
  title: string;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionDetail extends ChatSessionMeta {
  messages: ChatMessage[];
}

export async function listChatSessions(workspaceId: string): Promise<ChatSessionMeta[]> {
  const res = await fetch(
    `/api/chat/sessions?workspace_id=${encodeURIComponent(workspaceId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions?: ChatSessionMeta[] };
  return data.sessions ?? [];
}

export async function loadChatSession(id: string): Promise<ChatSessionDetail | null> {
  const res = await fetch(`/api/chat/sessions/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as { session?: ChatSessionDetail };
  return data.session ?? null;
}

export async function upsertChatSession(params: {
  id: string | null;
  workspaceId: string;
  scope: ChatScope;
  messages: ChatMessage[];
}): Promise<ChatSessionMeta | null> {
  const res = await fetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: params.id,
      workspace_id: params.workspaceId,
      scope_kind: params.scope.kind,
      scope_node_id: params.scope.kind === "node" ? params.scope.node.id : null,
      messages: params.messages,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { session?: ChatSessionMeta };
  return data.session ?? null;
}

export async function deleteChatSession(id: string): Promise<boolean> {
  const res = await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
  return res.ok;
}
