// POST /api/assistant/classify-dump
//
// Single-purpose binary classifier: given a chat message that already
// tripped the client-side `looksLikeBrainDump` heuristic, decide whether
// it's actually a dump (capture intent) or just a multi-clause chat
// message that happened to look dump-like.
//
// Runs on Haiku 4.5 with max_tokens=5 — sub-cent per call, ~300ms latency.
// Only called when the heuristic fires, so most chat messages cost $0.
// On any failure we fall back to "yes, it's a dump" so the user still
// gets the chooser and never silently loses a dump.

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

import { AI_MODELS } from "@/lib/ai/config";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are a binary classifier for a personal productivity app's chat.

Decide whether the user's message is a BRAIN DUMP (the user is logging things they did, started, decided, finished, or want to capture — items destined for their graph) or CHAT (a question, advice request, hypothetical, brainstorm, vent, or any conversational message that should be answered, not captured).

DUMP markers
- Past-tense or committed-action statements: "started X", "enrolled in Y", "finished Z", "signed up for…"
- Lists of items/tasks/things to track: "fix auth, call mom, gym 3x"
- Explicit capture intent: "add a goal to ship by Sept", "track my job search…"

CHAT markers
- Questions: "what's blocking…", "why is…", "how do I…", "should I…"
- Advice / hypothetical: "thinking about enrolling…", "maybe I should…"
- Discussion of options: "Stanford vs Coursera?"
- Venting / emotional: "exhausted", "stressed", "feeling stuck"

Output EXACTLY one uppercase word with no punctuation, no explanation, no markdown: either DUMP or CHAT.`;

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No key configured — fall back to "treat it as a dump" so the chooser
    // still shows and the user keeps control. is_dump:true preserves intent.
    return NextResponse.json({ is_dump: true, fallback: "no_api_key" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { text } = body as { text?: string };
  if (typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  // Length cap: the heuristic only fires on >=60 char messages and even
  // very long dumps cap reasonably. Anything beyond 4000 chars truncate to
  // keep classifier input bounded and cheap.
  const trimmed = text.trim().slice(0, 4000);

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 5,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: trimmed }],
    });

    const raw =
      response.content[0]?.type === "text"
        ? response.content[0].text
        : "";
    const verdict = raw.trim().toUpperCase();
    const isDump = verdict.startsWith("DUMP");

    return NextResponse.json({ is_dump: isDump, verdict });
  } catch (err) {
    // Network / API error: fail-safe to is_dump:true so the user still gets
    // the chooser and can decide; never silently swallow a dump.
    return NextResponse.json({
      is_dump: true,
      fallback: err instanceof Error ? err.message : "classifier_failed",
    });
  }
}
