// GET  /api/chat/sessions?workspace_id=...   → list recent sessions (metadata only)
// POST /api/chat/sessions                    → upsert a session (create or replace messages)

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/types/chat";

const MAX_MESSAGES_PER_SESSION = 500;
const TITLE_MAX = 120;

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.body.trim().length > 0);
  const raw = firstUser?.body?.trim() ?? "";
  if (!raw) return "New conversation";
  const oneLine = raw.replace(/\s+/g, " ");
  return oneLine.length <= TITLE_MAX ? oneLine : oneLine.slice(0, TITLE_MAX - 1) + "…";
}

export async function GET(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaceId = req.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("chat_sessions")
    .select(
      "id, workspace_id, scope_kind, scope_node_id, title, message_count, last_message_at, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .gt("message_count", 0)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ sessions: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    id = null,
    workspace_id,
    scope_kind = "workspace",
    scope_node_id = null,
    messages = [],
  } = body as {
    id?: string | null;
    workspace_id: string;
    scope_kind?: "workspace" | "node";
    scope_node_id?: string | null;
    messages?: ChatMessage[];
  };

  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  if (scope_kind !== "workspace" && scope_kind !== "node") {
    return NextResponse.json({ error: "Invalid scope_kind" }, { status: 400 });
  }
  if (!Array.isArray(messages)) {
    return NextResponse.json({ error: "messages must be an array" }, { status: 400 });
  }

  const trimmed = messages.slice(-MAX_MESSAGES_PER_SESSION);
  const lastMsg = trimmed[trimmed.length - 1];

  const row = {
    user_id: user.id,
    workspace_id,
    scope_kind,
    scope_node_id: scope_node_id ?? null,
    title: deriveTitle(trimmed),
    messages: trimmed,
    message_count: trimmed.length,
    last_message_at: lastMsg?.createdAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { data, error } = await supabase
      .from("chat_sessions")
      .update(row)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id, title, message_count, last_message_at, updated_at")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session: data });
  }

  const { data, error } = await supabase
    .from("chat_sessions")
    .insert(row)
    .select("id, title, message_count, last_message_at, created_at, updated_at")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });
  }
  return NextResponse.json({ session: data });
}
