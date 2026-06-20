// Temporal awareness for the assistant chat.
//
// Surfaces a single "you keep coming back to this" flag derived entirely from
// existing data — node-scoped chat_sessions (timestamps + counts) joined to the
// node's live status. No mention-log table, no emit logic, no cron.
//
// "Circling" means a SPECIFIC thing, tightened after review to avoid nagging
// (the cardinal sin for an ADHD-paralysis tool):
//   - the node is the one the user is currently focused on (scope), and
//   - they've opened >= 2 separate chats about it (genuinely *returned*), and
//   - those chats span >= 3 days (it's been dragging), and
//   - the latest one was recent (<= 14 days — still live, not a relic), and
//   - the node isn't completed/archived.
//
// The flag is injected into the per-turn (uncached) message block so it can
// change without busting the cached system prompt / graph context.
//
// Known v1 limitation: we don't yet consult lifecycle_events for *progress* —
// a node the user is actively completing subtasks on could still flag if they
// also chat about it a lot. Acceptable for v1; revisit if it nags in practice.

import type { SupabaseClient } from "@supabase/supabase-js";

const STALL_SPAN_DAYS = 3; // first→last chat spans at least this long
const STALL_RECENCY_DAYS = 14; // ...and the latest chat is at most this old
const STALL_MIN_SESSIONS = 2; // ...across this many separate chats (genuinely returned)
const DAY_MS = 86_400_000;

export interface SessionRow {
  scope_node_id: string | null;
  created_at: string;
  last_message_at: string | null;
  message_count: number | null;
}

export interface StallPick {
  nodeId: string;
  days: number; // span from first to last chat, in days
  sessions: number;
}

// Pure: decide whether the user is circling `selectedNodeId` based on their
// chats about it. Returns null unless a node is in scope and qualifies — we
// never surface a node the user isn't currently looking at.
export function pickStallingNode(
  rows: SessionRow[],
  nowMs: number,
  selectedNodeId: string | null,
): StallPick | null {
  if (!selectedNodeId) return null;

  let sessions = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    if (r.scope_node_id !== selectedNodeId) continue;
    const created = Date.parse(r.created_at);
    if (Number.isNaN(created)) continue;
    const lmRaw = r.last_message_at ? Date.parse(r.last_message_at) : created;
    const lastMsg = Number.isNaN(lmRaw) ? created : lmRaw;
    sessions += 1;
    first = Math.min(first, created);
    last = Math.max(last, lastMsg);
  }
  if (sessions === 0) return null;

  const spanDays = (last - first) / DAY_MS;
  const recencyDays = (nowMs - last) / DAY_MS;
  if (
    sessions >= STALL_MIN_SESSIONS &&
    spanDays >= STALL_SPAN_DAYS &&
    recencyDays >= 0 &&
    recencyDays <= STALL_RECENCY_DAYS
  ) {
    return { nodeId: selectedNodeId, days: Math.round(spanDays), sessions };
  }
  return null;
}

// Returns a short flag string to prepend to the user turn, or "" if nothing to
// surface. Only queries when a node is in scope, so workspace chats cost zero
// DB calls. No AI.
export async function getTemporalFlag(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  selectedNodeId: string | null,
  nowMs: number = Date.now(),
): Promise<string> {
  if (!selectedNodeId) return ""; // only ever flag the node the user is on

  const { data: sessions } = await supabase
    .from("chat_sessions")
    .select("scope_node_id, created_at, last_message_at, message_count")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("scope_kind", "node")
    .eq("scope_node_id", selectedNodeId);

  const pick = pickStallingNode((sessions ?? []) as SessionRow[], nowMs, selectedNodeId);
  if (!pick) return "";

  const { data: node } = await supabase
    .from("nodes")
    .select("title, status")
    .eq("id", pick.nodeId)
    .eq("user_id", userId)
    .single();
  if (!node) return "";
  const status = (node.status as string | null) ?? "active";
  if (status === "completed" || status === "archived") return "";

  return `[Temporal note — for your awareness; raise it only if the user seems stuck, don't force it] The user has come back to "${node.title}" in ${pick.sessions} separate chats over ${pick.days} days and still hasn't finished it. If it fits, it's fair to gently name that pattern and offer to break it into one concrete first step (or pick one for them).`;
}
