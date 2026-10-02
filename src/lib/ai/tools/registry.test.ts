import { describe, it, expect } from "vitest";

import {
  getToolSchemas,
  isDirectTool,
  isPausingTool,
  isMutationTool,
  isReadOnlyTool,
  isInteractiveTool,
} from "./index";

describe("tool registry classification", () => {
  it("registers ask_choice as a callable tool", () => {
    expect(getToolSchemas().some((s) => s.name === "ask_choice")).toBe(true);
  });

  it("ask_choice is interactive + pausing, but not mutation or read-only", () => {
    expect(isInteractiveTool("ask_choice")).toBe(true);
    expect(isPausingTool("ask_choice")).toBe(true);
    expect(isMutationTool("ask_choice")).toBe(false);
    expect(isReadOnlyTool("ask_choice")).toBe(false);
  });

  it("graph changes go through ONE tool, change, next to build_graph (2026-10-02)", () => {
    const names = getToolSchemas().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["change", "build_graph"]));
    for (const retired of [
      "propose_node",
      "propose_nodes_batch",
      "propose_changes_batch",
      "propose_edge",
      "propose_merge",
      "update_node",
      "archive_node",
      "complete_node",
    ]) {
      expect(names).not.toContain(retired);
    }
    expect(isPausingTool("change")).toBe(true);
    expect(isMutationTool("change")).toBe(true);
  });

  it("set_commitments is a direct tool: registered, applies without a pause", () => {
    expect(getToolSchemas().some((s) => s.name === "set_commitments")).toBe(true);
    expect(isDirectTool("set_commitments")).toBe(true);
    expect(isPausingTool("set_commitments")).toBe(false);
  });

  it("a direct tool's call that only suggests waits on a card (owner, 2026-10-02)", () => {
    expect(isPausingTool("update_priorities", { source: "user", changes: [] })).toBe(false);
    expect(isPausingTool("update_priorities", { source: "suggestion", changes: [] })).toBe(true);
    expect(isPausingTool("set_commitments", { source: "suggestion", changes: [] })).toBe(true);
  });

  it("read-only tools do not pause and run eagerly", () => {
    expect(isReadOnlyTool("search_nodes")).toBe(true);
    expect(isPausingTool("search_nodes")).toBe(false);
  });

  it("ask_choice schema requires question + options", () => {
    const schema = getToolSchemas().find((s) => s.name === "ask_choice");
    expect(schema?.input_schema.required).toEqual(
      expect.arrayContaining(["question", "options"]),
    );
  });
});
