// Plain-question chat turns on Gemini Flash-Lite (see chat-router.ts).
//
// No tools: the model answers from the same graph snapshot the Claude
// assistant gets. It returns JSON whose FIRST field, needs_action, says
// whether the turn needs an action or data the snapshot doesn't show; then the
// chat route runs the normal Claude loop (tools). Only a needs_action=false
// reply reaches the user.
//
// Why a separate first field (2026-09-29): the old rule "reply with the single
// word HANDOFF" asks the model to NOT answer, and Flash-Lite answered anyway —
// on 20 "tell the app something" questions ("is it ok if I skip italian for a
// while?", "I bombed the midterm, is the final worth it?") it handed off 16/20,
// so 2 in 20 were silently lost after the router. Deciding first caught 20/20
// with 0/12 false hand-offs on plain questions (docs/ranking.md).
//
// One non-streaming call (a 1–3 sentence answer is ~1s), so the decision is
// always read before anything is sent; anything unreadable hands off — a miss
// costs one tiny call, never a wrong answer. REST directly: the installed
// @google/generative-ai SDK predates thinkingConfig. The function keeps its
// streaming-era name so the chat route is untouched.

import { AI_MODELS } from "./config";
import type { HistoryTurn } from "./chat-memory";
import { trimHistory } from "./chat-memory";
import { geminiCostUSD, type GeminiUsage } from "./usage";
import type { AssistantMode } from "@/types/ai";

export const ASSISTANT_QA_PROMPT_VERSION = "assistant-qa-v3";


const MODE_FOCUS: Record<AssistantMode, string> = {
  explain: "Focus: help them understand their graph — why things matter and what to weigh.",
  plan: "Focus: what to act on first and in what order. Name specific nodes; short numbered lists are fine when they ask what to do.",
  transform: "Focus: how their graph could be reshaped.",
};

export function buildQASystemPrompt(params: {
  mode: AssistantMode;
  todayLine: string;
  contextBlock: string;
}): string {
  return `You are the thinking partner inside BrainDump, the user's second brain: a graph of their goals, projects, tasks and habits. Many users have ADHD — be warm, direct and brief. Treat the user as a peer.

This turn you can only TALK. You cannot add, change, complete, schedule or look up anything. Answer from the Graph context below and the conversation.

First set needs_action. It is TRUE when:
- the user wants anything changed or recorded — add/capture, complete, archive, rename, move, connect, schedule, plan, prioritize ("make X my main thing", "can I skip X for a while");
- the user tells you ANY fact about their situation the graph doesn't show yet — something done, over, taken, passed, failed, handed in, approved, cancelled, dropped, a date that moved, what rides on it — even when the message is also a question ("now that the exam is over, what next?" → true);
- answering needs something the Graph context doesn't show: their calendar, what they did recently, a node's full description, what's inside a node, how nodes are connected (no connections are shown), or a node that isn't listed.
It is FALSE only for a pure question about what the Graph context already shows. When needs_action is true, leave reply empty.

When needs_action is false, reply:
- 1–3 sentences (under ~60 words): the answer, then at most one next step. Longer only when they ask for a breakdown or explanation — then short bullets.
- Refer to nodes by their exact titles. Never invent nodes, dates, deadlines or facts. Never show ids, and never quote the "importance N/100" numbers — they're the app's internal ranking.
- No preamble, no "great question", no restating their question, no menu of offers.
- Use their name rarely — at most in a greeting or an encouraging nudge, never to open an ordinary answer.
${MODE_FOCUS[params.mode]}${params.todayLine}

${params.contextBlock}`;
}

export type QAResult =
  | { kind: "answered"; text: string; usage: GeminiUsage; costUSD: number; model: string }
  | { kind: "handoff"; usage: GeminiUsage; costUSD: number; model: string }
  | { kind: "error"; error: string; usage: GeminiUsage; costUSD: number; model: string };

function thinkingConfig(model: string): Record<string, unknown> {
  // 2.5 Flash-Lite doesn't think unless asked; 3.x takes a level.
  return model.startsWith("gemini-2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
}

// needs_action first, then the reply (propertyOrdering) — the model commits
// to the decision before it starts answering.
const QA_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: { needs_action: { type: "BOOLEAN" }, reply: { type: "STRING" } },
  required: ["needs_action", "reply"],
  propertyOrdering: ["needs_action", "reply"],
};

/** The model's JSON → decision; null when it can't be read (→ hand off). */
export function parseQADecision(text: string): { needsAction: boolean; reply: string } | null {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed = JSON.parse((fenced ? fenced[1] : text).trim()) as { needs_action?: unknown; reply?: unknown };
    if (typeof parsed.needs_action !== "boolean") return null;
    return { needsAction: parsed.needs_action, reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "" };
  } catch {
    return null;
  }
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export async function streamQAAnswer(params: {
  apiKey: string;
  systemPrompt: string;
  history: HistoryTurn[];
  message: string;
  onText: (chunk: string) => void;
  signal?: AbortSignal;
  model?: string;
}): Promise<QAResult> {
  const model = params.model ?? AI_MODELS.GEMINI_CHAT_QA;
  const { turns } = trimHistory(params.history);
  const contents = [
    ...turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.body }] })),
    { role: "user", parts: [{ text: params.message }] },
  ];
  let usage: GeminiUsage = { prompt: 0, cached: 0, output: 0 };
  const result = <K extends QAResult["kind"]>(kind: K, extra: object = {}) =>
    ({ kind, usage, costUSD: geminiCostUSD(model, usage), model, ...extra }) as QAResult;

  let json: GenerateResponse;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": params.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1024,
          thinkingConfig: thinkingConfig(model),
          responseMimeType: "application/json",
          responseSchema: QA_RESPONSE_SCHEMA,
        },
      }),
      signal: params.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return result("error", { error: `gemini ${res.status}: ${body.slice(0, 300)}` });
    }
    json = (await res.json()) as GenerateResponse;
  } catch (err) {
    return result("error", { error: err instanceof Error ? err.message : String(err) });
  }

  const m = json.usageMetadata ?? {};
  usage = {
    prompt: m.promptTokenCount ?? 0,
    cached: m.cachedContentTokenCount ?? 0,
    output: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0),
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const decision = parseQADecision(text);
  // Unreadable, flagged, or an empty "answer" → Claude takes the turn.
  if (!decision || decision.needsAction || !decision.reply) return result("handoff");
  params.onText(decision.reply);
  return result("answered", { text: decision.reply });
}
