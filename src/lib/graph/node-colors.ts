import type { NodeType } from "@/types/graph";

// Canonical color per node type — used in graph canvas, create sheet, and AI review UI.
export const NODE_COLOR_BY_TYPE: Record<NodeType, string> = {
  goal: "#d8d0c4",
  project: "#8c4a57",
  task: "#a35258",
  concept: "#677480",
  class: "#96784d",
  idea: "#5c7a6e",
  journal: "#6b6b8a",
  question: "#7a6b5c",
};
