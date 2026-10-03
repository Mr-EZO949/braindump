// POST /api/nodes/suggest-steps — the Details panel's Quick steps / AI roadmap,
// and the "N items look ready for a next step" picker.
//
// ONE model call per item: the step-writer (lib/ai/step-writer.ts) — the same
// one chat's write_steps uses, so the button and "break X into steps" in chat
// write the same steps. Quick steps = the next 1–3 actions on Haiku; AI
// roadmap = phases + steps on Sonnet. Until 2026-10-03 Haiku wrote
// brain-dump text that a second (Sonnet) extraction turned into proposals for
// the old review modal (fix list #8).
//
// The steps aren't applied: they wait as ONE Suggested card, parked like a
// dump's waiting changes (pending_chat_runs, origin "steps"), which the client
// shows in a fresh chat thread. Accept goes through the usual resume endpoint
// and no model ever continues that thread.

import { NextRequest, NextResponse } from "next/server";

import { writeSteps, type StepShape } from "@/lib/ai/step-writer";
import type { BuildPlanInput } from "@/lib/ai/tools/apply-plan";
import { WRITE_STEPS_TOOL } from "@/lib/ai/tools/steps";
import type { ChangeOp } from "@/lib/graph/change-set";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getRequestToday } from "@/lib/time/request-date";

const MAX_NODES = 8;
const MAX_INSTRUCTIONS_CHARS = 500;
// The card sits in the thread; a chat card's 15 minutes is too short.
const CARD_TTL_MS = 24 * 60 * 60 * 1000;

function namesOf(titles: string[]): string {
  const quoted = titles.map((t) => `“${t}”`);
  return quoted.length <= 2 ? quoted.join(" and ") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
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
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { node_ids, workspace_id, mode, instructions } = body as {
    node_ids?: unknown;
    workspace_id?: unknown;
    mode?: unknown;
    instructions?: unknown;
  };
  const ids = Array.isArray(node_ids)
    ? [...new Set(node_ids.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, MAX_NODES)
    : [];
  if (ids.length === 0 || typeof workspace_id !== "string" || !workspace_id) {
    return NextResponse.json({ error: "node_ids and workspace_id are required" }, { status: 400 });
  }
  const shape: StepShape = mode === "light" ? "next" : "roadmap";
  // The user's directions for this breakdown, from the Details panel.
  const words = typeof instructions === "string" ? instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS) : "";

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const today = await getRequestToday();
  const written = await Promise.all(
    ids.map((nodeId, i) =>
      writeSteps({
        supabase,
        userId: user.id,
        workspaceId: workspace_id,
        today,
        target: { node_id: nodeId },
        shape,
        words,
        // A client cancel stops the model call instead of billing for it.
        signal: req.signal,
        source: "suggest-steps",
        refPrefix: ids.length > 1 ? `s${i + 1}_` : "",
      }),
    ),
  );
  const ok = written.flatMap((w) => (w.ok ? [w] : []));
  if (ok.length === 0) {
    const failed = written.find((w) => !w.ok);
    return NextResponse.json(
      { error: failed && !failed.ok ? failed.error : "No steps generated" },
      { status: req.signal.aborted ? 499 : 502 },
    );
  }
  const changes: ChangeOp[] = ok.flatMap((w) => w.ops);
  const label = `${shape === "next" ? "Next steps for" : "A roadmap for"} ${namesOf(ok.map((w) => w.title))}${words ? ` — ${words}` : ""}`;

  // Parked like a dump's waiting changes: the resume endpoint applies the
  // rows the user keeps; nothing else continues this thread.
  const toolUseId = `steps_${crypto.randomUUID()}`;
  const toolInput: BuildPlanInput = { changes, origin: "steps", suggested: true };
  const { data: runRow, error: runError } = await supabase
    .from("pending_chat_runs")
    .insert({
      user_id: user.id,
      workspace_id,
      selected_node_id: ids.length === 1 ? ids[0] : null,
      mode: "explain",
      messages: [
        { role: "user", content: [{ type: "text", text: `User question: ${label}` }] },
        { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: WRITE_STEPS_TOOL, input: {} }] },
      ],
      pending_tool_use_id: toolUseId,
      pending_tool_name: WRITE_STEPS_TOOL,
      pending_tool_input: toolInput,
      expires_at: new Date(Date.now() + CARD_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (runError || !runRow) {
    console.warn("[suggest-steps] could not park the steps card:", runError?.message);
    return NextResponse.json({ error: "Could not prepare the steps card." }, { status: 500 });
  }

  console.log("[suggest-steps]", { shape, nodes: ids.length, written: ok.length, ops: changes.length });
  return NextResponse.json({
    label,
    // Items it couldn't write steps for (the rest are on the card).
    skipped: written.flatMap((w) => (w.ok ? [] : [w.error])),
    pending_action: {
      run_id: runRow.id as string,
      tool_use_id: toolUseId,
      tool_name: WRITE_STEPS_TOOL,
      tool_input: toolInput,
    },
  });
}
