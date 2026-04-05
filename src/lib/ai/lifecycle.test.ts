import { describe, expect, it } from "vitest";

import { deriveEdgeDecayState } from "./lifecycle";

describe("deriveEdgeDecayState", () => {
  const now = new Date("2026-04-03T12:00:00.000Z");

  it("keeps active edges at full strength when neither node is completed", () => {
    expect(
      deriveEdgeDecayState({
        now,
        sourceCompletedAt: null,
        targetCompletedAt: null,
      }),
    ).toEqual({
      decayFactor: 1,
      derivedStatus: "active",
      stale: false,
    });
  });

  it("decays edges between one completed and one active node more slowly", () => {
    const state = deriveEdgeDecayState({
      now,
      sourceCompletedAt: "2026-03-10T12:00:00.000Z",
      targetCompletedAt: null,
    });

    expect(state.derivedStatus).toBe("decayed");
    expect(state.decayFactor).toBeGreaterThan(0.18);
    expect(state.decayFactor).toBeLessThan(1);
  });

  it("decays edges between two completed nodes faster than one completed node", () => {
    const oneCompleted = deriveEdgeDecayState({
      now,
      sourceCompletedAt: "2026-03-10T12:00:00.000Z",
      targetCompletedAt: null,
    });
    const bothCompleted = deriveEdgeDecayState({
      now,
      sourceCompletedAt: "2026-03-10T12:00:00.000Z",
      targetCompletedAt: "2026-03-09T12:00:00.000Z",
    });

    expect(bothCompleted.decayFactor).toBeLessThan(oneCompleted.decayFactor);
    expect(bothCompleted.derivedStatus).toBe("decayed");
  });

  it("preserves orphaned edges as stale with zero weight", () => {
    expect(
      deriveEdgeDecayState({
        now,
        sourceCompletedAt: "2026-03-10T12:00:00.000Z",
        edgeStatus: "orphaned",
      }),
    ).toEqual({
      decayFactor: 0,
      derivedStatus: "orphaned",
      stale: true,
    });
  });
});
