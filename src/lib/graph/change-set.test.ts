// One writer for AI graph changes. Whatever tool the change arrives through
// (propose_node, propose_nodes_batch, propose_changes_batch), a new node must
// come out as the same rows with the same follow-up work — the embedding, the
// accept event, the judgment. The model calls and the status engine are mocked:
// this is about what gets written.

import { beforeEach, describe, expect, it, vi } from "vitest";

const embedded: string[] = [];
vi.mock("@/lib/ai/embeddings", () => ({
  generateAndStoreEmbedding: vi.fn(async (params: { nodeId: string }) => {
    embedded.push(params.nodeId);
    return { ok: true };
  }),
}));

const judged: string[][] = [];
vi.mock("@/lib/ai/judgment", () => ({
  scoreNodesJudgment: vi.fn(async (params: { nodes: Array<{ id: string }> }) => {
    judged.push(params.nodes.map((n) => n.id));
    return [];
  }),
}));

let rescores = 0;
vi.mock("@/lib/ai/scoring", () => ({
  computeWorkspaceScores: vi.fn(async () => {
    rescores += 1;
    return { nodeUpdates: [] };
  }),
}));

let clusterPasses = 0;
vi.mock("@/lib/ai/clustering", () => ({
  runClusteringPass: vi.fn(async () => {
    clusterPasses += 1;
    return [];
  }),
}));

const transitions: Array<{ nodeId: string; newStatus: string }> = [];
vi.mock("@/lib/graph/status-transition", () => ({
  transitionNodeStatus: vi.fn(async (params: { nodeId: string; newStatus: string }) => {
    transitions.push({ nodeId: params.nodeId, newStatus: params.newStatus });
    return { kind: "changed", previousStatus: "active", autoCompletedNodeIds: [], newlyAvailable: [] };
  }),
}));

import { dispatchTool } from "@/lib/ai/tools";
import { createFakeSupabase, type FakeSupabase } from "@/lib/test/fake-supabase";

import { applyChangeSet } from "./change-set";

type Row = Record<string, unknown>;

const USER = "u1";
const WS = "w1";

function seed(): FakeSupabase {
  const node = (id: string, title: string, node_type: string): Row => ({
    id,
    user_id: USER,
    workspace_id: WS,
    title,
    summary: null,
    node_type,
    status: "active",
  });
  const parent = (id: string, child: string, target: string): Row => ({
    id,
    user_id: USER,
    workspace_id: WS,
    source_node_id: child,
    target_node_id: target,
    edge_type: "belongs_to",
    status: "active",
  });
  return createFakeSupabase({
    workspaces: [{ id: WS, user_id: USER, name: "ezo", bootstrap_root_node_id: "root" }],
    nodes: [
      node("root", "ezo", "area"),
      node("money", "Money Projects", "area"),
      node("fused", "Test & Market BrainDump", "big_task"),
      node("bugs", "Fix the 10 bugs", "task"),
      node("intern", "Internship in Milan", "goal"),
    ],
    edges: [
      parent("e-money", "money", "root"),
      parent("e-fused", "fused", "money"),
      parent("e-bugs", "bugs", "fused"),
      parent("e-intern", "intern", "root"),
    ],
    feedback_events: [],
  });
}

function ctxFor(db: FakeSupabase, extra: Record<string, unknown> = {}) {
  return {
    supabase: db.client,
    userId: USER,
    workspaceId: WS,
    selectedNodeId: null,
    today: "2026-09-30",
    ...extra,
  };
}

async function callTool(db: FakeSupabase, name: string, input: unknown, extra?: Record<string, unknown>) {
  const out = await dispatchTool({ name, input, tool_use_id: "t1", ctx: ctxFor(db, extra) });
  return JSON.parse(out.content) as Row;
}

const byTitle = (db: FakeSupabase, title: string) => db.tables.nodes.find((n) => n.title === title);
// The live parent of a node, by title.
function parentOf(db: FakeSupabase, title: string): string | undefined {
  const node = byTitle(db, title);
  const edge = db.tables.edges.find(
    (e) => e.source_node_id === node?.id && e.edge_type === "belongs_to" && e.status === "active",
  );
  return db.tables.nodes.find((n) => n.id === edge?.target_node_id)?.title as string | undefined;
}

beforeEach(() => {
  embedded.length = 0;
  judged.length = 0;
  transitions.length = 0;
  rescores = 0;
  clusterPasses = 0;
});

describe("chat tools write through the change set", () => {
  it("propose_node: creates the node under its parent", async () => {
    const db = seed();
    const result = await callTool(db, "propose_node", {
      title: "Email the recruiter",
      node_type: "task",
      parent_node_id: "intern",
      target_date: "2026-10-03",
    });

    expect(result).toMatchObject({
      accepted: true,
      title: "Email the recruiter",
      node_type: "task",
      parent_edge_created: true,
    });
    expect(byTitle(db, "Email the recruiter")).toMatchObject({
      node_type: "task",
      status: "active",
      importance_index: 50,
      target_date: "2026-10-03",
      workspace_id: WS,
    });
    expect(result.node_id).toBe(byTitle(db, "Email the recruiter")?.id);
    expect(parentOf(db, "Email the recruiter")).toBe("Internship in Milan");
  });

  it("propose_node: no parent given → the workspace root", async () => {
    const db = seed();
    const result = await callTool(db, "propose_node", { title: "Health", node_type: "area" });
    expect(result.accepted).toBe(true);
    expect(parentOf(db, "Health")).toBe("ezo");
  });

  it("propose_node: an unknown parent is refused and nothing is written", async () => {
    const db = seed();
    const result = await callTool(db, "propose_node", {
      title: "Lost",
      node_type: "task",
      parent_node_id: "nope",
    });
    expect(result.accepted).toBe(false);
    expect(byTitle(db, "Lost")).toBeUndefined();
  });

  it("propose_nodes_batch: nests by local_ref, even when the parent is listed later", async () => {
    const db = seed();
    const result = await callTool(db, "propose_nodes_batch", {
      nodes: [
        { title: "Draft the CV", node_type: "task", parent_local_ref: "p" },
        { local_ref: "p", title: "Internship search", node_type: "project", parent_node_id: "intern" },
        { title: "List 10 companies", node_type: "task", parent_local_ref: "p" },
      ],
    });

    expect(result.accepted).toBe(true);
    expect((result.created as Row[]).map((c) => c.title)).toEqual([
      "Draft the CV",
      "Internship search",
      "List 10 companies",
    ]);
    expect((result.created as Row[]).every((c) => c.parent_edge_created === true)).toBe(true);
    expect(parentOf(db, "Internship search")).toBe("Internship in Milan");
    expect(parentOf(db, "Draft the CV")).toBe("Internship search");
    expect(parentOf(db, "List 10 companies")).toBe("Internship search");
  });

  it("propose_nodes_batch: one bad item refuses the whole batch", async () => {
    const db = seed();
    const result = await callTool(db, "propose_nodes_batch", {
      nodes: [
        { title: "Fine", node_type: "task" },
        { title: "", node_type: "task" },
      ],
    });
    expect(result.accepted).toBe(false);
    expect(byTitle(db, "Fine")).toBeUndefined();
  });

  it("propose_changes_batch: a restructure lands in one go", async () => {
    const db = seed();
    const result = await callTool(db, "propose_changes_batch", {
      changes: [
        { kind: "create_node", local_ref: "p", title: "BrainDump", node_type: "project", parent_node_id: "money" },
        { kind: "update", node_id: "fused", title: "Test BrainDump" },
        { kind: "move", node_id: "fused", new_parent_node_id: "p" },
        { kind: "create_node", title: "Market BrainDump", node_type: "big_task", parent_node_id: "p" },
        { kind: "create_edge", source_node_id: "p", target_node_id: "intern", edge_type: "useful_for" },
        { kind: "complete", node_id: "bugs" },
      ],
    });

    expect(result).toMatchObject({ accepted: true, applied: 6, total: 6, message: "Applied 6 changes ✓" });
    expect(parentOf(db, "BrainDump")).toBe("Money Projects");
    expect(parentOf(db, "Test BrainDump")).toBe("BrainDump");
    expect(parentOf(db, "Market BrainDump")).toBe("BrainDump");
    // The old parent link is released, not left beside the new one.
    expect(db.tables.edges.find((e) => e.id === "e-fused")?.status).toBe("orphaned");
    const project = byTitle(db, "BrainDump");
    expect(
      db.tables.edges.some(
        (e) => e.source_node_id === project?.id && e.target_node_id === "intern" && e.edge_type === "useful_for",
      ),
    ).toBe(true);
    expect(transitions).toEqual([{ nodeId: "bugs", newStatus: "completed" }]);
  });

  it("propose_changes_batch: a loop is refused and reported, the rest applies", async () => {
    const db = seed();
    const result = await callTool(db, "propose_changes_batch", {
      changes: [
        { kind: "move", node_id: "fused", new_parent_node_id: "bugs" },
        { kind: "update", node_id: "bugs", title: "Fix the bugs" },
      ],
    });

    expect(result).toMatchObject({ accepted: true, applied: 1, total: 2 });
    expect(String(result.error)).toContain("1 of 2");
    expect(parentOf(db, "Test & Market BrainDump")).toBe("Money Projects");
    expect(byTitle(db, "Fix the bugs")).toBeDefined();
  });
});

describe("a new node gets the same intake through every door", () => {
  const doors: Array<[string, unknown]> = [
    ["propose_node", { title: "Write the cover letter", node_type: "task", parent_node_id: "intern" }],
    [
      "propose_nodes_batch",
      { nodes: [{ title: "Write the cover letter", node_type: "task", parent_node_id: "intern" }] },
    ],
    [
      "propose_changes_batch",
      {
        changes: [
          { kind: "create_node", title: "Write the cover letter", node_type: "task", parent_node_id: "intern" },
        ],
      },
    ],
  ];

  it.each(doors)("%s", async (tool, input) => {
    const db = seed();
    await callTool(db, tool, input);

    const node = byTitle(db, "Write the cover letter");
    expect(node).toMatchObject({
      node_type: "task",
      status: "active",
      importance: "medium",
      importance_index: 50,
      color: expect.any(String),
    });
    expect(parentOf(db, "Write the cover letter")).toBe("Internship in Milan");
    // Embedded (dedup and connections can see it) and logged as accepted
    // (ranking's user-confirmation signal, as for a dump's accepted proposal).
    expect(embedded).toEqual([node?.id]);
    expect(db.tables.feedback_events).toEqual([
      expect.objectContaining({
        event_type: "accept_node",
        entity_type: "node",
        entity_id: node?.id,
        user_id: USER,
        workspace_id: WS,
        metadata: expect.objectContaining({ source: "chat" }),
      }),
    ]);
    expect(judged).toEqual([[node?.id]]);
    expect(rescores).toBe(1);
  });
});

describe("applyChangeSet intake", () => {
  it("judges work and structure, not ideas and notes", async () => {
    const db = seed();
    await applyChangeSet(ctxFor(db), [
      { kind: "create_node", title: "Noah is my TA", node_type: "note", parent_node_id: "intern" },
      { kind: "create_node", title: "Maybe resell clothes", node_type: "idea", parent_node_id: "money" },
    ]);
    expect(embedded).toHaveLength(2);
    expect(judged).toEqual([]);
    expect(rescores).toBe(1);
  });

  it("defers the slow part: embedding and the accept event land first", async () => {
    const db = seed();
    const deferred: Array<() => Promise<void>> = [];
    const outcome = await applyChangeSet(
      ctxFor(db, { defer: (work: () => Promise<void>) => deferred.push(work) }),
      [{ kind: "create_node", title: "Book the flight", node_type: "task", parent_node_id: "intern" }],
    );

    expect(outcome.results[0]).toMatchObject({ ok: true });
    expect(embedded).toHaveLength(1);
    expect(db.tables.feedback_events).toHaveLength(1);
    expect(judged).toEqual([]);
    expect(rescores).toBe(0);

    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(judged).toHaveLength(1);
    expect(rescores).toBe(1);
  });

  it("looks for groupings only when a node landed at the top level", async () => {
    const nested = seed();
    await applyChangeSet(ctxFor(nested), [
      { kind: "create_node", title: "Book the flight", node_type: "task", parent_node_id: "intern" },
    ]);
    expect(clusterPasses).toBe(0);

    const top = seed();
    await applyChangeSet(ctxFor(top), [{ kind: "create_node", title: "Health", node_type: "area" }]);
    expect(clusterPasses).toBe(1);
  });

  it("an update in a batch can set the deadline", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [
      { kind: "update", node_id: "intern", target_date: "2026-11-15" },
    ]);
    expect(outcome.results[0]).toMatchObject({ ok: true });
    expect(db.tables.nodes.find((n) => n.id === "intern")?.target_date).toBe("2026-11-15");
    expect(rescores).toBe(1);
    // Nothing was created: no intake.
    expect(embedded).toEqual([]);
    expect(db.tables.feedback_events).toEqual([]);
  });

  it("a workspace with no root gets one instead of floating nodes", async () => {
    const db = seed();
    db.tables.workspaces[0].bootstrap_root_node_id = null;
    await applyChangeSet(ctxFor(db), [{ kind: "create_node", title: "Health", node_type: "area" }]);

    const rootId = db.tables.workspaces[0].bootstrap_root_node_id;
    expect(rootId).toBeTruthy();
    const health = byTitle(db, "Health");
    expect(
      db.tables.edges.some(
        (e) => e.source_node_id === health?.id && e.target_node_id === rootId && e.edge_type === "belongs_to",
      ),
    ).toBe(true);
  });
});
