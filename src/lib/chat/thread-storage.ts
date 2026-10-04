// The open chat thread, kept in localStorage per user + workspace so a reload
// restores it before the saved sessions load (moved out of AppShell, 2026-10-04).

import type { ChatMessage } from "@/types/chat";

export const CHAT_HISTORY_MAX = 200;

function getChatHistoryKey(userId: string | null, workspaceId: string | null): string | null {
  if (!userId || !workspaceId) return null;
  return `brain-dump:chat-history:${userId}:${workspaceId}`;
}

export function readChatHistory(userId: string | null, workspaceId: string | null): ChatMessage[] {
  if (typeof window === "undefined") return [];
  const key = getChatHistoryKey(userId, workspaceId);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function writeChatHistory(userId: string | null, workspaceId: string | null, messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  const key = getChatHistoryKey(userId, workspaceId);
  if (!key) return;
  try {
    const trimmed = messages.slice(-CHAT_HISTORY_MAX);
    window.localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    // Ignore storage failures — chat still works in memory.
  }
}

function getChatSessionIdKey(userId: string | null, workspaceId: string | null): string | null {
  if (!userId || !workspaceId) return null;
  return `brain-dump:chat-session-id:${userId}:${workspaceId}`;
}

export function readChatSessionId(userId: string | null, workspaceId: string | null): string | null {
  if (typeof window === "undefined") return null;
  const key = getChatSessionIdKey(userId, workspaceId);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeChatSessionId(userId: string | null, workspaceId: string | null, sessionId: string | null): void {
  if (typeof window === "undefined") return;
  const key = getChatSessionIdKey(userId, workspaceId);
  if (!key) return;
  try {
    if (sessionId) window.localStorage.setItem(key, sessionId);
    else window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}
