// Plain-question chat turns on Gemini Flash-Lite (see chat-router.ts).
//
// No tools: the model answers from the same graph snapshot the Claude
// assistant gets, and replies with the single word HANDOFF when the turn needs
// an action or data the snapshot doesn't show. The chat route then runs the
// normal Claude loop, so a routing miss costs one small call, never a wrong or
// missing action. The first few characters are held back until we know the
// reply isn't a hand-off, so HANDOFF never reaches the user.
//
// Streams over the REST SSE endpoint directly: the installed
// @google/generative-ai SDK predates thinkingConfig.

import { AI_MODELS } from "./config";
import type { HistoryTurn } from "./chat-memory";
import { trimHistory } from "./chat-memory";
import { geminiCostUSD, type GeminiUsage } from "./usage";
import type { AssistantMode } from "@/types/ai";

export const ASSISTANT_QA_PROMPT_VERSION = "assistant-qa-v2";

const HANDOFF = "HANDOFF";

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

Reply with exactly the single word ${HANDOFF} and nothing else when:
- the user wants anything changed or recorded — add/capture, complete, archive, rename, move, connect, schedule, plan — or reports something they did or decided, or how something went or changed (an exam taken, a result in, something over, moved, postponed or dropped);
- answering needs something the Graph context doesn't show: their calendar, what they did recently, a node's full description, what's inside a node, how nodes are connected (no connections are shown), or a node that isn't listed.

Otherwise answer:
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

interface StreamChunk {
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

  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": params.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: params.systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: thinkingConfig(model) },
        }),
        signal: params.signal,
      },
    );
  } catch (err) {
    return result("error", { error: err instanceof Error ? err.message : String(err) });
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    return result("error", { error: `gemini ${res.status}: ${body.slice(0, 300)}` });
  }

  // Hold output until it can't be a hand-off: the reply either starts with
  // HANDOFF or, once it has diverged from it, is released as it streams.
  let text = "";
  let released = false;
  const release = () => {
    if (!released && text) params.onText(text);
    released = true;
  };
  const isHandoff = () => text.trim().toUpperCase().startsWith(HANDOFF);
  const couldBeHandoff = () => {
    const head = text.trimStart().toUpperCase();
    return HANDOFF.startsWith(head) || head.startsWith(HANDOFF);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        const m = chunk.usageMetadata;
        if (m) {
          usage = {
            prompt: m.promptTokenCount ?? usage.prompt,
            cached: m.cachedContentTokenCount ?? usage.cached,
            output: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0) || usage.output,
          };
        }
        const piece = (chunk.candidates?.[0]?.content?.parts ?? [])
          .filter((p) => !p.thought && typeof p.text === "string")
          .map((p) => p.text)
          .join("");
        if (!piece) continue;
        if (released) {
          params.onText(piece);
          text += piece;
          continue;
        }
        text += piece;
        if (!couldBeHandoff()) release();
      }
    }
  } catch (err) {
    if (released) return result("answered", { text });
    return result("error", { error: err instanceof Error ? err.message : String(err) });
  }

  if (!released) {
    if (!text.trim()) return result("error", { error: "empty reply" });
    if (isHandoff()) return result("handoff");
  }
  release();
  return result("answered", { text });
}
