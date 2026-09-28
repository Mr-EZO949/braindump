import { afterEach, describe, expect, it, vi } from "vitest";

import { streamQAAnswer } from "./gemini-chat";

// A Gemini SSE response that streams `pieces`, with usage on the last chunk.
function sse(pieces: string[]): Response {
  const lines = pieces.map((text, i) => {
    const chunk: Record<string, unknown> = { candidates: [{ content: { parts: [{ text }] } }] };
    if (i === pieces.length - 1) {
      chunk.usageMetadata = { promptTokenCount: 3000, cachedContentTokenCount: 1000, candidatesTokenCount: 60 };
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  });
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function run(pieces: string[] | Response) {
  vi.stubGlobal("fetch", vi.fn(async () => (pieces instanceof Response ? pieces : sse(pieces))));
  const sent: string[] = [];
  const result = await streamQAAnswer({
    apiKey: "test",
    systemPrompt: "sys",
    history: [],
    message: "what should I focus on?",
    onText: (t) => sent.push(t),
    model: "gemini-3.1-flash-lite",
  });
  return { result, sent: sent.join("") };
}

afterEach(() => vi.unstubAllGlobals());

describe("streamQAAnswer", () => {
  it("streams an answer and prices it", async () => {
    const { result, sent } = await run(["Focus on ", "the CV audit ", "first."]);
    expect(result.kind).toBe("answered");
    expect(sent).toBe("Focus on the CV audit first.");
    // 2000 fresh × $0.25 + 1000 cached × $0.025 + 60 out × $1.50, per 1M
    expect(result.costUSD).toBeCloseTo((2000 * 0.25 + 1000 * 0.025 + 60 * 1.5) / 1e6, 10);
  });

  it("never shows a hand-off, even when it arrives split across chunks", async () => {
    const { result, sent } = await run(["HAND", "OFF"]);
    expect(result.kind).toBe("handoff");
    expect(sent).toBe("");
  });

  it("treats HANDOFF followed by an explanation as a hand-off", async () => {
    const { result, sent } = await run(["HANDOFF\n", "The user wants to add a task."]);
    expect(result.kind).toBe("handoff");
    expect(sent).toBe("");
  });

  it("releases held text once it diverges from HANDOFF", async () => {
    const { result, sent } = await run(["Han", "g in there — start with the CV."]);
    expect(result.kind).toBe("answered");
    expect(sent).toBe("Hang in there — start with the CV.");
  });

  it("reports upstream errors without sending anything", async () => {
    const { result, sent } = await run(new Response("overloaded", { status: 503 }));
    expect(result.kind).toBe("error");
    expect(sent).toBe("");
  });
});
