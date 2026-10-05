// One writer for AI graph changes. Whatever door a change comes through —
// chat's change tool (applied at once, or accepted on its card) or a change
// set applied directly — a new node must come out as the same rows with the
// same follow-up work: the embedding, the accept event, the judgment. And
// every change it makes can be put back (change-undo.ts). The model calls and
// the status engine are mocked: this is about what gets written.

import { beforeEach, describe, expect, it, vi } from "vitest";

const embedded: string[] = [];
vi.mock("@/lib/ai/embeddings", () => ({
  generateAndStoreEmbeddings: vi.fn(async (params: { nodes: Array<{ nodeId: string }> }) => {
    embedded.push(...params.nodes.map((node) => node.nodeId));
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
  VALID_TRANSITIONS: {
    active: ["completed", "paused", "archived"],
    completed: ["active", "archived"],
    paused: ["active", "completed", "archived"],
    archived: ["active"],
  },
  transitionNodeStatus: vi.fn(async (params: { nodeId: string; newStatus: string }) => {
    transitions.push({ nodeId: params.nodeId, newStatus: params.newStatus });
    return { kind: "changed", previousStatus: "active", autoCompletedNodeIds: [], newlyAvailable: [] };
  }),
}));

import { applyTurnChanges } from "@/lib/ai/dump-turn";
import { dispatchTool } from "@/lib/ai/tools";
import { describeChange, namerFor } from "@/lib/chat/change-describe";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { planChange } from "@/lib/ai/tools/change";
import { createFakeSupabase, type FakeSupabase } from "@/lib/test/fake-supabase";

import { applyChangeSet, type ChangeOp } from "./change-set";
import { parseUndoSteps, undoChangeSteps } from "./change-undo";

type Row = Record<string, unknown>;

const USER = "u1";
const WS = "w1";

function seed(options?: Parameters<typeof createFakeSupabase>[1]): FakeSupabase {
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
    raw_entries: [],
    proposed_nodes: [],
    habit_completions: [],
  }, options);
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

describe("chat's change tool: what the user said applies, the rest waits", () => {
  it("a stated capture, completion and link apply at once — with Undo, nothing on a card", async () => {
    const db = seed();
    const plan = await planChange(
      {
        source: "user",
        changes: [
          { kind: "create_node", title: "Email the recruiter", node_type: "task", parent_node_id: "intern", target_date: "2026-10-03" },
          { kind: "complete", node_id: "bugs" },
          { kind: "create_edge", source_node_id: "fused", target_node_id: "intern", edge_type: "useful_for" },
        ],
      },
      ctxFor(db, { userMessage: "add email the recruiter, fixed the bugs, and testing helps the internship" }),
    );

    expect(plan.waiting).toBeNull();
    expect(plan.turn?.added).toEqual([
      expect.objectContaining({ title: "Email the recruiter", node_type: "task", parent_title: "Internship in Milan" }),
    ]);
    expect(plan.turn?.done).toEqual(["Fix the 10 bugs"]);
    expect(plan.turn?.links).toEqual([
      { source_title: "Test & Market BrainDump", target_title: "Internship in Milan", edge_type: "useful_for" },
    ]);
    expect(plan.result).toMatchObject({ accepted: true, applied: 3 });
    expect(byTitle(db, "Email the recruiter")).toMatchObject({ target_date: "2026-10-03" });
    expect(parentOf(db, "Email the recruiter")).toBe("Internship in Milan");
    expect(transitions).toEqual([{ nodeId: "bugs", newStatus: "completed" }]);
    // One undo step per applied section.
    expect(plan.turn?.undo?.added).toHaveLength(1);
    expect(plan.turn?.undo?.done).toHaveLength(1);
    expect(plan.turn?.undo?.links).toHaveLength(1);
    // The ledger: the chat message as an entry, the node as an accepted proposal.
    expect(db.tables.raw_entries).toEqual([expect.objectContaining({ source_type: "assistant_save", status: "completed" })]);
    expect(db.tables.proposed_nodes).toEqual([
      expect.objectContaining({ proposed_title: "Email the recruiter", proposal_status: "accepted", accepted_node_id: byTitle(db, "Email the recruiter")?.id }),
    ]);
  });

  it("a reorganization waits as one unit: the new parent, the move, the rename", async () => {
    const db = seed();
    const plan = await planChange(
      {
        source: "user",
        changes: [
          { kind: "create_node", local_ref: "p", title: "BrainDump", node_type: "project", parent_node_id: "money" },
          { kind: "update", node_id: "fused", title: "Test BrainDump" },
          { kind: "move", node_id: "fused", new_parent_node_id: "p" },
          { kind: "create_node", title: "Call the bank", node_type: "task" },
        ],
      },
      ctxFor(db),
    );

    // Only the unrelated capture went in.
    expect(plan.turn?.added.map((n) => n.title)).toEqual(["Call the bank"]);
    expect(byTitle(db, "BrainDump")).toBeUndefined();
    expect(byTitle(db, "Test & Market BrainDump")).toBeDefined();
    expect(plan.waiting?.changes.map((op) => op.kind)).toEqual(["create_node", "update", "move"]);
    // The card names the node by its title before the rename.
    expect(plan.waiting?.changes[1]).toMatchObject({ before_title: "Test & Market BrainDump" });
  });

  it("the assistant's own suggestion writes nothing — it all waits, marked as a suggestion", async () => {
    const db = seed();
    const plan = await planChange(
      {
        source: "suggestion",
        changes: [{ kind: "create_node", title: "Block 2h for Prob 2", node_type: "task", parent_node_id: "intern" }],
      },
      ctxFor(db),
    );
    expect(plan.turn).toMatchObject({ added: [], done: [], links: [] });
    expect(plan.waiting).toMatchObject({ suggested: true, origin: "chat" });
    expect(byTitle(db, "Block 2h for Prob 2")).toBeUndefined();
    expect(db.tables.proposed_nodes).toEqual([]);
  });

  it("no source given counts as a suggestion — the safe side is a card", async () => {
    const db = seed();
    const plan = await planChange({ changes: [{ kind: "complete", node_id: "bugs" }] }, ctxFor(db));
    expect(plan.waiting?.suggested).toBe(true);
    expect(transitions).toEqual([]);
  });

  it("an id that isn't in the workspace is refused and nothing is written", async () => {
    const db = seed();
    const plan = await planChange(
      {
        source: "user",
        changes: [{ kind: "create_node", title: "Lost", node_type: "task", parent_node_id: "nope" }],
      },
      ctxFor(db),
    );
    expect(plan.result).toMatchObject({ accepted: false });
    expect(String(plan.result.error)).toContain("Not in this workspace");
    expect(byTitle(db, "Lost")).toBeUndefined();
  });

  it("a parent link is a move — it waits", async () => {
    const db = seed();
    const plan = await planChange(
      {
        source: "user",
        changes: [{ kind: "create_edge", source_node_id: "bugs", target_node_id: "intern", edge_type: "belongs_to" }],
      },
      ctxFor(db),
    );
    expect(plan.waiting?.changes).toEqual([{ kind: "move", node_id: "bugs", new_parent_node_id: "intern" }]);
    expect(parentOf(db, "Fix the 10 bugs")).toBe("Test & Market BrainDump");
  });

  it("the accepted rows of a card apply, with their undo steps", async () => {
    const db = seed();
    const result = await callTool(db, "change", {
      changes: [
        { kind: "create_node", local_ref: "p", title: "BrainDump", node_type: "project", parent_node_id: "money" },
        { kind: "update", node_id: "fused", title: "Test BrainDump" },
        { kind: "move", node_id: "fused", new_parent_node_id: "p" },
      ],
      origin: "chat",
    });
    expect(result).toMatchObject({ accepted: true, applied: 3, total: 3, message: "Applied 3 changes ✓" });
    expect(parentOf(db, "Test BrainDump")).toBe("BrainDump");
    expect(db.tables.edges.find((e) => e.id === "e-fused")?.status).toBe("orphaned");
    expect((result.undo as unknown[]).length).toBe(3);
  });

  it("a loop is refused and reported, the rest applies", async () => {
    const db = seed();
    const result = await callTool(db, "change", {
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

describe("a dump's or build_graph's waiting rows", () => {
  it("a rename keeps its old title, so the row still reads right after Apply (#10)", async () => {
    const db = seed();
    const changes = await applyTurnChanges({
      ctx: ctxFor(db),
      ops: [{ kind: "update", node_id: "fused", title: "Test BrainDump" }],
      ledger: [],
      held: new Set(),
      autoApply: false,
      source: "dump",
    });
    expect(changes.waiting).toEqual([
      { kind: "update", node_id: "fused", title: "Test BrainDump", before_title: "Test & Market BrainDump" },
    ]);

    // Applied: the graph now calls the node by its new title.
    const nameOf = namerFor(changes.waiting, new Map([["fused", "Test BrainDump"]]));
    expect(describeChange(changes.waiting[0], nameOf)).toBe('Test & Market BrainDump: rename to "Test BrainDump"');
  });
});

describe("Undo puts each change back", () => {
  const undoAll = async (db: FakeSupabase, steps: unknown[]) =>
    undoChangeSteps(ctxFor(db), parseUndoSteps(JSON.parse(JSON.stringify(steps))));

  it("a new node is removed again", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [
      { kind: "create_node", title: "Book the flight", node_type: "task", parent_node_id: "intern" },
    ]);
    expect(byTitle(db, "Book the flight")).toBeDefined();
    const result = await undoAll(db, outcome.undo.map((u) => u.step));
    expect(result).toEqual({ undone: 1, failed: [] });
    expect(byTitle(db, "Book the flight")).toBeUndefined();
  });

  it("a move goes back under the old parent, a rename gets its old title", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [
      { kind: "update", node_id: "fused", title: "Test BrainDump" },
      { kind: "move", node_id: "fused", new_parent_node_id: "intern" },
    ]);
    expect(parentOf(db, "Test BrainDump")).toBe("Internship in Milan");
    await undoAll(db, outcome.undo.map((u) => u.step));
    expect(byTitle(db, "Test & Market BrainDump")).toBeDefined();
    expect(parentOf(db, "Test & Market BrainDump")).toBe("Money Projects");
  });

  it("a completion reopens", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [{ kind: "complete", node_id: "bugs" }]);
    expect(outcome.undo.map((u) => u.step)).toEqual([{ kind: "restore_status", node_id: "bugs", status: "active" }]);
    // The status engine is mocked: mark it done by hand, as it would.
    db.tables.nodes.find((n) => n.id === "bugs")!.status = "completed";
    transitions.length = 0;
    await undoAll(db, outcome.undo.map((u) => u.step));
    expect(transitions).toEqual([{ nodeId: "bugs", newStatus: "active" }]);
  });

  it("a habit check-in is taken back — but not one the user had already made today", async () => {
    const db = seed();
    const habitLogged = (alreadyLogged: boolean) => ({
      kind: "habit_logged" as const,
      nodeId: "gym",
      status: "active" as const,
      loggedOn: "2026-09-30",
      alreadyLogged,
    });

    vi.mocked(transitionNodeStatus).mockResolvedValueOnce(habitLogged(false));
    const fresh = await applyChangeSet(ctxFor(db), [{ kind: "complete", node_id: "gym" }]);
    expect(fresh.results[0]).toMatchObject({ ok: true, detail: "habit_logged" });
    expect(fresh.undo.map((u) => u.step)).toEqual([{ kind: "unlog_habit", node_id: "gym", date: "2026-09-30" }]);

    // Ticked by hand this morning: the chat card's Undo must not remove that.
    vi.mocked(transitionNodeStatus).mockResolvedValueOnce(habitLogged(true));
    const again = await applyChangeSet(ctxFor(db), [{ kind: "complete", node_id: "gym" }]);
    expect(again.results[0]).toMatchObject({ ok: true, detail: "habit_logged" });
    expect(again.undo).toEqual([]);
  });

  it("a link added is taken away; a link removed comes back", async () => {
    const db = seed();
    db.tables.edges.push({
      id: "e-lat",
      user_id: USER,
      workspace_id: WS,
      source_node_id: "bugs",
      target_node_id: "intern",
      edge_type: "supports",
      status: "active",
      explanation: "fixing bugs shows skill",
    });
    const added = await applyChangeSet(ctxFor(db), [
      { kind: "create_edge", source_node_id: "money", target_node_id: "intern", edge_type: "useful_for" },
    ]);
    const removed = await applyChangeSet(ctxFor(db), [
      { kind: "remove_edge", source_node_id: "intern", target_node_id: "bugs" },
    ]);
    expect(removed.results[0]).toMatchObject({ ok: true });
    expect(db.tables.edges.some((e) => e.id === "e-lat")).toBe(false);
    // The parent link of "bugs" is never touched by an unlink.
    expect(parentOf(db, "Fix the 10 bugs")).toBe("Test & Market BrainDump");

    await undoAll(db, [...added.undo, ...removed.undo].map((u) => u.step));
    expect(db.tables.edges.some((e) => e.source_node_id === "money" && e.edge_type === "useful_for")).toBe(false);
    expect(
      db.tables.edges.some(
        (e) => e.source_node_id === "bugs" && e.target_node_id === "intern" && e.edge_type === "supports" && e.status === "active",
      ),
    ).toBe(true);
  });

  it("an unlink with nothing to remove fails instead of claiming success", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [
      { kind: "remove_edge", source_node_id: "money", target_node_id: "intern" },
    ]);
    expect(outcome.results[0]).toMatchObject({ ok: false, error: "no link between those nodes" });
  });

  it("a delete takes the subtree, has no undo, and never takes the root", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [{ kind: "delete_node", node_id: "money" }]);
    expect(outcome.results[0]).toMatchObject({ ok: true, detail: "3 node(s) deleted" });
    expect(db.tables.nodes.map((n) => n.id).sort()).toEqual(["intern", "root"]);
    expect(outcome.undo).toEqual([]);

    const root = await applyChangeSet(ctxFor(db), [{ kind: "delete_node", node_id: "root" }]);
    expect(root.results[0]).toMatchObject({ ok: false });
  });

  it("malformed steps from the browser are dropped, not guessed at", () => {
    expect(
      parseUndoSteps([
        { kind: "remove_node", node_id: "x'; drop table nodes; --" },
        { kind: "drop_table" },
        { kind: "restore_status", node_id: "11111111-1111-1111-1111-111111111111", status: "deleted" },
        { kind: "restore_parent", node_id: "11111111-1111-1111-1111-111111111111", parent_id: null },
      ]),
    ).toEqual([{ kind: "restore_parent", node_id: "11111111-1111-1111-1111-111111111111", parent_id: null }]);
  });
});

describe("a new node gets the same intake through every door", () => {
  const input = { title: "Write the cover letter", node_type: "task", parent_node_id: "intern" };
  const doors: Array<[string, (db: FakeSupabase) => Promise<unknown>]> = [
    ["chat, applied at once", (db) => planChange({ source: "user", changes: [{ kind: "create_node", ...input }] }, ctxFor(db))],
    ["chat, accepted on the card", (db) => callTool(db, "change", { changes: [{ kind: "create_node", ...input }] })],
    ["a change set applied directly", (db) => applyChangeSet(ctxFor(db), [{ kind: "create_node", ...input }])],
  ];

  it.each(doors)("%s", async (_door, run) => {
    const db = seed();
    await run(db);

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

describe("a long dump's change set doesn't wait on itself", () => {
  const dump = (steps: number): ChangeOp[] => [
    { kind: "create_node", local_ref: "n0", title: "Course project", node_type: "big_task", parent_node_id: "money" },
    ...Array.from({ length: steps }, (_, k): ChangeOp => ({
      kind: "create_node",
      local_ref: `n${k + 1}`,
      title: `Step ${k + 1}`,
      node_type: "task",
      parent_local_ref: "n0",
    })),
    { kind: "create_node", title: "Call the bank", node_type: "task" },
  ];

  it("new nodes and their parent links go in together, however many there are", async () => {
    const small = seed();
    const big = seed();
    await applyChangeSet(ctxFor(small), dump(1));
    const outcome = await applyChangeSet(ctxFor(big), dump(7));

    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(parentOf(big, "Course project")).toBe("Money Projects");
    expect(parentOf(big, "Step 7")).toBe("Course project");
    expect(parentOf(big, "Call the bank")).toBe("ezo");
    // Seven steps wait on the database as long as one does.
    expect(big.stats.depth).toBe(small.stats.depth);
  });

  it("a node that can't be saved fails alone; the rest still go in under their parents", async () => {
    const db = seed({ unique: { nodes: ["title"] } });
    const outcome = await applyChangeSet(ctxFor(db), [
      { kind: "create_node", local_ref: "n1", title: "Course project", node_type: "big_task", parent_node_id: "money" },
      { kind: "create_node", title: "Money Projects", node_type: "area" },
      { kind: "create_node", title: "Pick a dataset", node_type: "task", parent_local_ref: "n1" },
    ]);

    expect(outcome.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(outcome.created.map((n) => n.title)).toEqual(["Course project", "Pick a dataset"]);
    expect(parentOf(db, "Pick a dataset")).toBe("Course project");
    expect(outcome.undo.map((u) => u.index)).toEqual([0, 2]);
  });

  it("links side by side go in together; the same link twice is made once", async () => {
    const one = seed();
    await applyChangeSet(ctxFor(one), [
      { kind: "create_edge", source_node_id: "bugs", target_node_id: "intern", edge_type: "supports" },
    ]);
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [
      { kind: "create_edge", source_node_id: "bugs", target_node_id: "intern", edge_type: "supports" },
      { kind: "create_edge", source_node_id: "money", target_node_id: "intern", edge_type: "useful_for" },
      { kind: "create_edge", source_node_id: "bugs", target_node_id: "intern", edge_type: "supports" },
    ]);

    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(db.tables.edges.filter((e) => e.edge_type !== "belongs_to")).toHaveLength(2);
    // Undo takes away each link once.
    expect(outcome.undo.map((u) => u.index)).toEqual([0, 1]);
    expect(db.stats.depth).toBe(one.stats.depth);
  });
});

describe("a rename keeps the node findable (#25)", () => {
  it("new words in the title or summary re-embed the node; a case/punctuation fix doesn't", async () => {
    const db = seed();
    await applyChangeSet(ctxFor(db), [{ kind: "update", node_id: "fused", title: "Test & market braindump!" }]);
    expect(embedded).toEqual([]);

    await applyChangeSet(ctxFor(db), [
      { kind: "update", node_id: "fused", title: "Beta test BrainDump with 5 friends" },
      { kind: "update", node_id: "bugs", summary: "the ones from round 3" },
      { kind: "update", node_id: "intern", target_date: "2026-11-15" },
    ]);
    expect(embedded.sort()).toEqual(["bugs", "fused"]);
  });

  it("is deferred with the rest of the slow work when the caller can defer", async () => {
    const db = seed();
    const deferred: Array<() => Promise<void>> = [];
    await applyChangeSet(ctxFor(db, { defer: (work: () => Promise<void>) => deferred.push(work) }), [
      { kind: "update", node_id: "fused", title: "Beta test BrainDump" },
    ]);
    expect(embedded).toEqual([]);
    await deferred[0]();
    expect(embedded).toEqual(["fused"]);
  });

  it("Undo of a rename re-embeds the old title", async () => {
    const db = seed();
    const outcome = await applyChangeSet(ctxFor(db), [{ kind: "update", node_id: "fused", title: "Beta test BrainDump" }]);
    embedded.length = 0;
    await undoChangeSteps(ctxFor(db), outcome.undo.map((u) => u.step));
    expect(byTitle(db, "Test & Market BrainDump")).toBeDefined();
    expect(embedded).toEqual(["fused"]);
  });
});
