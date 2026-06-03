import { describe, expect, it } from "vitest";

import { deriveEdgeDecayState } from "./lifecycle";

const NOW = new Date("2026-04-03T12:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * ONE_DAY_MS).toISOString();

describe("deriveEdgeDecayState", () => {
  it("keeps active edges at full strength when neither node is completed", () => {
    expect(
      deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: null,
        targetCompletedAt: null,
      }),
    ).toEqual({
      decayFactor: 1,
      derivedStatus: "active",
      stale: false,
    });
  });

  it("preserves orphaned edges as stale with zero weight", () => {
    expect(
      deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(10),
        edgeStatus: "orphaned",
      }),
    ).toEqual({
      decayFactor: 0,
      derivedStatus: "orphaned",
      stale: true,
    });
  });

  it("preserves user_rejected edges as stale with zero weight", () => {
    expect(
      deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(10),
        edgeStatus: "user_rejected",
      }),
    ).toEqual({
      decayFactor: 0,
      derivedStatus: "user_rejected",
      stale: true,
    });
  });

  // ── ONE_SIDED profile (one endpoint completed) ─────────────────────────
  describe("ONE_SIDED profile", () => {
    it("stays at full strength inside the start window", () => {
      const state = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(2), // < startDays (3)
        targetCompletedAt: null,
      });
      expect(state.decayFactor).toBe(1);
      expect(state.derivedStatus).toBe("active");
      expect(state.stale).toBe(false);
    });

    it("decays partway through the ramp", () => {
      // Halfway between startDays (3) and fullDays (40) is day ~21.5.
      // At that point factor should be ~midpoint between 1 and 0.2 = 0.6.
      const state = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(22),
        targetCompletedAt: null,
      });
      expect(state.derivedStatus).toBe("decayed");
      expect(state.decayFactor).toBeGreaterThan(0.5);
      expect(state.decayFactor).toBeLessThan(0.7);
    });

    it("reaches the 0.20 floor at or past fullDays", () => {
      const state = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(45), // > fullDays (40)
        targetCompletedAt: null,
      });
      expect(state.decayFactor).toBe(0.2);
      expect(state.stale).toBe(true);
    });

    it("treats target-only completion the same as source-only", () => {
      const sourceOnly = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(15),
        targetCompletedAt: null,
      });
      const targetOnly = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: null,
        targetCompletedAt: daysAgo(15),
      });
      expect(targetOnly.decayFactor).toBe(sourceOnly.decayFactor);
    });
  });

  // ── FULLY_RESOLVED profile (both endpoints completed) ──────────────────
  describe("FULLY_RESOLVED profile", () => {
    it("fades faster than ONE_SIDED at the same elapsed time", () => {
      const both = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(10),
        targetCompletedAt: daysAgo(11),
      });
      const one = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(10),
        targetCompletedAt: null,
      });
      expect(both.decayFactor).toBeLessThan(one.decayFactor);
    });

    it("reaches the 0.05 floor at or past fullDays (18)", () => {
      const state = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(20),
        targetCompletedAt: daysAgo(20),
      });
      expect(state.decayFactor).toBe(0.05);
      expect(state.stale).toBe(true);
    });

    it("uses the most recent completion timestamp", () => {
      // Source completed 25d ago, target 1d ago → effective age = 1d
      // which is inside startDays. Edge should be at full strength.
      const state = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(25),
        targetCompletedAt: daysAgo(1),
      });
      expect(state.decayFactor).toBe(1);
      expect(state.derivedStatus).toBe("active");
    });
  });

  // ── Profile selection invariants ───────────────────────────────────────
  describe("profile selection invariants", () => {
    it("ONE_SIDED never decays below 0.20", () => {
      const veryOld = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(1000),
        targetCompletedAt: null,
      });
      expect(veryOld.decayFactor).toBe(0.2);
    });

    it("FULLY_RESOLVED never decays below 0.05", () => {
      const veryOld = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: daysAgo(1000),
        targetCompletedAt: daysAgo(1000),
      });
      expect(veryOld.decayFactor).toBe(0.05);
    });

    it("active edges (no completion) are immune to time", () => {
      const state = deriveEdgeDecayState({
        now: NOW,
        sourceCompletedAt: null,
        targetCompletedAt: null,
      });
      expect(state.decayFactor).toBe(1);
      expect(state.stale).toBe(false);
    });
  });
});
