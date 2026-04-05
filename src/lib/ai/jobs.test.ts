import { describe, expect, it } from "vitest";

import { buildAIJobIdempotencyKey, nextAIJobDelayMs } from "./jobs";

describe("buildAIJobIdempotencyKey", () => {
  it("is stable when object keys are reordered", () => {
    const first = buildAIJobIdempotencyKey("connection_batch", {
      workspace_id: "ws1",
      node_ids: ["node-1", "node-2"],
      meta: {
        source: "acceptance",
        retry: false,
      },
    });

    const second = buildAIJobIdempotencyKey("connection_batch", {
      meta: {
        retry: false,
        source: "acceptance",
      },
      node_ids: ["node-1", "node-2"],
      workspace_id: "ws1",
    });

    expect(first).toBe(second);
  });

  it("changes when the payload changes", () => {
    const first = buildAIJobIdempotencyKey("score_recompute", {
      workspace_id: "ws1",
    });
    const second = buildAIJobIdempotencyKey("score_recompute", {
      workspace_id: "ws2",
    });

    expect(first).not.toBe(second);
  });
});

describe("nextAIJobDelayMs", () => {
  it("grows exponentially for early attempts", () => {
    expect(nextAIJobDelayMs(0)).toBe(1_000);
    expect(nextAIJobDelayMs(1)).toBe(2_000);
    expect(nextAIJobDelayMs(2)).toBe(4_000);
  });

  it("caps the retry delay at 60 seconds", () => {
    expect(nextAIJobDelayMs(10)).toBe(60_000);
  });
});
