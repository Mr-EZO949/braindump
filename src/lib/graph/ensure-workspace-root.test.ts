import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureWorkspaceRoot, ROOT_FALLBACK_TITLE } from "./ensure-workspace-root";

type Op = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
};

/** Minimal chainable stand-in for the Supabase query builder. */
function makeClient(respond: (op: Op) => { data?: unknown; error?: unknown }) {
  const calls: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, op: "select", filters: {} };
    const builder: Record<string, unknown> = {};
    const settle = () => {
      calls.push(op);
      return Promise.resolve(respond(op));
    };
    Object.assign(builder, {
      select: () => builder,
      insert: (payload: Record<string, unknown>) => {
        op.op = "insert";
        op.payload = payload;
        return builder;
      },
      update: (payload: Record<string, unknown>) => {
        op.op = "update";
        op.payload = payload;
        return builder;
      },
      delete: () => {
        op.op = "delete";
        return builder;
      },
      eq: (column: string, value: unknown) => {
        op.filters[column] = value;
        return builder;
      },
      maybeSingle: settle,
      single: settle,
      // Bare `await` on the builder (used for the update) resolves here.
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    });
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const BASE = { userId: "user-1", workspaceId: "ws-1" };

describe("ensureWorkspaceRoot", () => {
  it("reuses a live existing root instead of creating a second one", async () => {
    const { client, calls } = makeClient((op) => {
      if (op.table === "workspaces" && op.op === "select") {
        return { data: { id: "ws-1", name: "ezo", bootstrap_root_node_id: "root-1" } };
      }
      if (op.table === "nodes" && op.op === "select") return { data: { id: "root-1" } };
      return { data: null };
    });

    expect(await ensureWorkspaceRoot({ supabase: client, ...BASE })).toBe("root-1");
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("creates a root and points the workspace at it when there is none", async () => {
    const { client, calls } = makeClient((op) => {
      if (op.table === "workspaces" && op.op === "select") {
        return { data: { id: "ws-1", name: "ezo", bootstrap_root_node_id: null } };
      }
      if (op.table === "nodes" && op.op === "insert") return { data: { id: "root-new" } };
      if (op.table === "workspaces" && op.op === "update") return { error: null };
      return { data: null };
    });

    expect(await ensureWorkspaceRoot({ supabase: client, ...BASE })).toBe("root-new");

    const insert = calls.find((c) => c.op === "insert");
    expect(insert?.payload?.title).toBe("ezo");
    expect(insert?.payload?.status).toBe("active");
    // The root is the user's whole life — an area, never a goal (node types v2).
    expect(insert?.payload?.node_type).toBe("area");
    // Pinned low so the root never dominates the canvas.
    expect(insert?.payload?.manual_weight).toBe(30);

    const update = calls.find((c) => c.table === "workspaces" && c.op === "update");
    expect(update?.payload?.bootstrap_root_node_id).toBe("root-new");
  });

  it("recreates the root when the recorded one is archived or deleted", async () => {
    const { client, calls } = makeClient((op) => {
      if (op.table === "workspaces" && op.op === "select") {
        return { data: { id: "ws-1", name: "ezo", bootstrap_root_node_id: "root-dead" } };
      }
      if (op.table === "nodes" && op.op === "select") return { data: null };
      if (op.table === "nodes" && op.op === "insert") return { data: { id: "root-fresh" } };
      if (op.table === "workspaces" && op.op === "update") return { error: null };
      return { data: null };
    });

    expect(await ensureWorkspaceRoot({ supabase: client, ...BASE })).toBe("root-fresh");
    expect(calls.some((c) => c.op === "insert")).toBe(true);
  });

  it("cleans up the new root if the workspace can't be pointed at it", async () => {
    const { client, calls } = makeClient((op) => {
      if (op.table === "workspaces" && op.op === "select") {
        return { data: { id: "ws-1", name: "ezo", bootstrap_root_node_id: null } };
      }
      if (op.table === "nodes" && op.op === "insert") return { data: { id: "root-x" } };
      if (op.table === "workspaces" && op.op === "update") {
        return { error: { message: "column missing" } };
      }
      return { data: null };
    });

    expect(await ensureWorkspaceRoot({ supabase: client, ...BASE })).toBeNull();
    expect(calls.find((c) => c.op === "delete")?.filters.id).toBe("root-x");
  });

  it("falls back to a default title when the workspace name is blank", async () => {
    const { client, calls } = makeClient((op) => {
      if (op.table === "workspaces" && op.op === "select") {
        return { data: { id: "ws-1", name: "   ", bootstrap_root_node_id: null } };
      }
      if (op.table === "nodes" && op.op === "insert") return { data: { id: "r" } };
      if (op.table === "workspaces" && op.op === "update") return { error: null };
      return { data: null };
    });

    await ensureWorkspaceRoot({ supabase: client, ...BASE });
    expect(calls.find((c) => c.op === "insert")?.payload?.title).toBe(ROOT_FALLBACK_TITLE);
  });

  it("returns null when the workspace doesn't exist", async () => {
    const { client } = makeClient(() => ({ data: null }));
    expect(await ensureWorkspaceRoot({ supabase: client, ...BASE })).toBeNull();
  });
});
