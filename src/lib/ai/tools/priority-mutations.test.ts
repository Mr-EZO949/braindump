// update_priorities as a DIRECT tool: it applies at once and returns an undo
// snapshot of exactly the fields it touched; undoPriorityChanges puts them
// back. The status engine and the scorer are mocked — this is about what gets
// written, in what order.

import { beforeEach, describe, expect, it, vi } from "vitest";

const transitions: Array<{ nodeId: string; newStatus: string }> = [];
vi.mock("@/lib/graph/status-transition", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/graph/status-transition")>()),
  transitionNodeStatus: vi.fn(async (params: { nodeId: string; newStatus: string }) => {
    transitions.push({ nodeId: params.nodeId, newStatus: params.newStatus });
    return { kind: "ok" };
  }),
}));

const scoreUpdates: Array<{ id: string; current_importance_score: number }> = [];
vi.mock("@/lib/ai/scoring", () => ({
  computeWorkspaceScores: vi.fn(async () => ({ nodeUpdates: scoreUpdates })),
}));

import { applyPriorityChanges, undoPriorityChanges } from "./priority-mutations";
import { dispatchEager, isDirectTool, isPausingTool } from "./index";
import type { ToolContext } from "./read-only";

type Row = Record<string, unknown>;

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const C = "aaaaaaaa-0000-4000-8000-000000000003";
const D = "aaaaaaaa-0000-4000-8000-000000000004";

// Reads come from `nodes`; writes are recorded (not applied).
function fakeCtx(nodes: Row[]) {
  const writes: Array<{ table: string; op: string; payload: Row; id?: unknown }> = [];
  const from = (table: string) => {
    let rows = table === "nodes" ? nodes : [];
    let write: { op: string; payload: Row } | null = null;
    let idFilter: unknown;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        if (col === "id") idFilter = val;
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        if (write) writes.push({ table, ...write, id: idFilter });
        return Promise.resolve(write ? { data: null, error: null } : { data: rows, error: null }).then(
          resolve,
          reject,
        );
      },
    };
    for (const op of ["update", "insert"]) {
      builder[op] = (payload: Row) => {
        write = { op, payload };
        return builder;
      };
    }
    return builder;
  };
  const ctx = {
    supabase: { from },
    userId: "u1",
    workspaceId: "w1",
    selectedNodeId: null,
    today: "2026-10-07",
  } as unknown as ToolContext;
  return { ctx, writes };
}

function node(id: string, title: string, extra: Row = {}): Row {
  return {
    id,
    title,
    status: "active",
    current_importance_score: 50,
    stakes: null,
    target_date: null,
    waiting_for: null,
    resume_on: null,
    ...extra,
  };
}

beforeEach(() => {
  transitions.length = 0;
  scoreUpdates.length = 0;
});

describe("applyPriorityChanges", () => {
  it("applies each change and snapshots only the fields it touched", async () => {
    const { ctx, writes } = fakeCtx([
      node(A, "Stats exam", { current_importance_score: 72 }),
      node(B, "Masters application"),
      node(C, "Psychology exam", { target_date: "2026-10-20" }),
      node(D, "Italian", { stakes: 1 }),
    ]);
    scoreUpdates.push(
      { id: A, current_importance_score: 30 },
      { id: B, current_importance_score: 64 },
    );

    const result = await applyPriorityChanges(ctx, {
      changes: [
        { node_id: A, title: "stats", action: "wait", waiting_for: "exam result", check_back_on: "2026-10-15" },
        { node_id: B, title: "masters", action: "focus" },
        { node_id: C, title: "psych", action: "deadline", target_date: "2026-10-09" },
        { node_id: D, title: "italian", action: "stakes", stakes: "normal" },
      ],
    });

    expect(result.accepted).toBe(true);
    if (!("undo" in result) || !result.undo) throw new Error("no undo");
    expect(transitions).toEqual([{ nodeId: A, newStatus: "paused" }]);
    expect(result.undo.nodes).toEqual([
      { node_id: A, status: "active", waiting_for: null, resume_on: null },
      { node_id: C, target_date: "2026-10-20" },
      { node_id: D, stakes: 1 },
    ]);
    expect(result.undo.steer).toEqual([{ node_id: B, event_type: "boost_node" }]);

    // Real titles and state-style details for the card; unchanged scores stay put.
    expect(result.applied).toEqual([
      expect.objectContaining({ title: "Stats exam", detail: "Waiting for exam result · check back Oct 15", score_before: 72, score_after: 30 }),
      expect.objectContaining({ title: "Masters application", detail: "Focus this week", score_before: 50, score_after: 64 }),
      expect.objectContaining({ title: "Psychology exam", detail: "Due Oct 9", score_after: 50 }),
      expect.objectContaining({ title: "Italian", detail: "Normal stakes" }),
    ]);
    expect(writes.filter((w) => w.table === "feedback_events").map((w) => w.payload.event_type)).toEqual([
      "boost_node",
      "set_deadline",
      "set_stakes",
    ]);
  });

  it("reports a node that isn't in the workspace without an undo", async () => {
    const { ctx } = fakeCtx([]);
    const result = await applyPriorityChanges(ctx, { changes: [{ node_id: A, title: "x", action: "focus" }] });
    expect(result).toEqual({ accepted: false, error: "x: node not found in this workspace" });
  });
});

describe("undoPriorityChanges", () => {
  it("restores status first, then the touched fields, and cancels steering", async () => {
    const { ctx, writes } = fakeCtx([
      node(A, "Stats exam", { status: "paused", waiting_for: "exam result", resume_on: "2026-10-15" }),
      node(C, "Psychology exam", { target_date: "2026-10-09" }),
    ]);
    const result = await undoPriorityChanges(ctx, {
      nodes: [
        { node_id: A, status: "active", waiting_for: null, resume_on: null },
        { node_id: C, target_date: "2026-10-20" },
      ],
      steer: [{ node_id: B, event_type: "boost_node" }],
    });

    expect(result).toEqual({ ok: true });
    expect(transitions).toEqual([{ nodeId: A, newStatus: "active" }]);
    const nodeWrites = writes.filter((w) => w.table === "nodes");
    // Leaving paused already cleared the waiting fields — no patch for A.
    expect(nodeWrites.map((w) => [w.id, Object.keys(w.payload).filter((k) => k !== "updated_at")])).toEqual([
      [C, ["target_date"]],
    ]);
    const steer = writes.find((w) => w.table === "feedback_events");
    expect(steer?.payload).toMatchObject({ event_type: "demote_node", entity_id: B, metadata: { source: "undo" } });
  });

  it("brings a completed node back to waiting through active", async () => {
    const { ctx, writes } = fakeCtx([node(A, "Stats exam", { status: "completed" })]);
    await undoPriorityChanges(ctx, {
      nodes: [{ node_id: A, status: "paused", waiting_for: "exam result", resume_on: "2026-10-15" }],
      steer: [],
    });
    expect(transitions.map((t) => t.newStatus)).toEqual(["active", "paused"]);
    expect(writes.find((w) => w.table === "nodes")?.payload).toMatchObject({
      waiting_for: "exam result",
      resume_on: "2026-10-15",
    });
  });
});

describe("direct tool dispatch", () => {
  it("update_priorities runs without a pause", () => {
    expect(isDirectTool("update_priorities")).toBe(true);
    expect(isPausingTool("update_priorities")).toBe(false);
    expect(isDirectTool("propose_node")).toBe(false);
  });

  it("sends the undo snapshot to the browser, not to the model", async () => {
    const { ctx } = fakeCtx([node(A, "Stats exam")]);
    const { result, applied } = await dispatchEager({
      name: "update_priorities",
      input: { changes: [{ node_id: A, title: "Stats exam", action: "focus" }] },
      tool_use_id: "tu1",
      ctx,
    });
    expect(JSON.parse(result.content)).not.toHaveProperty("undo");
    expect(JSON.parse(result.content)).toMatchObject({ accepted: true });
    expect(applied?.undo).toEqual({ nodes: [], steer: [{ node_id: A, event_type: "boost_node" }] });
    expect(applied?.applied[0]).toMatchObject({ title: "Stats exam", detail: "Focus this week" });
  });

  it("a failed change produces no applied card", async () => {
    const { ctx } = fakeCtx([]);
    const { applied } = await dispatchEager({
      name: "update_priorities",
      input: { changes: [{ node_id: A, title: "x", action: "focus" }] },
      tool_use_id: "tu1",
      ctx,
    });
    expect(applied).toBeNull();
  });
});
