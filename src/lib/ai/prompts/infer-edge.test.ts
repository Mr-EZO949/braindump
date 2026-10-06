import { describe, expect, it } from "vitest";

import { validateEdgeInferenceOutput } from "../validation";
import { buildEdgeInferencePromptParts, INFER_EDGE_PROMPT_VERSION } from "./infer-edge";

const node = (id: string, title: string, node_type = "task") => ({ id, title, summary: null, node_type });

// Two sources; "b" is a source AND one of "a"'s candidates.
const parts = buildEdgeInferencePromptParts({
  sources: [
    { source_node: { ...node("a", "Linear Algebra Review", "big_task"), has_parent: true }, candidates: [node("b", "Learn PyTorch", "project"), node("c", "Machine Learning", "class")] },
    { source_node: { ...node("b", "Learn PyTorch", "project"), has_parent: false }, candidates: [node("c", "Machine Learning", "class")] },
  ],
});

describe("infer-edge-v8 prompt", () => {
  it("lists every node once by ref and each source with its candidates", () => {
    expect(parts.variableBlock).toContain('n1 [big task] "Linear Algebra Review"');
    expect(parts.variableBlock.match(/"Learn PyTorch"/g)).toHaveLength(1);
    expect(parts.variableBlock).toContain("n1 (has a parent — no belongs_to) → n2, n3");
    expect(parts.variableBlock).toContain("n2 (no parent yet — belongs_to allowed) → n3");
    expect(parts.variableBlock).not.toContain('"a"');
    expect(parts.refs.idByRef.get("n3")).toBe("c");
  });
});

describe("validateEdgeInferenceOutput (v8)", () => {
  it("maps refs back to ids and keeps only asked pairs", () => {
    const out = validateEdgeInferenceOutput(
      {
        checks: {
          n1: {
            n2: "none",
            n3: { type: "supports", from: "node", confidence: 0.9, why: "Needed for the ML maths." },
            n9: { type: "supports", from: "node", confidence: 0.9, why: "unknown ref" },
          },
          // filed under the other node: n3 → n2 with from "other" = b → c
          n3: {
            n2: { type: "supports", from: "other", confidence: 0.8, why: "x" },
            n1: { type: "supports", from: "node", confidence: 0.8, why: "dup of the first" },
          },
          // b was asked about a only from a's side
          n2: { n1: { type: "related_to", from: "node", confidence: 0.7, why: "asked the other way only" } },
        },
      },
      parts.refs,
    );
    expect(out.prompt_version).toBe(INFER_EDGE_PROMPT_VERSION);
    expect(out.results).toEqual([
      { source_id: "a", candidate_id: "c", related: true, edge_type: "supports", from: "source", confidence: 0.9, explanation: "Needed for the ML maths." },
      { source_id: "b", candidate_id: "c", related: true, edge_type: "supports", from: "source", confidence: 0.8, explanation: "x" },
      // turned back, direction kept (b → a = candidate → source)
      { source_id: "a", candidate_id: "b", related: true, edge_type: "related_to", from: "candidate", confidence: 0.7, explanation: "asked the other way only" },
    ]);
  });

  it("falls back to related_to for an unknown type and needs a checks object", () => {
    const out = validateEdgeInferenceOutput({ checks: { n1: { n2: { type: "useful_for_x", confidence: 2 } } } }, parts.refs);
    expect(out.results[0]).toMatchObject({ edge_type: "related_to", confidence: 1, explanation: "", from: "source" });
    expect(() => validateEdgeInferenceOutput({ results: [] }, parts.refs)).toThrow();
  });
});
