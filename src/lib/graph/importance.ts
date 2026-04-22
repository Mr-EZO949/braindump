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
  task: -9,
  habit: 6,
};

const authoredImportanceIndex: Record<Importance, number> = {
  high: 82,
  low: 34,
  medium: 58,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getImportanceIndex(node: Pick<Node, "id" | "importance" | "importance_index" | "node_type">) {
  if (typeof node.importance_index === "number" && Number.isFinite(node.importance_index)) {
    return clamp(Math.round(node.importance_index), 0, 100);
  }

  return clamp(
    fallbackBucketIndex[node.importance] + fallbackTypeOffset[node.node_type],
    0,
    100,
  );
}

export function getImportanceLabel(importanceIndex: number): Importance {
  if (importanceIndex >= 78) {
    return "high";
  }

  if (importanceIndex >= 40) {
    return "medium";
  }

  return "low";
}

export function getAuthoredImportanceIndex(importance: Importance) {
  return authoredImportanceIndex[importance];
}
