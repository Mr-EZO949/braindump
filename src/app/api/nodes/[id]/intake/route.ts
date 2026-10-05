// POST /api/nodes/[id]/intake  { workspace_id, reason: "created" | "edited" }
// A node made or edited by hand gets what an AI-made node gets (#25,
// 2026-10-05; lib/graph/node-intake.ts). The browser writes the row first and
// calls this without waiting, so the save stays instant.
//   created → embedding + accept event + judgment → rescore (once per node)
//   edited  → embedding again (the browser calls it only when the title or
//             summary changed in words, node-draft.ts embeddingTextChanged)

import { NextRequest, NextResponse } from "next/server";

import { intakeHandMadeNode, reembedNodes } from "@/lib/graph/node-intake";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestToday } from "@/lib/time/request-date";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid node id" }, { status: 400 });
  }

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

  let body: { workspace_id?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
  if (!UUID_RE.test(workspaceId)) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }
  if (body.reason !== "created" && body.reason !== "edited") {
    return NextResponse.json({ error: "reason must be created or edited" }, { status: 400 });
  }

  // RLS scopes every read and write to this user; the helpers also match
  // user_id + workspace_id, so a node from elsewhere comes back not_found.
  const scope = { supabase, userId: user.id, workspaceId };

  if (body.reason === "edited") {
    const count = await reembedNodes(scope, [id]);
    if (count === 0) return NextResponse.json({ error: "Node not found" }, { status: 404 });
    return NextResponse.json({ ok: true, embedded: count });
  }

  const outcome = await intakeHandMadeNode(scope, id, await getRequestToday());
  if (outcome.status === "not_found") return NextResponse.json({ error: "Node not found" }, { status: 404 });
  // The workspace's new scores — the browser resizes its nodes from them.
  const scores =
    outcome.status === "done"
      ? outcome.scores.map((s) => ({
          id: s.id,
          current_importance_score: s.current_importance_score,
          importance_index: s.importance_index,
          importance: s.importance,
          importance_reason: s.importance_reason,
        }))
      : [];
  return NextResponse.json({ ok: true, intake: outcome.status, scores });
}
