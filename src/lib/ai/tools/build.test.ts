// build_graph: the chat model asks, the graph builder plans, the dump policy
// applies what is safe at once and puts the reorganizing on one card, the
// change-set writer applies what the user accepts. The builder's model call is
// mocked (runBuilder) — this checks the plumbing around it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderSuccess } from "@/lib/ai/extraction";

const builderCalls: Array<{ rawText: string; expandChildren?: boolean; source?: string }> = [];
let builderResult: BuilderSuccess | { ok: false; error: string; userMessage: string };
vi.mock("@/lib/ai/extraction", async (importOriginal) => ({
  // The real ledger writer (saveProposalRows) against the fake database.
  ...(await importOriginal<typeof import("@/lib/ai/extraction")>()),
  runBuilder: vi.fn(async (params: { rawText: string; expandChildren?: boolean; source?: string }) => {
    builderCalls.push({ rawText: params.rawText, expandChildren: params.expandChildren, source: params.source });
    return builderResult;
  }),
}));
vi.mock("@/lib/ai/embeddings", () => ({ generateAndStoreEmbeddings: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/judgment", () => ({ scoreNodesJudgment: vi.fn(async () => []) }));
vi.mock("@/lib/ai/scoring", () => ({ computeWorkspaceScores: vi.fn(async () => ({ nodeUpdates: [] })) }));
vi.mock("@/lib/ai/clustering", () => ({ runClusteringPass: vi.fn(async () => []) }));

import { createFakeSupabase, type FakeSupabase } from "@/lib/test/fake-supabase";

import { dispatchTool, isPausingTool, runTurnTools } from "./index";
import { BUILD_GRAPH_TOOL, builderText, type BuildPlanInput } from "./build";

type Row = Record<string, unknown>;

const USER = "u1";
const WS = "w1";
const MONEY = "aaaaaaaa-0000-4000-8000-000000000001";
const FUSED = "aaaaaaaa-0000-4000-8000-000000000002";
const ROOT = "aaaaaaaa-0000-4000-8000-000000000009";

function seed(): FakeSupabase {
  const node = (id: string, title: string, node_type: string): Row => ({
    id,
    user_id: USER,
    workspace_id: WS,
    title,
    summary: null,
    node_type,
    status: "active",
    current_importance_score: 50,
    stakes: null,
    target_date: null,
    waiting_for: null,
    resume_on: null,
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
    workspaces: [{ id: WS, user_id: USER, name: "ezo", bootstrap_root_node_id: ROOT }],
    nodes: [
      node(ROOT, "ezo", "area"),
      node(MONEY, "Money Projects", "area"),
      node(FUSED, "Test & Market BrainDump", "big_task"),
    ],
    edges: [parent("e-money", MONEY, ROOT), parent("e-fused", FUSED, MONEY)],
    feedback_events: [],
    raw_entries: [],
    proposed_nodes: [],
  });
}

const ctxFor = (db: FakeSupabase, userMessage: string) => ({
  supabase: db.client,
  userId: USER,
  workspaceId: WS,
  selectedNodeId: null,
  today: "2026-09-30",
  userMessage,
});

// What the builder returns for "BrainDump should be its own project with
// testing and marketing as tasks in it".
function restructurePlan(extra: Partial<BuilderSuccess> = {}): BuilderSuccess {
  const base = {
    workspace_id: WS,
    user_id: USER,
    existing_parent_node_id: null,
    primary_parent_local_ref: null,
    depends_on_local_refs: [],
    soft_links: [],
    accepted_node_id: null,
    proposed_summary: null,
    proposed_body: null,
    proposed_target_date: null,
    extraction_confidence: 0.9,
    source_span: null,
    proposal_status: "pending_review" as const,
  };
  return {
    ok: true,
    aiRunId: "run-1",
    nodes: [
      { ...base, local_ref: "n1", proposed_title: "BrainDump", proposed_node_type: "project", existing_parent_node_id: MONEY },
      { ...base, local_ref: "n2", proposed_title: "Market BrainDump", proposed_node_type: "big_task", primary_parent_local_ref: "n1" },
    ],
    changes: [
      { kind: "update", node_id: FUSED, title: "Test BrainDump" },
      { kind: "move", node_id: FUSED, new_parent: "n1" },
    ],
    clarifyingQuestions: [],
    completeExistingNodeIds: [],
    autoCompleteLocalRefs: [],
    possibleDuplicates: [],
    ...extra,
  };
}

const MESSAGE = "braindump should be its own project with testing and marketing as tasks in it";

beforeEach(() => {
  builderCalls.length = 0;
  builderResult = restructurePlan();
});

describe("runTurnTools — build_graph", () => {
  it("plans with the user's own words and pauses on the builder's change set", async () => {
    const db = seed();
    const turn = await runTurnTools(
      [{ id: "t1", name: BUILD_GRAPH_TOOL, input: { note: "'it' is Test & Market BrainDump" } }],
      ctxFor(db, MESSAGE),
    );

    expect(isPausingTool(BUILD_GRAPH_TOOL)).toBe(true);
    expect(builderCalls).toEqual([
      {
        rawText: builderText(MESSAGE, "'it' is Test & Market BrainDump"),
        expandChildren: true,
        source: "assistant-build",
      },
    ]);
    expect(builderCalls[0].rawText.startsWith(MESSAGE)).toBe(true);
    // A reorganization waits as one unit: the new parent, its new child, the
    // rename and the move — nothing of it is in the graph yet.
    expect(turn.pending?.name).toBe(BUILD_GRAPH_TOOL);
    expect((turn.pending?.input as BuildPlanInput).changes.map((c) => c.kind)).toEqual([
      "create_node",
      "create_node",
      "update",
      "move",
    ]);
    expect(db.tables.nodes).toHaveLength(3);
    // The card is the turn card: nothing applied, the rows wait inside it.
    expect(turn.turns).toEqual([expect.objectContaining({ added: [], done: [], links: [] })]);
    // The ledger has the two proposals, waiting.
    expect(db.tables.raw_entries).toEqual([expect.objectContaining({ source_type: "assistant_save", raw_text: MESSAGE })]);
    expect(db.tables.proposed_nodes.map((r) => r.proposal_status)).toEqual(["pending_review", "pending_review"]);
  });

  it("a plain capture applies at once — the card shows it with Undo, nothing waits", async () => {
    const db = seed();
    builderResult = restructurePlan({
      nodes: [
        { ...restructurePlan().nodes[0], local_ref: "n1", proposed_title: "Call the bank", proposed_node_type: "task", existing_parent_node_id: MONEY },
      ],
      changes: [],
    });
    const turn = await runTurnTools([{ id: "t1", name: BUILD_GRAPH_TOOL, input: {} }], ctxFor(db, "need to call the bank"));

    expect(turn.pending).toBeNull();
    expect(turn.turns[0].added).toEqual([expect.objectContaining({ title: "Call the bank", parent_title: "Money Projects" })]);
    expect(turn.turns[0].undo?.added).toHaveLength(1);
    expect(db.tables.nodes.some((n) => n.title === "Call the bank")).toBe(true);
    expect(JSON.parse(turn.results[0].content)).toMatchObject({ accepted: true, applied: 1, added: ["Call the bank (task) under Money Projects"] });
  });

  it("applies exactly the accepted plan", async () => {
    const db = seed();
    const turn = await runTurnTools([{ id: "t1", name: BUILD_GRAPH_TOOL, input: {} }], ctxFor(db, MESSAGE));
    const out = await dispatchTool({
      name: BUILD_GRAPH_TOOL,
      input: turn.pending!.input,
      tool_use_id: "t1",
      ctx: ctxFor(db, MESSAGE),
    });
    const result = JSON.parse(out.content) as Row;

    expect(result).toMatchObject({ accepted: true, applied: 4, total: 4, message: "Applied 4 changes ✓" });
    const byTitle = (title: string) => db.tables.nodes.find((n) => n.title === title);
    const parentOf = (title: string) => {
      const edge = db.tables.edges.find(
        (e) => e.source_node_id === byTitle(title)?.id && e.edge_type === "belongs_to" && e.status === "active",
      );
      return db.tables.nodes.find((n) => n.id === edge?.target_node_id)?.title;
    };
    expect(parentOf("BrainDump")).toBe("Money Projects");
    expect(parentOf("Test BrainDump")).toBe("BrainDump");
    expect(parentOf("Market BrainDump")).toBe("BrainDump");
    expect(byTitle("Test & Market BrainDump")).toBeUndefined();
    // The builder was not asked again.
    expect(builderCalls).toHaveLength(1);
  });

  it("puts the builder's questions and duplicate warnings where the user sees them", async () => {
    const db = seed();
    builderResult = restructurePlan({
      clarifyingQuestions: ["You said 'the fixes' — which node is that?"],
      possibleDuplicates: [{ localRef: "n2", existingNodeId: FUSED, existingTitle: "Test & Market BrainDump" }],
    });
    const turn = await runTurnTools([{ id: "t1", name: BUILD_GRAPH_TOOL, input: {} }], ctxFor(db, MESSAGE));
    const plan = turn.pending!.input as BuildPlanInput;
    expect(plan.notes).toEqual(['"Market BrainDump" looks like your existing "Test & Market BrainDump".']);
    // Questions sit on the card, each with its own answer box.
    expect(turn.turns[0].questions).toEqual(["You said 'the fixes' — which node is that?"]);
  });

  it("with nothing to confirm it answers the model instead of showing an empty card", async () => {
    const db = seed();
    builderResult = restructurePlan({ nodes: [], changes: [], clarifyingQuestions: ["Which project do you mean?"] });
    const turn = await runTurnTools(
      [
        { id: "t1", name: BUILD_GRAPH_TOOL, input: {} },
        { id: "t2", name: "get_workspace_summary", input: {} },
      ],
      ctxFor(db, "sort out my projects"),
    );

    expect(turn.pending).toBeNull();
    expect(turn.results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
    expect(JSON.parse(turn.results[0].content)).toMatchObject({
      built: 0,
      questions: ["Which project do you mean?"],
    });
  });

  it("reports a failed builder call as a tool error the model can explain", async () => {
    const db = seed();
    builderResult = { ok: false, error: "overloaded", userMessage: "The AI is busy — try again in a moment." };
    const turn = await runTurnTools([{ id: "t1", name: BUILD_GRAPH_TOOL, input: {} }], ctxFor(db, MESSAGE));
    expect(turn.pending).toBeNull();
    expect(JSON.parse(turn.results[0].content)).toEqual({
      accepted: false,
      error: "The AI is busy — try again in a moment.",
    });
  });

  it("refuses to apply when no plan was made", async () => {
    const db = seed();
    const out = await dispatchTool({ name: BUILD_GRAPH_TOOL, input: { note: "x" }, tool_use_id: "t1", ctx: ctxFor(db, MESSAGE) });
    expect(JSON.parse(out.content)).toMatchObject({ accepted: false });
    expect(db.tables.nodes).toHaveLength(3);
  });
});

describe("builderText — how much of the chat model's note the builder gets", () => {
  const note = "Make 'BrainDump' its own project with 'Test BrainDump' and 'Market BrainDump' in it.";

  it("a bare yes: the note is the request", () => {
    expect(builderText("yes", note)).toBe(note);
    expect(builderText("yeah do it", note)).toBe(note);
  });

  it("a short message: the user's words first, the note only to resolve references", () => {
    const text = builderText("make it its own project", "'it' is Test & Market BrainDump");
    expect(text.startsWith("make it its own project")).toBe(true);
    expect(text).toContain("'it' is Test & Market BrainDump");
    expect(text).toContain("use it only to resolve");
  });

  it("a long message stands alone — a paraphrase can only make it worse", () => {
    const message =
      "ok so this week: need to renew my passport, book the dentist and start the stats problem set. also i finished the italian placement test";
    expect(builderText(message, "User finished Italian Crash Course")).toBe(message);
  });

  it("no note, or no message", () => {
    expect(builderText("split the thesis into research and writing", "")).toBe(
      "split the thesis into research and writing",
    );
    expect(builderText(undefined, note)).toBe(note);
  });
});

describe("runTurnTools — other calls in the same turn", () => {
  it("pauses on the first card and leaves read-only calls for the resume", async () => {
    const db = seed();
    const suggestion = { source: "suggestion", changes: [{ kind: "create_node", title: "Email the prof", node_type: "task" }] };
    const turn = await runTurnTools(
      [
        { id: "t1", name: "get_workspace_summary", input: {} },
        { id: "t2", name: "change", input: suggestion },
        { id: "t3", name: "change", input: { source: "user", changes: [{ kind: "complete", node_id: FUSED }] } },
      ],
      ctxFor(db, "what would you add?"),
    );
    expect(turn.pending).toMatchObject({ id: "t2", name: "change", input: expect.objectContaining({ suggested: true }) });
    expect(turn.deferred.map((d) => d.id)).toEqual(["t1", "t3"]);
    expect(turn.applied).toEqual([]);
    expect(db.tables.nodes).toHaveLength(3);
  });

  it("a priority change the assistant only suggests waits for OK (owner, 2026-10-02)", async () => {
    const db = seed();
    const turn = await runTurnTools(
      [
        {
          id: "t1",
          name: "update_priorities",
          input: { source: "suggestion", changes: [{ node_id: MONEY, title: "Money Projects", action: "deprioritize" }] },
        },
      ],
      ctxFor(db, "money or exams?"),
    );
    expect(turn.pending).toMatchObject({ id: "t1", name: "update_priorities" });
    expect(turn.applied).toEqual([]);
    expect(db.tables.nodes.find((n) => n.id === MONEY)?.stakes).toBeNull();
  });

  it("runs a direct tool now even though a card is pending", async () => {
    const db = seed();
    const turn = await runTurnTools(
      [
        {
          id: "t1",
          name: "update_priorities",
          input: { changes: [{ node_id: MONEY, title: "Money Projects", action: "stakes", stakes: "high" }] },
        },
        { id: "t2", name: BUILD_GRAPH_TOOL, input: {} },
      ],
      ctxFor(db, `${MESSAGE} — and money projects matter a lot right now`),
    );

    expect(turn.pending?.id).toBe("t2");
    // Applied (the browser gets the card with Undo) and recorded for the
    // resume, which replays the result instead of rejecting a second action.
    expect(db.tables.nodes.find((n) => n.id === MONEY)?.stakes).toBe(1);
    expect(turn.applied).toHaveLength(1);
    expect(turn.deferred).toHaveLength(1);
    expect(turn.deferred[0]).toMatchObject({ id: "t1", name: "update_priorities" });
    expect(turn.deferred[0].result?.is_error).toBe(false);
  });

  it("runs everything eagerly when nothing needs the user", async () => {
    const db = seed();
    const turn = await runTurnTools(
      [{ id: "t1", name: "get_workspace_summary", input: {} }],
      ctxFor(db, "what's in my graph"),
    );
    expect(turn.pending).toBeNull();
    expect(turn.results).toHaveLength(1);
  });
});
