import { describe, expect, it } from "vitest";

import type { ProposedEdgeWithNodes } from "@/lib/ai/connection";

import { buildAnalysisNotice, connectionsCardFromEdges, normalizeNodeIds } from "./connection-analysis";

const proposed = { id: "pe", source_title: "A", target_title: "B", edge_type: "supports", explanation: "" } as ProposedEdgeWithNodes;

describe("buildAnalysisNotice", () => {
  it("shows the server's warning first", () => {
    expect(buildAnalysisNotice({ warning: "  slow  ", failed: 2 })).toEqual({ tone: "warning", message: "slow" });
  });

  it("explains failures, partial or total", () => {
    expect(buildAnalysisNotice({ failed: 1, proposed_edges: [proposed] })?.message).toBe(
      "Some connection checks failed (1), but partial results are still shown.",
    );
    expect(buildAnalysisNotice({ failed: 1 })?.message).toBe("Connection analysis failed for 1 item. Retry when ready.");
    expect(buildAnalysisNotice({ failed: 3 })?.message).toBe("Connection analysis failed for 3 items. Retry when ready.");
  });

  it("is quiet when everything worked", () => {
    expect(buildAnalysisNotice({ proposed: 2, warning: "   " })).toBeNull();
  });
});

describe("connectionsCardFromEdges", () => {
  it("turns proposals into an awaiting card", () => {
    expect(connectionsCardFromEdges([proposed])).toEqual({
      status: "awaiting",
      edges: [{ id: "pe", sourceTitle: "A", targetTitle: "B", edgeType: "supports", explanation: null }],
    });
  });
});

describe("normalizeNodeIds", () => {
  it("dedupes and drops empty ids", () => {
    expect(normalizeNodeIds(["a", "", "b", "a"])).toEqual(["a", "b"]);
  });
});
