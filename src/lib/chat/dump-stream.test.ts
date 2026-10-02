import { describe, expect, it } from "vitest";

import { readDumpResponse, type DumpStage } from "./dump-stream";

function ndjson(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}

describe("readDumpResponse", () => {
  it("reports each stage, then returns the result — even when lines arrive split", async () => {
    const stages: DumpStage[] = [];
    const out = await readDumpResponse(
      ndjson(['{"stage":"reading"}\n{"stage":"buil', 'ding"}\n', '{"stage":"applying"}\n{"status":200,"result":{"status":"completed"}}\n']),
      (stage) => stages.push(stage),
    );
    expect(stages).toEqual(["reading", "building", "applying"]);
    expect(out).toEqual({ status: 200, data: { status: "completed" } });
  });

  it("passes a failure status through", async () => {
    const out = await readDumpResponse(ndjson(['{"status":207,"result":{"error":"busy"}}\n']), () => undefined);
    expect(out).toEqual({ status: 207, data: { error: "busy" } });
  });

  it("a stream that ends without its result is a failure", async () => {
    const out = await readDumpResponse(ndjson(['{"stage":"reading"}\n']), () => undefined);
    expect(out.status).toBe(500);
  });

  it("a plain JSON answer still works", async () => {
    const res = new Response(JSON.stringify({ status: "completed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    expect(await readDumpResponse(res, () => undefined)).toEqual({ status: 200, data: { status: "completed" } });
  });
});
