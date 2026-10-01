// The node taxonomy (v2, 2026-09-29 — docs/node-types.md): nine types in four
// families. Each type answers one question, and the family says how a node
// ends. Code that branches on node types should ask these sets and helpers
// instead of keeping its own list, so the rules change in one place.

import type { NodeType } from "@/types/graph";

export type NodeFamily = "direction" | "work" | "structure" | "thinking";

export const NODE_TYPES: readonly NodeType[] = [
  "goal",
  "project",
  "big_task",
  "task",
  "habit",
  "area",
  "class",
  "idea",
  "note",
];

export const NODE_TYPE_INFO: Record<
  NodeType,
  { label: string; family: NodeFamily; question: string; examples: string }
> = {
  goal: {
    label: "Goal",
    family: "direction",
    question: "A result you'll know you reached — pass it, land it, hit the number — ideally by a date.",
    examples: "Pass Machine Learning · Internship in Milan by November · 1450+ on the SAT",
  },
  project: {
    label: "Project",
    family: "work",
    question: "A body of work with several different parts or deliverables.",
    examples: "Internship search · Launch the beta",
  },
  big_task: {
    label: "Big task",
    family: "work",
    question: "One piece of work you do or produce, over several sittings.",
    examples: "Write the thesis · Test BrainDump · Crash-course Italian",
  },
  task: {
    label: "Task",
    family: "work",
    question: "Something you can finish in one sitting (about 2 hours or less).",
    examples: "Email the professor · Solve 5 practice problems",
  },
  habit: {
    label: "Habit",
    family: "work",
    question: "Something that repeats on a cadence.",
    examples: "Gym 3×/week · Daily stretching",
  },
  area: {
    label: "Area",
    family: "structure",
    question: "A part of life you keep maintaining, with no finish line.",
    examples: "University · Health · Career · Life admin",
  },
  class: {
    label: "Class",
    family: "structure",
    question: "A course you're taking this term.",
    examples: "Linear Algebra · Deep Learning",
  },
  idea: {
    label: "Idea",
    family: "thinking",
    question: "Something you might do, but haven't committed to.",
    examples: "Reselling clothes Milan → Astana",
  },
  note: {
    label: "Note",
    family: "thinking",
    question: "Something to remember — a person, a fact, advice, a decision.",
    examples: "Noah Kim (TA) · Advice: stay through the refactor",
  },
};

export const NODE_FAMILY_LABEL: Record<NodeFamily, string> = {
  direction: "Direction",
  work: "Work",
  structure: "Structure",
  thinking: "Thinking",
};

// Values that still exist in old rows, requests or model output.
const LEGACY_NODE_TYPES: Record<string, NodeType> = { concept: "note" };

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

// Any stored or model-supplied type → a current NodeType (legacy "concept" →
// note; unknown → `fallback`).
export function normalizeNodeType(value: unknown, fallback: NodeType = "note"): NodeType {
  if (isNodeType(value)) return value;
  if (typeof value === "string" && value in LEGACY_NODE_TYPES) return LEGACY_NODE_TYPES[value];
  return fallback;
}

// Goals and projects: the outcomes and bodies of work the UI calls "Objectives"
// (size & weight on the canvas).
export const OBJECTIVE_TYPES: ReadonlySet<NodeType> = new Set(["goal", "project"]);

// Checked off in Todos: tasks, and big tasks (with step progress).
export const CHECKABLE_TYPES: ReadonlySet<NodeType> = new Set(["task", "big_task"]);

// Work you'd break into steps before starting — a distinct surface and badge.
export const BREAKDOWN_TYPES: ReadonlySet<NodeType> = new Set(["big_task"]);

// Things you do (vs. where things live, or what you know).
export const WORK_TYPES: ReadonlySet<NodeType> = new Set(["project", "big_task", "task", "habit"]);

// Where things live: never finished, never scheduled, not ranked like work.
export const STRUCTURE_TYPES: ReadonlySet<NodeType> = new Set(["area", "class"]);

// What you know or might do: never scheduled.
export const KNOWLEDGE_TYPES: ReadonlySet<NodeType> = new Set(["idea", "note"]);

// Nodes that hold other work under them — valid parents for new work.
export const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set([
  "area",
  "class",
  "goal",
  "project",
  "big_task",
]);

// Which children each type may hold (docs/node-types.md → Nesting rules). Soft:
// prompts follow it; nothing blocks a manual edit. The one enforced rule — a
// task that gains a child step becomes a big task — is the DB trigger
// promote_task_with_children (migration 20260929000000).
// Areas may hold sub-areas (the root is an area; "University" can hold "This
// Semester's Courses"); goals may hold milestone goals; a big task holds its
// phases (big tasks) and steps, so it can carry a deep roadmap.
export const ALLOWED_CHILDREN: Record<NodeType, ReadonlySet<NodeType>> = {
  area: new Set(["area", "goal", "project", "class", "big_task", "task", "habit", "idea", "note"]),
  goal: new Set(["goal", "project", "big_task", "task", "habit", "note"]),
  class: new Set(["goal", "big_task", "task", "habit", "note"]),
  project: new Set(["big_task", "task", "habit", "idea", "note"]),
  big_task: new Set(["big_task", "task", "note"]),
  task: new Set(["note"]),
  habit: new Set(["note"]),
  idea: new Set(["note"]),
  note: new Set(),
};
