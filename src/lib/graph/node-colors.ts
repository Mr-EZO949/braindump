import type { NodeType } from "@/types/graph";

// Canonical color per node type — used in graph canvas, create sheet, and AI review UI.
// Palette goals: one distinct hue per type, balanced luminance on dark UI, so no
// type dominates visually but each is identifiable at a glance.
// Big tasks share the task hue (the gradient-red outline marks them); areas
// are a quiet neutral so they read as structure, not work; notes inherit the
// retired concept teal.
export const NODE_COLOR_BY_TYPE: Record<NodeType, string> = {
  goal: "#f0a755",
  project: "#6b8cef",
  big_task: "#ef6b7a",
  task: "#ef6b7a",
  habit: "#7fc987",
  area: "#928b85",
  class: "#a07fd8",
  idea: "#eacf5a",
  note: "#5cc7b8",
};
