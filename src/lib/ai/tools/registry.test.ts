import { describe, it, expect } from "vitest";

import {
  getToolSchemas,
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

  it("mutation tools pause the loop", () => {
    expect(isPausingTool("propose_node")).toBe(true);
    expect(isMutationTool("propose_node")).toBe(true);
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
