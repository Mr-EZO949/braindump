// POST /api/assistant/classify-size
//
// Single-purpose binary classifier: given a task title that the cheap
// heuristic (lib/ai/sizing.ts) couldn't decide ('ambiguous'), decide whether
// it fits in one focused sitting (TASK) or is a multi-step endeavour
// (PROJECT) worth offering to break down.
//
// Runs on Haiku 4.5 with max_tokens=5 — sub-cent per call, ~300ms latency.
// Only called on the 'ambiguous' bucket, so most creations cost $0.
// On any failure we fall back to "task" — promoting a real task to a project
// by mistake is worse (it interrupts capture and invites orphan children)
// than leaving a borderline project as a task.

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

import { AI_MODELS } from "@/lib/ai/config";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You decide if a task title fits in ONE focused sitting under 2 hours.

TASK = a single concrete action a user can finish in under 2 hours (call mom, fix an off-by-one in pagination, draft a tweet, book a flight).
PROJECT = anything multi-step, multi-day, requiring research, or with a vague goal (learn Italian, build auth, redesign onboarding, plan the quarter).

Output EXACTLY one uppercase word with no punctuation, no explanation, no markdown: either TASK or PROJECT.`;

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
    // No key configured — fall back to "task" so creation proceeds without
    // a spurious break-it-down prompt.
    return NextResponse.json({ size: "task", fallback: "no_api_key" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { title } = body as { title?: string };
  if (typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const trimmed = title.trim().slice(0, 200);

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
      response.content[0]?.type === "text" ? response.content[0].text : "";
    const verdict = raw.trim().toUpperCase();
    const size = verdict.startsWith("PROJECT") ? "project" : "task";

    return NextResponse.json({ size, verdict });
  } catch (err) {
    // Network / API error: fail-safe to "task" so creation never stalls.
    return NextResponse.json({
      size: "task",
      fallback: err instanceof Error ? err.message : "classifier_failed",
    });
  }
}
