import { describe, expect, it } from "vitest";
import { groupArchivedNodes } from "./archive-groups";
import type { Edge, GraphData, Node } from "@/types/graph";

const node = (id: string, title: string, status: Node["status"] = "active"): Node => ({
  id,
  user_id: "u",
  title,
  summary: null,
  body: null,
  raw_text: null,
  node_type: "task",
  importance: "medium",
  color: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status,
});

const parentEdge = (child: string, parent: string): Edge => ({
  id: `${child}-${parent}`,
  user_id: "u",
  source_node_id: child,
  target_node_id: parent,
  edge_type: "belongs_to",
  status: "orphaned",
  created_at: "2026-01-01T00:00:00Z",
});

describe("groupArchivedNodes", () => {
  it("groups archived nodes under their former parent even though the edge is orphaned", () => {
    const graph: GraphData = {
      nodes: [
        node("project", "Project"),
        node("a", "First", "archived"),
        node("b", "Second", "archived"),
      ],
      edges: [parentEdge("a", "project"), parentEdge("b", "project")],
    };

    expect(
      groupArchivedNodes(graph).map((group) => ({
        parent: group.parent?.title ?? null,
        nodes: group.nodes.map((item) => item.title),
      })),
    ).toEqual([{ parent: "Project", nodes: ["First", "Second"] }]);
  });

  it("files a node that was moved before archiving under its latest parent", () => {
    const graph: GraphData = {
      nodes: [node("p1", "Old home"), node("p2", "New home"), node("a", "Moved", "archived")],
      edges: [
        { ...parentEdge("a", "p2"), id: "new", created_at: "2026-09-20T00:00:00Z" },
        { ...parentEdge("a", "p1"), id: "old", created_at: "2026-09-01T00:00:00Z" },
      ],
    };
    expect(groupArchivedNodes(graph)[0].parent?.title).toBe("New home");
    expect(groupArchivedNodes({ ...graph, edges: [...graph.edges].reverse() })[0].parent?.title).toBe(
      "New home",
    );
  });

  it("keeps standalone archives in an unfiled group", () => {
    const graph: GraphData = { nodes: [node("solo", "Standalone", "archived")], edges: [] };
    expect(groupArchivedNodes(graph)).toMatchObject([{ parent: null, nodes: [{ id: "solo" }] }]);
  });
});
