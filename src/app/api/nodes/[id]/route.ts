// PATCH /api/nodes/[id]
// Server-validated node field updates from the reading-view editor. Currently
// handles the markdown `body` (autosaved from the TipTap editor). Body is stored
// as raw markdown — sanitization happens on RENDER (rehype-sanitize), never on
// write, so round-tripping never mangles the user's text.
//
// There is deliberately NO product length cap on body (a node write-up can be
// arbitrarily long). MAX_BODY_CHARS is only an abuse guard against a
// pathological payload, set far above any realistic write-up.

import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

const MAX_BODY_CHARS = 200_000;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "Expected an object" }, { status: 400 });
  }

  const update: { body?: string | null; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };

  if ("body" in payload) {
    const rawBody = (payload as { body: unknown }).body;
    if (rawBody !== null && typeof rawBody !== "string") {
      return NextResponse.json({ error: "body must be a string or null" }, { status: 400 });
    }
    if (typeof rawBody === "string" && rawBody.length > MAX_BODY_CHARS) {
      return NextResponse.json(
        { error: `body exceeds ${MAX_BODY_CHARS} characters` },
        { status: 413 },
      );
    }
    const trimmed = typeof rawBody === "string" ? rawBody.trim() : null;
    update.body = trimmed && trimmed.length > 0 ? trimmed : null;
  }

  // Nothing to change beyond the timestamp — treat as a no-op success.
  if (!("body" in update)) {
    return NextResponse.json({ error: "No supported fields to update" }, { status: 400 });
  }

  // RLS also scopes this to the owner; the explicit user_id match is defense in
  // depth and lets us distinguish "not yours / missing" (0 rows) from success.
  const { data, error } = await supabase
    .from("nodes")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, updated_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, updated_at: (data as { updated_at: string }).updated_at });
}
