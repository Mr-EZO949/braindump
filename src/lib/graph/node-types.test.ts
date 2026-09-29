import { describe, expect, it } from "vitest";

import {
  ALLOWED_CHILDREN,
  CHECKABLE_TYPES,
  CONTAINER_TYPES,
  NODE_TYPE_INFO,
  NODE_TYPES,
  isNodeType,
  normalizeNodeType,
} from "./node-types";

describe("node taxonomy v2", () => {
  it("describes every type exactly once", () => {
    expect(new Set(NODE_TYPES).size).toBe(9);
    for (const type of NODE_TYPES) {
      expect(NODE_TYPE_INFO[type].label).toBeTruthy();
      expect(NODE_TYPE_INFO[type].question).toBeTruthy();
      expect(ALLOWED_CHILDREN[type]).toBeDefined();
    }
  });

  it("retires concept: legacy rows and model output become notes", () => {
    expect(isNodeType("concept")).toBe(false);
    expect(normalizeNodeType("concept")).toBe("note");
    expect(normalizeNodeType("big_task")).toBe("big_task");
    expect(normalizeNodeType("nonsense", "task")).toBe("task");
    expect(normalizeNodeType(undefined)).toBe("note");
  });

  it("puts big tasks and tasks in Todos, and never lists structure or knowledge there", () => {
    expect([...CHECKABLE_TYPES].sort()).toEqual(["big_task", "task"]);
    for (const type of ["area", "class", "idea", "note", "goal"] as const) {
      expect(CHECKABLE_TYPES.has(type)).toBe(false);
    }
  });

  it("only lets containers hold work; a big task holds phases and steps", () => {
    for (const type of NODE_TYPES) {
      const holdsWork = [...ALLOWED_CHILDREN[type]].some((child) => child !== "note");
      expect(holdsWork).toBe(CONTAINER_TYPES.has(type));
    }
    expect([...ALLOWED_CHILDREN.big_task].sort()).toEqual(["big_task", "note", "task"]);
    expect(ALLOWED_CHILDREN.note.size).toBe(0);
  });

});
