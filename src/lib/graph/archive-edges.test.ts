import { describe, expect, it } from "vitest";
import { formerParentEdge, pickEdgesToRestore, type ArchiveEdge } from "./archive-edges";

const edge = (
  id: string,
  source: string,
  target: string,
  status: string,
  createdAt: string,
  edgeType = "belongs_to",
): ArchiveEdge => ({
  id,
  source_node_id: source,
  target_node_id: target,
  edge_type: edgeType,
  status,
  created_at: createdAt,
});

const statuses = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("formerParentEdge", () => {
  it("picks the newest parent of a node that was moved before it was archived", () => {
    const edges = [
      edge("old", "a", "p1", "orphaned", "2026-09-01T00:00:00Z"),
      edge("new", "a", "p2", "orphaned", "2026-09-20T00:00:00Z"),
    ];
    expect(formerParentEdge("a", edges)?.target_node_id).toBe("p2");
  });

  it("prefers a live parent and ignores rejected ones", () => {
    const edges = [
      edge("live", "a", "p1", "active", "2026-09-01T00:00:00Z"),
      edge("rejected", "a", "p3", "user_rejected", "2026-09-30T00:00:00Z"),
    ];
    expect(formerParentEdge("a", edges)?.id).toBe("live");
    expect(formerParentEdge("a", [edges[1]])).toBeNull();
  });
});

describe("pickEdgesToRestore", () => {
  it("revives one parent for a moved-then-archived node (the single-parent index)", () => {
    const ids = pickEdgesToRestore({
      nodeId: "a",
      edges: [
        edge("old", "a", "p1", "orphaned", "2026-09-01T00:00:00Z"),
        edge("new", "a", "p2", "orphaned", "2026-09-20T00:00:00Z"),
        edge("link", "a", "x", "orphaned", "2026-09-05T00:00:00Z", "related_to"),
      ],
      statusByNodeId: statuses({ p1: "active", p2: "active", x: "active" }),
      parentedNodeIds: new Set(),
    });
    expect(ids.sort()).toEqual(["link", "new"]);
  });

  it("leaves edges to nodes that are still archived, and rejected edges", () => {
    const ids = pickEdgesToRestore({
      nodeId: "a",
      edges: [
        edge("to-archived", "a", "p", "orphaned", "2026-09-01T00:00:00Z"),
        edge("rejected", "a", "x", "user_rejected", "2026-09-02T00:00:00Z", "supports"),
      ],
      statusByNodeId: statuses({ p: "archived", x: "active" }),
      parentedNodeIds: new Set(),
    });
    expect(ids).toEqual([]);
  });

  it("re-attaches children unless they have been given another parent since", () => {
    const ids = pickEdgesToRestore({
      nodeId: "a",
      edges: [
        edge("c1", "child-1", "a", "orphaned", "2026-09-01T00:00:00Z"),
        edge("c2", "child-2", "a", "orphaned", "2026-09-01T00:00:00Z"),
      ],
      statusByNodeId: statuses({ "child-1": "active", "child-2": "completed" }),
      parentedNodeIds: new Set(["child-1"]),
    });
    expect(ids).toEqual(["c2"]);
  });

  it("keeps a parent the node already has", () => {
    const ids = pickEdgesToRestore({
      nodeId: "a",
      edges: [
        edge("live", "a", "p1", "active", "2026-09-25T00:00:00Z"),
        edge("old", "a", "p2", "orphaned", "2026-09-01T00:00:00Z"),
      ],
      statusByNodeId: statuses({ p1: "active", p2: "active" }),
      parentedNodeIds: new Set(),
    });
    expect(ids).toEqual([]);
  });
});
