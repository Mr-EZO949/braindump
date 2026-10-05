import { describe, it, expect } from "vitest";

import {
  getToolSchemas,
  isDirectTool,
  isPausingTool,
  isMutationTool,
  isReadOnlyTool,
  isInteractiveTool,
  turnNeedsNoFollowUp,
  asChangeOp,
  asPriorityOp,
  asNodeCompletion,
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

  it("write_steps is a planned mutation: its steps wait on a card (fix list #7)", () => {
    expect(getToolSchemas().some((s) => s.name === "write_steps")).toBe(true);
    expect(isMutationTool("write_steps")).toBe(true);
    expect(isPausingTool("write_steps")).toBe(true);
  });

  it("set_preferences is a direct tool; a suggested one waits (docs/preferences.md)", () => {
    expect(getToolSchemas().some((s) => s.name === "set_preferences")).toBe(true);
    expect(isDirectTool("set_preferences")).toBe(true);
    expect(isPausingTool("set_preferences", { source: "user", changes: [] })).toBe(false);
    expect(isPausingTool("set_preferences", { source: "suggestion", changes: [] })).toBe(true);
  });

  it("set_commitments is a direct tool: registered, applies without a pause", () => {
    expect(getToolSchemas().some((s) => s.name === "set_commitments")).toBe(true);
    expect(isDirectTool("set_commitments")).toBe(true);
    expect(isPausingTool("set_commitments")).toBe(false);
  });

  it("replan_today is a direct tool: the user's own request applies with Undo (#27)", () => {
    expect(getToolSchemas().some((s) => s.name === "replan_today")).toBe(true);
    expect(isDirectTool("replan_today")).toBe(true);
    expect(isPausingTool("replan_today", { source: "user" })).toBe(false);
    expect(isPausingTool("replan_today", { source: "suggestion" })).toBe(true);
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

describe("turnNeedsNoFollowUp (fix list #19)", () => {
  const result = (name: string, content: Record<string, unknown>, is_error = false) => ({
    name,
    tool_use_id: name,
    content: JSON.stringify(content),
    is_error,
  });
  const card = { added: [], done: [{ node_id: "n", title: "Gym" }], links: [], questions: [] };
  const turn = (results: ReturnType<typeof result>[], turns = [card], pending = null) =>
    ({ pending, turns, deferred: [], applied: [], results }) as unknown as Parameters<typeof turnNeedsNoFollowUp>[0];
  const changed = result("change", { accepted: true, applied: 2 });
  const priorities = result("update_priorities", { accepted: true, applied: [{ title: "Stats" }], failed: [] });

  it("a change and a priority update that both landed need no second round", () => {
    expect(turnNeedsNoFollowUp(turn([changed, priorities]), "did the gym — stats or internship?")).toBe(true);
  });

  it("a lookup, a failure or something left out goes back to the model", () => {
    expect(turnNeedsNoFollowUp(turn([changed, result("search_nodes", { results: [] })]), "x")).toBe(false);
    expect(turnNeedsNoFollowUp(turn([result("change", { accepted: false, error: "Not in this workspace" })]), "x")).toBe(false);
    expect(turnNeedsNoFollowUp(turn([result("change", { accepted: true, left_out: ["changes[1]"] })]), "x")).toBe(false);
    expect(
      turnNeedsNoFollowUp(turn([result("update_priorities", { accepted: true, applied: [{}], failed: [{}] })], []), "x"),
    ).toBe(false);
  });

  it("a lone direct change may be step one of a multi-step ask", () => {
    expect(turnNeedsNoFollowUp(turn([priorities], []), "stats is done")).toBe(true);
    expect(turnNeedsNoFollowUp(turn([priorities], []), "stats is done, then add the essay")).toBe(false);
  });
});

describe("asChangeOp", () => {
  it("a change op called as a tool becomes that op inside change", () => {
    expect(asChangeOp({ id: "t", name: "remove_edge", input: { source_node_id: "a", target_node_id: "b" } })).toEqual({
      id: "t",
      name: "change",
      input: { source: "suggestion", changes: [{ kind: "remove_edge", source_node_id: "a", target_node_id: "b" }] },
    });
    expect(asChangeOp({ id: "t", name: "complete", input: { source: "user", node_id: "n" } }).input).toEqual({
      source: "user",
      changes: [{ kind: "complete", node_id: "n" }],
    });
  });

  it("without a source: the user's when their message states it (#22), else a suggestion", () => {
    const gym = { id: "t", name: "complete", input: { node_id: "gym" } };
    expect(asChangeOp(gym, "went to the gym this morning, now plan my afternoon").input).toEqual({
      source: "user",
      changes: [{ kind: "complete", node_id: "gym" }],
    });
    expect((asChangeOp(gym, "what should I do next?").input as { source: string }).source).toBe("suggestion");
  });

  it("leaves real tools and unknown names alone", () => {
    const real = { id: "t", name: "change", input: {} };
    expect(asChangeOp(real)).toBe(real);
    const unknown = { id: "t", name: "teleport", input: {} };
    expect(asChangeOp(unknown)).toBe(unknown);
  });
});

describe("asPriorityOp", () => {
  it("a priority action called as a tool becomes an update_priorities row (#22)", () => {
    const message = "Did the gym. Also the CV update can wait till next week, should I focus on stats or the internship?";
    expect(asPriorityOp({ id: "t", name: "deprioritize", input: { node_id: "cv" } }, message).input).toEqual({
      source: "user",
      changes: [{ node_id: "cv", action: "deprioritize" }],
    });
    // Only asked about → the assistant's answer: a suggestion.
    expect((asPriorityOp({ id: "t", name: "focus", input: { node_id: "s" } }, message).input as { source: string }).source).toBe("suggestion");
  });

  it("leaves real tools and change ops alone", () => {
    const real = { id: "t", name: "update_priorities", input: {} };
    expect(asPriorityOp(real)).toBe(real);
    const change = { id: "t", name: "change", input: {} };
    expect(asPriorityOp(change)).toBe(change);
  });
});

describe("asNodeCompletion", () => {
  // A fake client: which ids exist in which table.
  const ctxWith = (rows: Record<string, string[]>) =>
    ({
      userId: "u",
      workspaceId: "w",
      userMessage: "went to the gym this morning, now plan my afternoon",
      supabase: {
        from: (table: string) => {
          let id = "";
          const q = {
            select: () => q,
            eq: (col: string, value: string) => {
              if (col === "id") id = value;
              return q;
            },
            maybeSingle: async () => ({ data: (rows[table] ?? []).includes(id) ? { id } : null }),
          };
          return q;
        },
      },
    }) as unknown as Parameters<typeof asNodeCompletion>[1];

  it("mark_task_done on a node's id is that node done, the user's when stated", async () => {
    const out = await asNodeCompletion({ id: "t", name: "mark_task_done", input: { task_id: "gym" } }, ctxWith({ nodes: ["gym"] }));
    expect(out).toEqual({ id: "t", name: "change", input: { source: "user", changes: [{ kind: "complete", node_id: "gym" }] } });
  });

  it("leaves a real calendar task, an unknown id and an undo alone", async () => {
    const task = { id: "t", name: "mark_task_done", input: { task_id: "x" } };
    expect(await asNodeCompletion(task, ctxWith({ plan_tasks: ["x"], nodes: ["x"] }))).toBe(task);
    expect(await asNodeCompletion(task, ctxWith({}))).toBe(task);
    const undo = { id: "t", name: "mark_task_done", input: { task_id: "gym", done: false } };
    expect(await asNodeCompletion(undo, ctxWith({ nodes: ["gym"] }))).toBe(undo);
  });
});
