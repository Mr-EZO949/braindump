import type { Importance, Node } from "@/types/graph";

const fallbackBucketIndex: Record<Importance, number> = {
  high: 80,
  medium: 56,
  low: 32,
};

const fallbackTypeOffset: Record<Node["node_type"], number> = {
  goal: 8,
  project: 4,
  concept: 2,
  class: 0,
  idea: -3,
  journal: -5,
  question: -5,
  task: -9,
};

export const demoImportanceIndexById: Record<string, number> = {
  "10000000-0000-0000-0000-000000000001": 96,
  "10000000-0000-0000-0000-000000000002": 92,
  "10000000-0000-0000-0000-000000000003": 84,
  "10000000-0000-0000-0000-000000000004": 78,
  "10000000-0000-0000-0000-000000000005": 72,
  "10000000-0000-0000-0000-000000000006": 70,
  "10000000-0000-0000-0000-000000000007": 68,
  "10000000-0000-0000-0000-000000000008": 82,
  "10000000-0000-0000-0000-000000000009": 63,
  "10000000-0000-0000-0000-000000000010": 58,
  "10000000-0000-0000-0000-000000000011": 66,
  "10000000-0000-0000-0000-000000000012": 64,
  "10000000-0000-0000-0000-000000000013": 46,
  "10000000-0000-0000-0000-000000000014": 60,
  "10000000-0000-0000-0000-000000000015": 48,
  "10000000-0000-0000-0000-000000000016": 56,
  "10000000-0000-0000-0000-000000000017": 54,
  "10000000-0000-0000-0000-000000000018": 58,
  "10000000-0000-0000-0000-000000000019": 42,
  "10000000-0000-0000-0000-000000000020": 36,
  "10000000-0000-0000-0000-000000000021": 52,
  "10000000-0000-0000-0000-000000000022": 30,
  "10000000-0000-0000-0000-000000000023": 32,
  "10000000-0000-0000-0000-000000000024": 38,
  "10000000-0000-0000-0000-000000000025": 44,
  "10000000-0000-0000-0000-000000000026": 55,
  "10000000-0000-0000-0000-000000000027": 47,
  "10000000-0000-0000-0000-000000000028": 31,
  "10000000-0000-0000-0000-000000000029": 29,
  "10000000-0000-0000-0000-000000000030": 40,
  "10000000-0000-0000-0000-000000000031": 26,
  "10000000-0000-0000-0000-000000000032": 28,
  "10000000-0000-0000-0000-000000000033": 43,
  "10000000-0000-0000-0000-000000000034": 24,
  "10000000-0000-0000-0000-000000000035": 34,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getImportanceIndex(node: Pick<Node, "id" | "importance" | "importance_index" | "node_type">) {
  if (typeof node.importance_index === "number" && Number.isFinite(node.importance_index)) {
    return clamp(Math.round(node.importance_index), 0, 100);
  }

  const demoIndex = demoImportanceIndexById[node.id];

  if (typeof demoIndex === "number") {
    return demoIndex;
  }

  return clamp(
    fallbackBucketIndex[node.importance] + fallbackTypeOffset[node.node_type],
    0,
    100,
  );
}

export function getImportanceLabel(importanceIndex: number): Importance {
  if (importanceIndex >= 72) {
    return "high";
  }

  if (importanceIndex >= 45) {
    return "medium";
  }

  return "low";
}
