import { describe, expect, it } from "vitest";

import {
  cadenceDue,
  computePlannerPriority,
  deadlineBonus,
  diversifyHead,
  neglectBonus,
  rhythmFor,
  rotationDemoted,
} from "./planner";

// Minimal "do nothing" baseline. Lets each test toggle exactly one signal
// to verify its isolated contribution.
const BASE = {
  dueSoon: false,
  cadenceDue: false,
  carriedOver: false,
  currentImportanceScore: 0,
  recentlyUnblocked: false,
  nodeType: "task" as const,
  blockerCount: 0,
  prerequisiteCount: 0,
  unlocksCount: 0,
  rotationDemoted: false,
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

  // ── Cadence + rotation contributions ───────────────────────────────────
  describe("cadence + rotation", () => {
    it("adds CADENCE_DUE bonus (+220)", () => {
      expect(computePlannerPriority({ ...BASE, cadenceDue: true })).toBe(340);
    });

    it("subtracts ROTATION penalty (-130) when demoted", () => {
      expect(computePlannerPriority({ ...BASE, rotationDemoted: true })).toBe(-10);
    });

    it("ranks due_soon > cadence_due > carried_over", () => {
      const due = computePlannerPriority({ ...BASE, dueSoon: true });
      const cadence = computePlannerPriority({ ...BASE, cadenceDue: true });
      const carried = computePlannerPriority({ ...BASE, carriedOver: true });
      expect(due).toBeGreaterThan(cadence);
      expect(cadence).toBeGreaterThan(carried);
    });

    it("rotation nudges but doesn't override urgency: a due item from yesterday's project still beats a fresh idle task elsewhere", () => {
      const dueButDemoted = computePlannerPriority({
        ...BASE,
        dueSoon: true,
        rotationDemoted: true,
      }); // 120 + 240 - 130 = 230
      const freshIdle = computePlannerPriority({ ...BASE }); // 120
      expect(dueButDemoted).toBeGreaterThan(freshIdle);
    });
  });
});

describe("cadenceDue", () => {
  it("is never due once done today", () => {
    expect(
      cadenceDue({ targetPerWeek: 7, completionsThisWeek: 0, doneToday: true, dayOfWeek: 3 }),
    ).toBe(false);
  });

  it("is not due for a node with no cadence target", () => {
    expect(
      cadenceDue({ targetPerWeek: null, completionsThisWeek: 0, doneToday: false, dayOfWeek: 3 }),
    ).toBe(false);
  });

  it("a daily habit is due any day it's not yet done", () => {
    expect(
      cadenceDue({ targetPerWeek: 7, completionsThisWeek: 0, doneToday: false, dayOfWeek: 1 }),
    ).toBe(true);
    expect(
      cadenceDue({ targetPerWeek: 7, completionsThisWeek: 3, doneToday: false, dayOfWeek: 5 }),
    ).toBe(true);
  });

  it("a 3x/week habit does NOT nag early in the week when on pace", () => {
    // Mon: 7 days left, only need 3 → not behind → not due
    expect(
      cadenceDue({ targetPerWeek: 3, completionsThisWeek: 0, doneToday: false, dayOfWeek: 1 }),
    ).toBe(false);
    // Wed: 5 days left, need 3 → still fine
    expect(
      cadenceDue({ targetPerWeek: 3, completionsThisWeek: 0, doneToday: false, dayOfWeek: 3 }),
    ).toBe(false);
  });

  it("a 3x/week habit becomes due once behind pace late in the week", () => {
    // Thu: 4 days left, need 3 → getting tight → due
    expect(
      cadenceDue({ targetPerWeek: 3, completionsThisWeek: 0, doneToday: false, dayOfWeek: 4 }),
    ).toBe(true);
    // Sat: 2 days left, 1 done, 2 to go → due
    expect(
      cadenceDue({ targetPerWeek: 3, completionsThisWeek: 1, doneToday: false, dayOfWeek: 6 }),
    ).toBe(true);
  });

  it("is not due once the weekly target is already met", () => {
    expect(
      cadenceDue({ targetPerWeek: 3, completionsThisWeek: 3, doneToday: false, dayOfWeek: 7 }),
    ).toBe(false);
    expect(
      cadenceDue({ targetPerWeek: 3, completionsThisWeek: 5, doneToday: false, dayOfWeek: 7 }),
    ).toBe(false);
  });
});

describe("rotationDemoted", () => {
  it("demotes only when the cluster was touched yesterday AND an untouched cluster is available", () => {
    expect(
      rotationDemoted({ clusterTouchedYesterday: true, untouchedClusterAvailable: true }),
    ).toBe(true);
  });

  it("does not demote a single-cluster user (no alternative to rotate to)", () => {
    expect(
      rotationDemoted({ clusterTouchedYesterday: true, untouchedClusterAvailable: false }),
    ).toBe(false);
  });

  it("does not demote a cluster that wasn't touched yesterday", () => {
    expect(
      rotationDemoted({ clusterTouchedYesterday: false, untouchedClusterAvailable: true }),
    ).toBe(false);
  });
});

describe("Focus v2 — deadlines, steering, rhythm", () => {
  it("deadline pressure adds up to +260, and later steps of the same deadline get 55%", () => {
    expect(deadlineBonus(100)).toBe(260);
    expect(deadlineBonus(0)).toBe(0);
    expect(deadlineBonus(100, 0.55)).toBe(143);
    const next = computePlannerPriority({ ...BASE, deadlinePressure: 90 });
    const later = computePlannerPriority({ ...BASE, deadlinePressure: 90, siblingFactor: 0.55 });
    expect(next).toBeGreaterThan(later);
  });

  it("a step of an exam two days out beats a carried-over undated task", () => {
    const examStep = computePlannerPriority({ ...BASE, deadlinePressure: 95 });
    const leftover = computePlannerPriority({ ...BASE, carriedOver: true });
    expect(examStep).toBeGreaterThan(leftover);
  });

  it("just-unblocked still outranks a full deadline (existing invariant holds)", () => {
    expect(computePlannerPriority({ ...BASE, recentlyUnblocked: true })).toBeGreaterThan(
      computePlannerPriority({ ...BASE, deadlinePressure: 100 }) - 30,
    );
  });

  it("a fresh 'focus on X' (+220) lifts an undated task over a carried-over one, not over a looming deadline", () => {
    const focused = computePlannerPriority({ ...BASE, steer: 1 });
    expect(focused).toBeGreaterThan(computePlannerPriority({ ...BASE, carriedOver: true }));
    expect(focused).toBeLessThan(computePlannerPriority({ ...BASE, deadlinePressure: 95 }));
    expect(computePlannerPriority({ ...BASE, steer: -1 })).toBe(-100);
  });

  it("neglect starts at 3 untouched days and caps at +80", () => {
    expect(neglectBonus(2)).toBe(0);
    expect(neglectBonus(3)).toBe(20);
    expect(neglectBonus(5)).toBe(60);
    expect(neglectBonus(30)).toBe(80);
  });

  it("yesterday's cluster: keep going when it has deadline pressure, rotate when it doesn't", () => {
    expect(
      rhythmFor({ clusterTouchedYesterday: true, untouchedClusterAvailable: true, deadlinePressure: 70 }),
    ).toEqual({ momentum: true, rotationDemoted: false });
    expect(
      rhythmFor({ clusterTouchedYesterday: true, untouchedClusterAvailable: true, deadlinePressure: 10 }),
    ).toEqual({ momentum: false, rotationDemoted: true });
    expect(
      rhythmFor({ clusterTouchedYesterday: true, untouchedClusterAvailable: false, deadlinePressure: 0 }),
    ).toEqual({ momentum: false, rotationDemoted: false });
    expect(
      rhythmFor({ clusterTouchedYesterday: false, untouchedClusterAvailable: true, deadlinePressure: 90 }),
    ).toEqual({ momentum: false, rotationDemoted: false });
  });
});

describe("diversifyHead", () => {
  it("keeps one step per deadline in the head and the rest in order after it", () => {
    const e = (id: string, deadlineOwner: string | null) => ({ id, deadlineOwner });
    const out = diversifyHead(
      [e("a1", "A"), e("a2", "A"), e("a3", "A"), e("x", null), e("b1", "B"), e("y", null)],
      3,
    ).map((x) => x.id);
    expect(out).toEqual(["a1", "x", "b1", "a2", "a3", "y"]);
  });
});
