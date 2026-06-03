import { describe, expect, it } from "vitest";

import { computePlannerPriority } from "./planner";

// Minimal "do nothing" baseline. Lets each test toggle exactly one signal
// to verify its isolated contribution.
const BASE = {
  dueSoon: false,
  carriedOver: false,
  currentImportanceScore: 0,
  recentlyUnblocked: false,
  nodeType: "task" as const,
  blockerCount: 0,
  prerequisiteCount: 0,
  unlocksCount: 0,
};

describe("computePlannerPriority", () => {
  it("returns the node-type base when no other signals fire", () => {
    expect(computePlannerPriority(BASE)).toBe(120); // task base
  });

  it("falls back to a default for unknown node types", () => {
    // @ts-expect-error — intentionally passing an unknown type to test fallback
    const result = computePlannerPriority({ ...BASE, nodeType: "weirdtype" });
    expect(result).toBe(40); // NODE_TYPE_PRIORITY_FALLBACK
  });

  // ── Single-signal contributions ────────────────────────────────────────
  describe("single signal contributions", () => {
    it("adds RECENTLY_UNBLOCKED bonus (+300)", () => {
      expect(computePlannerPriority({ ...BASE, recentlyUnblocked: true })).toBe(
        420, // 120 base + 300
      );
    });

    it("adds DUE_SOON bonus (+240)", () => {
      expect(computePlannerPriority({ ...BASE, dueSoon: true })).toBe(360);
    });

    it("adds CARRIED_OVER bonus (+170)", () => {
      expect(computePlannerPriority({ ...BASE, carriedOver: true })).toBe(290);
    });

    it("adds unlocks bonus saturating at +192 base + max", () => {
      // 1 dependent: 120 + 18 = 138 → 120 base + 138 = 258
      expect(computePlannerPriority({ ...BASE, unlocksCount: 1 })).toBe(258);
      // 10 dependents: 120 + min(72, 180) = 192 → 120 base + 192 = 312
      expect(computePlannerPriority({ ...BASE, unlocksCount: 10 })).toBe(312);
      // 100 dependents: capped same as 10
      expect(computePlannerPriority({ ...BASE, unlocksCount: 100 })).toBe(312);
    });

    it("applies prerequisite penalty saturating at -106", () => {
      // 1 prereq: -70 - 12 = -82 → 120 - 82 = 38
      expect(computePlannerPriority({ ...BASE, prerequisiteCount: 1 })).toBe(38);
      // Many prereqs: -70 - min(36, ...) = -106 → 120 - 106 = 14
      expect(computePlannerPriority({ ...BASE, prerequisiteCount: 99 })).toBe(14);
    });

    it("applies blocker penalty saturating at -66", () => {
      // 1 blocker: -42 - 8 = -50 → 120 - 50 = 70
      expect(computePlannerPriority({ ...BASE, blockerCount: 1 })).toBe(70);
      // Many blockers: -42 - min(24, ...) = -66 → 120 - 66 = 54
      expect(computePlannerPriority({ ...BASE, blockerCount: 99 })).toBe(54);
    });

    it("scales currentImportanceScore by 1.8", () => {
      // importance 50 → +90 → 120 + 90 = 210
      expect(
        computePlannerPriority({ ...BASE, currentImportanceScore: 50 }),
      ).toBe(210);
      // importance null → +0
      expect(
        computePlannerPriority({ ...BASE, currentImportanceScore: null }),
      ).toBe(120);
    });
  });

  // ── Relative priority — the design invariants ──────────────────────────
  describe("relative priority invariants", () => {
    it("ranks recently_unblocked > due_soon > carried_over", () => {
      const unblocked = computePlannerPriority({ ...BASE, recentlyUnblocked: true });
      const due = computePlannerPriority({ ...BASE, dueSoon: true });
      const carried = computePlannerPriority({ ...BASE, carriedOver: true });
      expect(unblocked).toBeGreaterThan(due);
      expect(due).toBeGreaterThan(carried);
    });

    it("prerequisite penalty is harsher than blocker penalty for the same count", () => {
      const prereq = computePlannerPriority({ ...BASE, prerequisiteCount: 3 });
      const blocker = computePlannerPriority({ ...BASE, blockerCount: 3 });
      // Both subtract from base; prereq should leave a smaller (worse) priority
      expect(prereq).toBeLessThan(blocker);
    });

    it("habit out-ranks project as a planning unit", () => {
      const habit = computePlannerPriority({ ...BASE, nodeType: "habit" });
      const project = computePlannerPriority({ ...BASE, nodeType: "project" });
      expect(habit).toBeGreaterThan(project);
    });

    it("a high-importance node beats a low-importance node, all else equal", () => {
      const high = computePlannerPriority({ ...BASE, currentImportanceScore: 90 });
      const low = computePlannerPriority({ ...BASE, currentImportanceScore: 10 });
      expect(high).toBeGreaterThan(low);
    });
  });

  // ── Combined signals stack additively ──────────────────────────────────
  it("combines bonuses additively without double-counting", () => {
    // task base 120 + unblocked 300 + due_soon 240 + importance 50*1.8=90 → 750
    expect(
      computePlannerPriority({
        ...BASE,
        recentlyUnblocked: true,
        dueSoon: true,
        currentImportanceScore: 50,
      }),
    ).toBe(750);
  });

  it("can produce a negative priority for a deeply blocked, unimportant task", () => {
    // task 120 - prereq(99) 106 - blocker(99) 66 = -52
    const result = computePlannerPriority({
      ...BASE,
      prerequisiteCount: 99,
      blockerCount: 99,
    });
    expect(result).toBe(-52);
  });
});
