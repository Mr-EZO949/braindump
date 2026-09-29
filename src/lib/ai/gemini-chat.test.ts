import { afterEach, describe, expect, it, vi } from "vitest";

import { buildQASystemPrompt, parseQADecision, streamQAAnswer } from "./gemini-chat";

// A Gemini generateContent response whose text is `text`.
function reply(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 3000, cachedContentTokenCount: 1000, candidatesTokenCount: 60 },
    }),
    { status: 200 },
  );
}

async function run(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const sent: string[] = [];
  const result = await streamQAAnswer({
    apiKey: "test",
    systemPrompt: "sys",
    history: [],
    message: "what should I focus on?",
    onText: (t) => sent.push(t),
    model: "gemini-3.1-flash-lite",
  });
  return { result, sent: sent.join(""), fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("streamQAAnswer", () => {
  it("sends the answer when no action is needed, and prices it", async () => {
    const { result, sent } = await run(reply('{"needs_action": false, "reply": "Focus on the CV audit first."}'));
    expect(result.kind).toBe("answered");
    expect(sent).toBe("Focus on the CV audit first.");
    // 2000 fresh × $0.25 + 1000 cached × $0.025 + 60 out × $1.50, per 1M
    expect(result.costUSD).toBeCloseTo((2000 * 0.25 + 1000 * 0.025 + 60 * 1.5) / 1e6, 10);
  });

  it("hands off without sending anything when an action is needed", async () => {
    const { result, sent } = await run(reply('{"needs_action": true, "reply": ""}'));
    expect(result.kind).toBe("handoff");
    expect(sent).toBe("");
  });

  it("hands off even if the model also wrote an answer", async () => {
    const { result, sent } = await run(reply('{"needs_action": true, "reply": "Yes, that\'s fine."}'));
    expect(result.kind).toBe("handoff");
    expect(sent).toBe("");
  });

  it.each([["not json at all"], ['{"reply": "no decision field"}'], ['{"needs_action": false, "reply": "  "}']])(
    "hands off on anything it can't trust: %s",
    async (text) => {
      const { result, sent } = await run(reply(text));
      expect(result.kind).toBe("handoff");
      expect(sent).toBe("");
    },
  );

  it("asks for the decision before the reply", async () => {
    const { fetchMock } = await run(reply('{"needs_action": false, "reply": "ok"}'));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.propertyOrdering).toEqual(["needs_action", "reply"]);
  });

  it("reports upstream errors without sending anything", async () => {
    const { result, sent } = await run(new Response("overloaded", { status: 503 }));
    expect(result.kind).toBe("error");
    expect(sent).toBe("");
  });
});

describe("parseQADecision", () => {
  it("reads fenced JSON too", () => {
    expect(parseQADecision('```json\n{"needs_action": false, "reply": "Hi"}\n```')).toEqual({
      needsAction: false,
      reply: "Hi",
    });
  });
});

describe("buildQASystemPrompt", () => {
  it("defines when an action is needed, including facts inside questions", () => {
    const prompt = buildQASystemPrompt({ mode: "explain", todayLine: "", contextBlock: "Graph context" });
    expect(prompt).toContain("First set needs_action");
    expect(prompt).toContain("even when the message is also a question");
    expect(prompt).not.toContain("HANDOFF");
  });
});
