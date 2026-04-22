import type { NodeType } from "@/types/graph";

// Canonical color per node type — used in graph canvas, create sheet, and AI review UI.
// Palette goals: one distinct hue per type, balanced luminance on dark UI, so no
// type dominates visually but each is identifiable at a glance.
export const NODE_COLOR_BY_TYPE: Record<NodeType, string> = {
  goal: "#f0a755",
  project: "#6b8cef",
  task: "#ef6b7a",
  class: "#a07fd8",
  concept: "#5cc7b8",
  idea: "#eacf5a",
  habit: "#7fc987",
};
