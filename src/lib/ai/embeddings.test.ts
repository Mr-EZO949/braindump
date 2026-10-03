import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateEmbeddingMock, generateEmbeddingsMock, persistAIRunMock } = vi.hoisted(() => {
  // Read when the config module loads.
  process.env.AI_EMBEDDING_ENABLED = "true";
  return {
    generateEmbeddingMock: vi.fn(),
    generateEmbeddingsMock: vi.fn(),
    persistAIRunMock: vi.fn(),
  };
});

vi.mock("./index", () => ({
  aiProvider: () => ({
    generateEmbedding: generateEmbeddingMock,
    generateEmbeddings: generateEmbeddingsMock,
  }),
}));

vi.mock("./telemetry", () => ({
  persistAIRun: persistAIRunMock,
}));

import { createFakeSupabase } from "@/lib/test/fake-supabase";

import { generateAndStoreEmbeddings, matchNodes } from "./embeddings";

const baseEmbeddingRun = {
  run_type: "embed" as const,
  provider: "gemini",
  model_name: "gemini-embedding-004",
  prompt_version: "embed-v1",
  input_hash: "input-hash",
  output_hash: "output-hash",
  input_tokens: 12,
  output_tokens: 0,
  latency_ms: 45,
  estimated_cost: null,
  status: "success" as const,
  error_text: null,
};

describe("matchNodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateEmbeddingMock.mockResolvedValue({
      output: {
        embedding: [0.12, 0.34, 0.56],
        token_count: 12,
      },
      run: baseEmbeddingRun,
    });
    persistAIRunMock.mockResolvedValue("run-1");
  });

  it("returns semantic matches from the match_nodes RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          node_id: "node-1",
          title: "High-performing student",
          node_type: "goal",
          summary: "Build strong academic habits",
          similarity: 0.94,
        },
      ],
      error: null,
    });

    const results = await matchNodes({
      queryText: "student success system",
      workspaceId: "ws-1",
      userId: "user-1",
      supabase: { rpc } as never,
      limit: 5,
    });

    expect(results).toEqual([
      {
        node_id: "node-1",
        title: "High-performing student",
        node_type: "goal",
        summary: "Build strong academic habits",
        similarity: 0.94,
      },
    ]);
  });

  it("passes workspace and user scoping to the retrieval RPC and excludes completed nodes by default", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await matchNodes({
      queryText: "semester planning",
      workspaceId: "ws-2",
      userId: "user-2",
      supabase: { rpc } as never,
      excludeNodeId: "node-9",
      limit: 7,
    });

    expect(rpc).toHaveBeenCalledWith("match_nodes", {
      query_embedding: JSON.stringify([0.12, 0.34, 0.56]),
      match_user_id: "user-2",
      match_workspace_id: "ws-2",
      match_count: 7,
      exclude_node_id: "node-9",
      include_completed: false,
    });
  });

  it("allows completed nodes only when explicitly requested", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await matchNodes({
      queryText: "old completed work",
      workspaceId: "ws-3",
      userId: "user-3",
      supabase: { rpc } as never,
      includeCompleted: true,
      limit: 3,
    });

    expect(rpc).toHaveBeenCalledWith("match_nodes", {
      query_embedding: JSON.stringify([0.12, 0.34, 0.56]),
      match_user_id: "user-3",
      match_workspace_id: "ws-3",
      match_count: 3,
      exclude_node_id: null,
      include_completed: true,
    });
  });
});

describe("generateAndStoreEmbeddings — a dump's new nodes", () => {
  const nodes = [
    { nodeId: "a", title: "Pick a dataset", summary: null },
    { nodeId: "b", title: "Write the proposal", summary: "For the ML project" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    persistAIRunMock.mockResolvedValue("run-1");
    generateEmbeddingMock.mockResolvedValue({ output: { embedding: [0.9, 0.9], token_count: null }, run: baseEmbeddingRun });
  });

  it("stores the vectors the dedup already made and embeds the rest in one call, one upsert", async () => {
    generateEmbeddingsMock.mockResolvedValue({
      output: { embeddings: [[0.5, 0.5]] },
      run: { ...baseEmbeddingRun, prompt_version: "embed-batch-v1" },
    });
    const db = createFakeSupabase({ node_embeddings: [] });
    await generateAndStoreEmbeddings({
      nodes,
      known: new Map([["Pick a dataset", [0.1, 0.2]]]),
      workspaceId: "w",
      userId: "u",
      supabase: db.client,
    });

    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(generateEmbeddingsMock).toHaveBeenCalledWith({ texts: ["Write the proposal\nFor the ML project"] });
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(db.tables.node_embeddings.map((r) => [r.node_id, JSON.parse(String(r.embedding))])).toEqual([
      ["a", [0.1, 0.2]],
      ["b", [0.5, 0.5]],
    ]);
    expect(db.stats.calls.filter((c) => c.startsWith("node_embeddings"))).toEqual(["node_embeddings.upsert"]);
  });

  it("when the batch call fails, each node is embedded on its own", async () => {
    generateEmbeddingsMock.mockRejectedValue(new Error("GEMINI_API_KEY is not set"));
    const db = createFakeSupabase({ node_embeddings: [] });
    await generateAndStoreEmbeddings({ nodes, workspaceId: "w", userId: "u", supabase: db.client });

    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);
    expect(db.tables.node_embeddings.map((r) => r.node_id).sort()).toEqual(["a", "b"]);
  });
});
