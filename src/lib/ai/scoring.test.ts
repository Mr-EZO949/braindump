import { describe, it, expect } from "vitest";
import {
  dependencyPressure,
  blocksPenalty,
  blockerBonus,
  clamp,
  calibrateWorkspaceScore,
  type EdgeRow,
  type NodeRow,
} from "./scoring";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(
  source: string,
  target: string,
  edgeType: string,
  status = "active",
): EdgeRow {
  return {
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    status,
  };
}

function makeNode(
  id: string,
  opts: Partial<NodeRow> = {},
): NodeRow {
  return {
    id,
    node_type: "task",
    status: "active",
    created_at: new Date().toISOString(),
    workspace_id: "ws1",
    ...opts,
  };
}

function buildEdgeMap(edges: EdgeRow[]): Map<string, EdgeRow[]> {
  const map = new Map<string, EdgeRow[]>();
  for (const e of edges) {
    if (!map.has(e.source_node_id)) map.set(e.source_node_id, []);
    if (!map.has(e.target_node_id)) map.set(e.target_node_id, []);
    map.get(e.source_node_id)!.push(e);
    map.get(e.target_node_id)!.push(e);
  }
  return map;
}

// ---------------------------------------------------------------------------
// dependencyPressure
// ---------------------------------------------------------------------------

describe("dependencyPressure", () => {
  it("returns 1.0 when there are no prerequisite edges", () => {
    const edges = [makeEdge("A", "B", "belongs_to")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B"]);

    expect(dependencyPressure("B", edgeMap, activeIds)).toBe(1.0);
  });

  it("returns 0.82 with 1 unmet prerequisite", () => {
    // A is required_for B, A is still active (unmet)
    const edges = [makeEdge("A", "B", "required_for")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B"]);

    expect(dependencyPressure("B", edgeMap, activeIds)).toBe(0.82);
  });

  it("returns 1.0 when the prerequisite is completed (not in activeIds)", () => {
    // A is required_for B, A has been completed
    const edges = [makeEdge("A", "B", "required_for")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["B"]); // A completed, so not in activeIds

    expect(dependencyPressure("B", edgeMap, activeIds)).toBe(1.0);
  });

  it("returns 0.72 with 2 unmet prerequisites", () => {
    const edges = [
      makeEdge("A", "C", "required_for"),
      makeEdge("B", "C", "prerequisite_for"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B", "C"]);

    expect(dependencyPressure("C", edgeMap, activeIds)).toBe(0.72);
  });

  it("returns 0.82 when one of two prerequisites is completed", () => {
    const edges = [
      makeEdge("A", "C", "required_for"),
      makeEdge("B", "C", "prerequisite_for"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["B", "C"]); // A completed

    expect(dependencyPressure("C", edgeMap, activeIds)).toBe(0.82);
  });

  it("returns 0.64 with 3+ unmet prerequisites", () => {
    const edges = [
      makeEdge("A", "D", "required_for"),
      makeEdge("B", "D", "prerequisite_for"),
      makeEdge("C", "D", "required_for"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B", "C", "D"]);

    expect(dependencyPressure("D", edgeMap, activeIds)).toBe(0.64);
  });

  it("ignores orphaned edges", () => {
    const edges = [makeEdge("A", "B", "required_for", "orphaned")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B"]);

    expect(dependencyPressure("B", edgeMap, activeIds)).toBe(1.0);
  });

  it("ignores blocks edges (those are handled separately)", () => {
    const edges = [makeEdge("A", "B", "blocks")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B"]);

    expect(dependencyPressure("B", edgeMap, activeIds)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// blockerBonus
// ---------------------------------------------------------------------------

describe("blockerBonus", () => {
  it("returns 0 when no prerequisites exist", () => {
    const edgeMap = buildEdgeMap([]);
    const completedIds = new Set<string>();

    expect(blockerBonus("B", edgeMap, completedIds)).toBe(0);
  });

  it("returns +5 when one prerequisite is completed", () => {
    const edges = [makeEdge("A", "B", "required_for")];
    const edgeMap = buildEdgeMap(edges);
    const completedIds = new Set(["A"]);

    expect(blockerBonus("B", edgeMap, completedIds)).toBe(5);
  });

  it("returns +10 when two prerequisites are completed", () => {
    const edges = [
      makeEdge("A", "B", "required_for"),
      makeEdge("C", "B", "prerequisite_for"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const completedIds = new Set(["A", "C"]);

    expect(blockerBonus("B", edgeMap, completedIds)).toBe(10);
  });

  it("caps at +10 for 3+ completed prerequisites", () => {
    const edges = [
      makeEdge("A", "D", "required_for"),
      makeEdge("B", "D", "prerequisite_for"),
      makeEdge("C", "D", "required_for"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const completedIds = new Set(["A", "B", "C"]);

    expect(blockerBonus("D", edgeMap, completedIds)).toBe(10);
  });

  it("returns 0 when prerequisites are active (not completed)", () => {
    const edges = [makeEdge("A", "B", "required_for")];
    const edgeMap = buildEdgeMap(edges);
    const completedIds = new Set<string>(); // A not completed

    expect(blockerBonus("B", edgeMap, completedIds)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// blocksPenalty
// ---------------------------------------------------------------------------

describe("blocksPenalty", () => {
  it("returns 0 when no blocks edges exist", () => {
    const edgeMap = buildEdgeMap([]);
    const activeIds = new Set<string>();

    expect(blocksPenalty("B", edgeMap, activeIds)).toBe(0);
  });

  it("returns -3 with 1 active blocker", () => {
    const edges = [makeEdge("A", "B", "blocks")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B"]);

    expect(blocksPenalty("B", edgeMap, activeIds)).toBe(-3);
  });

  it("returns 0 when blocker is completed (not in activeIds)", () => {
    const edges = [makeEdge("A", "B", "blocks")];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["B"]); // A completed

    expect(blocksPenalty("B", edgeMap, activeIds)).toBe(0);
  });

  it("returns -5 with 2 active blockers", () => {
    const edges = [
      makeEdge("A", "B", "blocks"),
      makeEdge("C", "B", "blocks"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B", "C"]);

    expect(blocksPenalty("B", edgeMap, activeIds)).toBe(-5);
  });

  it("returns -7 with 3+ active blockers", () => {
    const edges = [
      makeEdge("A", "D", "blocks"),
      makeEdge("B", "D", "blocks"),
      makeEdge("C", "D", "blocks"),
    ];
    const edgeMap = buildEdgeMap(edges);
    const activeIds = new Set(["A", "B", "C", "D"]);

    expect(blocksPenalty("D", edgeMap, activeIds)).toBe(-7);
  });
});

// ---------------------------------------------------------------------------
// Score change on prerequisite completion (integration-level)
//
// This is the core scenario the user reported as broken:
// Node A is required_for Node B.
// Before completing A: B has a dependency multiplier of 0.82 and no bonus.
// After completing A: B should have multiplier 1.0 and +5 bonus.
// The final (calibrated) score must change.
// ---------------------------------------------------------------------------

describe("score change when prerequisite is completed", () => {
  const WEIGHTS = {
    urgency: 0.23,
    goal_alignment: 0.17,
    planner: 0.10,
    recency: 0.14,
    centrality: 0.13,
    user_confirmation: 0.08,
    ai_prior: 0.05,
  };

  function computeRawScore(params: {
    urgencyScore: number;
    goalAlignmentScore: number;
    plannerScore: number;
    recencyScore: number;
    centralityScore: number;
    userConfirmationScore: number;
    aiPriorScore: number;
    blockerBonusVal: number;
    depPressure: number;
    blocksPen: number;
  }) {
    const weighted =
      WEIGHTS.urgency * params.urgencyScore +
      WEIGHTS.goal_alignment * params.goalAlignmentScore +
      WEIGHTS.planner * params.plannerScore +
      WEIGHTS.recency * params.recencyScore +
      WEIGHTS.centrality * params.centralityScore +
      WEIGHTS.user_confirmation * params.userConfirmationScore +
      WEIGHTS.ai_prior * params.aiPriorScore +
      params.blockerBonusVal;

    return clamp(weighted * params.depPressure + params.blocksPen, 0, 100);
  }

  it("raw score increases when a prerequisite is completed", () => {
    // Simulate: A is required_for B
    const edges = [makeEdge("A", "B", "required_for")];
    const edgeMap = buildEdgeMap(edges);

    // Before: A is active
    const activeIdsBefore = new Set(["A", "B"]);
    const completedIdsBefore = new Set<string>();

    const dpBefore = dependencyPressure("B", edgeMap, activeIdsBefore);
    const bbBefore = blockerBonus("B", edgeMap, completedIdsBefore);

    expect(dpBefore).toBe(0.82);
    expect(bbBefore).toBe(0);

    // After: A is completed
    const activeIdsAfter = new Set(["B"]);
    const completedIdsAfter = new Set(["A"]);

    const dpAfter = dependencyPressure("B", edgeMap, activeIdsAfter);
    const bbAfter = blockerBonus("B", edgeMap, completedIdsAfter);

    expect(dpAfter).toBe(1.0);
    expect(bbAfter).toBe(5);

    // Compute full raw scores with representative signal values
    const signals = {
      urgencyScore: 50,
      goalAlignmentScore: 56,
      plannerScore: 0,
      recencyScore: 70,
      centralityScore: 30,
      userConfirmationScore: 12,
      aiPriorScore: 50,
    };

    const rawBefore = computeRawScore({
      ...signals,
      blockerBonusVal: bbBefore,
      depPressure: dpBefore,
      blocksPen: 0,
    });

    const rawAfter = computeRawScore({
      ...signals,
      blockerBonusVal: bbAfter,
      depPressure: dpAfter,
      blocksPen: 0,
    });

    // Raw score must increase meaningfully
    expect(rawAfter).toBeGreaterThan(rawBefore);
    expect(rawAfter - rawBefore).toBeGreaterThan(5);
  });

  it("calibrated score also changes after prerequisite completion", () => {
    // Simulate a small workspace: 5 nodes, varying raw scores
    const nodeB = makeNode("B");
    const nodeC = makeNode("C");
    const nodeD = makeNode("D");
    const nodeE = makeNode("E");
    const nodeF = makeNode("F");
    const nonCompletedNodes = [nodeB, nodeC, nodeD, nodeE, nodeF];

    // Before completing A: B has a lower raw score due to dependency pressure
    const rawScoresBefore = new Map<string, number>([
      ["B", 35], // suppressed by dep pressure
      ["C", 42],
      ["D", 50],
      ["E", 38],
      ["F", 45],
    ]);

    const calibratedBefore = calibrateWorkspaceScore({
      nodeId: "B",
      rawScoreByNodeId: rawScoresBefore,
      nonCompletedNodes,
    });

    // After completing A: B's raw score jumps
    const rawScoresAfter = new Map<string, number>([
      ["B", 48], // ~13 points higher from dep pressure + blocker bonus
      ["C", 42],
      ["D", 50],
      ["E", 38],
      ["F", 45],
    ]);

    const calibratedAfter = calibrateWorkspaceScore({
      nodeId: "B",
      rawScoreByNodeId: rawScoresAfter,
      nonCompletedNodes,
    });

    // Calibrated score must also increase
    expect(calibratedAfter).toBeGreaterThan(calibratedBefore);

    // And the difference should be visible (not absorbed by calibration)
    const diff = calibratedAfter - calibratedBefore;
    expect(diff).toBeGreaterThan(1);
  });

  it("calibration does NOT mask small changes when workspace is small (<3 nodes)", () => {
    const nodeB = makeNode("B");
    const nonCompletedNodes = [nodeB];

    const scoreBefore = calibrateWorkspaceScore({
      nodeId: "B",
      rawScoreByNodeId: new Map([["B", 35]]),
      nonCompletedNodes,
    });

    const scoreAfter = calibrateWorkspaceScore({
      nodeId: "B",
      rawScoreByNodeId: new Map([["B", 48]]),
      nonCompletedNodes,
    });

    // With <3 nodes, calibration returns raw score directly
    expect(scoreBefore).toBe(35);
    expect(scoreAfter).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// Calibration edge cases
// ---------------------------------------------------------------------------

describe("calibrateWorkspaceScore", () => {
  it("compresses extreme outliers", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`n${i}`));
    const rawScores = new Map<string, number>();
    // 9 nodes around 40–50, one outlier at 95
    nodes.forEach((n, i) => {
      rawScores.set(n.id, i < 9 ? 40 + i : 95);
    });

    const outlierScore = calibrateWorkspaceScore({
      nodeId: "n9",
      rawScoreByNodeId: rawScores,
      nonCompletedNodes: nodes,
    });

    // Should be high but sigmoid-compressed, not raw 95
    expect(outlierScore).toBeGreaterThan(70);
    expect(outlierScore).toBeLessThan(95);
  });

  it("produces different scores for different raw inputs in a realistic distribution", () => {
    const nodes = Array.from({ length: 8 }, (_, i) => makeNode(`n${i}`));
    const rawScores = new Map<string, number>([
      ["n0", 20],
      ["n1", 30],
      ["n2", 35],
      ["n3", 42],
      ["n4", 45],
      ["n5", 50],
      ["n6", 55],
      ["n7", 70],
    ]);

    const scores = nodes.map((n) =>
      Math.round(
        calibrateWorkspaceScore({
          nodeId: n.id,
          rawScoreByNodeId: rawScores,
          nonCompletedNodes: nodes,
        }),
      ),
    );

    // Should be monotonically increasing (higher raw → higher calibrated)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }

    // Should have spread — not all the same number
    const uniqueScores = new Set(scores);
    expect(uniqueScores.size).toBeGreaterThan(3);
  });
});
