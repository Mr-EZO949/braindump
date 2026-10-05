// A node made by hand gets what an AI-made node gets (#25): the embedding,
// the accept event, the judgment and a rescore — once, and only for this
// user's node. The model calls are mocked: this is about what gets written.

import { beforeEach, describe, expect, it, vi } from "vitest";

const embedded: string[] = [];
const embeddedText: string[] = [];
vi.mock("@/lib/ai/embeddings", () => ({
  generateAndStoreEmbeddings: vi.fn(async (params: { nodes: Array<{ nodeId: string; title: string }> }) => {
    embedded.push(...params.nodes.map((node) => node.nodeId));
    embeddedText.push(...params.nodes.map((node) => node.title));
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
    return {
      nodeUpdates: [
        { id: "n1", current_importance_score: 72, importance_index: 72, importance: "high", importance_reason: "r", importance_top_signals: [] },
      ],
    };
  }),
}));

import { createFakeSupabase } from "@/lib/test/fake-supabase";

import { intakeHandMadeNode, reembedNodes } from "./node-intake";

const node = (id: string, title: string, node_type: string, user_id = "u1") => ({
  id,
  user_id,
  workspace_id: "w1",
  title,
  summary: null,
  node_type,
  status: "active",
});

function seed() {
  return createFakeSupabase({
    workspaces: [{ id: "w1", user_id: "u1", profile_payload: null }],
    nodes: [node("n1", "Book the dentist checkup", "task"), node("n2", "Noah is my TA", "note"), node("x", "Not mine", "task", "u2")],
    feedback_events: [],
  });
}

const scopeFor = (db: ReturnType<typeof seed>) => ({ supabase: db.client, userId: "u1", workspaceId: "w1" });

beforeEach(() => {
  embedded.length = 0;
  embeddedText.length = 0;
  judged.length = 0;
  rescores = 0;
});

describe("intakeHandMadeNode", () => {
  it("embeds, logs the accept, judges and rescores — and returns the scores", async () => {
    const db = seed();
    const outcome = await intakeHandMadeNode(scopeFor(db), "n1", "2026-10-05");
    expect(outcome).toMatchObject({ status: "done", scores: [expect.objectContaining({ id: "n1", importance_index: 72 })] });
    expect(embedded).toEqual(["n1"]);
    expect(db.tables.feedback_events).toEqual([
      expect.objectContaining({
        event_type: "accept_node",
        entity_type: "node",
        entity_id: "n1",
        metadata: expect.objectContaining({ source: "manual", node_type: "task" }),
      }),
    ]);
    expect(judged).toEqual([["n1"]]);
    expect(rescores).toBe(1);
  });

  it("runs once per node: a second call pays for nothing", async () => {
    const db = seed();
    await intakeHandMadeNode(scopeFor(db), "n1");
    const again = await intakeHandMadeNode(scopeFor(db), "n1");
    expect(again).toEqual({ status: "already" });
    expect(judged).toHaveLength(1);
    expect(embedded).toHaveLength(1);
    expect(db.tables.feedback_events).toHaveLength(1);
  });

  it("a note is embedded and rescored but not judged, as in AI intake", async () => {
    const db = seed();
    await intakeHandMadeNode(scopeFor(db), "n2");
    expect(embedded).toEqual(["n2"]);
    expect(judged).toEqual([]);
    expect(rescores).toBe(1);
  });

  it("another user's node is not found and nothing is written", async () => {
    const db = seed();
    expect(await intakeHandMadeNode(scopeFor(db), "x")).toEqual({ status: "not_found" });
    expect(embedded).toEqual([]);
    expect(db.tables.feedback_events).toEqual([]);
  });
});

describe("reembedNodes", () => {
  it("embeds the node's current words, only this user's", async () => {
    const db = seed();
    db.tables.nodes[0].title = "Book the dentist and the eye doctor";
    expect(await reembedNodes(scopeFor(db), ["n1", "x"])).toBe(1);
    expect(embeddedText).toEqual(["Book the dentist and the eye doctor"]);
  });
});
