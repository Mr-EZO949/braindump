import { describe, expect, it } from "vitest";

import { parseJudgmentResponse } from "./judgment";

describe("parseJudgmentResponse (short refs)", () => {
  const idByRef = new Map([
    ["n1", "uuid-1"],
    ["n2", "uuid-2"],
  ]);

  it("maps refs back to node ids, clamps and rounds scores", () => {
    const out = parseJudgmentResponse(
      '{"results":[{"ref":"n1","score":91.6,"reason":"Top goal"},{"ref":"n2","score":140,"reason":"x"}]}',
      idByRef,
    );
    expect(out).toEqual([
      { node_id: "uuid-1", score: 92, reason: "Top goal" },
      { node_id: "uuid-2", score: 100, reason: "x" },
    ]);
  });

  it("tolerates code fences and drops unknown refs", () => {
    const out = parseJudgmentResponse(
      '```json\n{"results":[{"ref":"n9","score":50,"reason":"?"},{"ref":"n2","score":40,"reason":"ok"}]}\n```',
      idByRef,
    );
    expect(out).toEqual([{ node_id: "uuid-2", score: 40, reason: "ok" }]);
  });

  it("throws on truncated JSON so the caller logs a failure", () => {
    expect(() => parseJudgmentResponse('{"results":[{"ref":"n1","score":9', idByRef)).toThrow();
  });
});
