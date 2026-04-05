import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateEmbeddingMock, persistAIRunMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(),
  persistAIRunMock: vi.fn(),
}));

vi.mock("./index", () => ({
  aiProvider: () => ({
    generateEmbedding: generateEmbeddingMock,
  }),
}));

vi.mock("./telemetry", () => ({
  persistAIRun: persistAIRunMock,
}));

import { matchNodes } from "./embeddings";

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
