import { describe, expect, it } from "vitest";
import {
  AUTO_ADD_SETTING,
  AUTO_APPLY_THRESHOLD,
  autoAddEnabled,
  posteriorAcceptRate,
  riskClassOf,
  selectAutoApply,
  type AutoApplyCandidate,
  type ClassStats,
  type RiskClass,
} from "./auto-apply";

const candidate = (
  id: string,
  overrides: Partial<AutoApplyCandidate> = {},
): AutoApplyCandidate => ({
  id,
  local_ref: id,
  primary_parent_local_ref: null,
  existing_parent_node_id: "existing-parent",
  proposed_node_type: "task",
  extraction_confidence: 0.9,
  ...overrides,
});

describe("autoAddEnabled", () => {
  it("is on unless the user turned it off", () => {
    expect(autoAddEnabled(null)).toBe(true);
    expect(autoAddEnabled({})).toBe(true);
    expect(autoAddEnabled({ user_metadata: null })).toBe(true);
    expect(autoAddEnabled({ user_metadata: { full_name: "Ezo" } })).toBe(true);
    expect(autoAddEnabled({ user_metadata: { [AUTO_ADD_SETTING]: true } })).toBe(true);
    expect(autoAddEnabled({ user_metadata: { [AUTO_ADD_SETTING]: false } })).toBe(false);
  });
});

describe("posteriorAcceptRate", () => {
  it("cold start: a new user gets auto-apply (conservative prior ≥ threshold)", () => {
    expect(posteriorAcceptRate(undefined)).toBeGreaterThanOrEqual(AUTO_APPLY_THRESHOLD);
  });

  it("two early rejections in a class bring review back for that class", () => {
    expect(posteriorAcceptRate({ accepted: 1, rejected: 2 })).toBeLessThan(AUTO_APPLY_THRESHOLD);
  });

  it("the real population (567 accepted / 10 rejected) stays well above the bar", () => {
    expect(posteriorAcceptRate({ accepted: 567, rejected: 10 })).toBeGreaterThan(0.97);
  });
});

describe("riskClassOf", () => {
  it("buckets by level, placement and confidence", () => {
    expect(riskClassOf(candidate("a"))).toBe("leaf/parented/hi");
    expect(
      riskClassOf(candidate("b", { proposed_node_type: "goal", existing_parent_node_id: null, extraction_confidence: 0.7 })),
    ).toBe("objective/top/lo");
  });
});

describe("selectAutoApply", () => {
  const noHistory = new Map<RiskClass, ClassStats>();

  it("applies confident proposals and holds possible duplicates for review", () => {
    const ids = selectAutoApply({
      proposals: [candidate("keep"), candidate("dup")],
      heldIds: new Set(["dup"]),
      stats: noHistory,
    });
    expect(ids).toEqual(["keep"]);
  });

  it("never splits a subtree: a child waits for review if its same-dump parent does", () => {
    const ids = selectAutoApply({
      proposals: [
        candidate("parent", { proposed_node_type: "project" }),
        candidate("child", { primary_parent_local_ref: "parent", existing_parent_node_id: null }),
        candidate("grandchild", { primary_parent_local_ref: "child", existing_parent_node_id: null }),
      ],
      heldIds: new Set(["parent"]),
      stats: noHistory,
    });
    expect(ids).toEqual([]);
  });

  it("respects a user who rejects a class often", () => {
    const stats = new Map<RiskClass, ClassStats>([["leaf/parented/hi", { accepted: 3, rejected: 6 }]]);
    const ids = selectAutoApply({
      proposals: [candidate("t1"), candidate("g1", { proposed_node_type: "goal" })],
      heldIds: new Set(),
      stats,
    });
    // Tasks under a parent now go to review for this user; the goal class is untouched.
    expect(ids).toEqual(["g1"]);
  });
});
