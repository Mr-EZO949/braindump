import type { SupabaseClient } from "@supabase/supabase-js";

import type { Edge, EdgeType, Node } from "@/types/graph";

import { getDirectionalRelationshipLabel } from "./insights";
import { normalizeEdgeType, normalizeEdges, type LinkKind } from "./edge-types";

// Reading-view data assembly.
//
// The "direct vs hidden" split mirrors how the canvas draws edges: the
// structural spine (hierarchy + hard dependencies) is drawn solid and prominent
// — those are DIRECT connections. Everything associative (helps /
// related) is drawn faint and dashed — those are the HIDDEN
// connections, the "find hidden connections in your life" links. Keep this in
// sync with graph-canvas.tsx's `structuralCandidate`.

const DIRECT_EDGE_TYPES = new Set<LinkKind>(["belongs_to", "required_for"]);

export function edgeFamily(edgeType: EdgeType): "direct" | "hidden" {
  return DIRECT_EDGE_TYPES.has(normalizeEdgeType(edgeType)) ? "direct" : "hidden";
}

// Strongest-connection ranking, used only for the Next fallback when a node has
// no explicit reading_order. Mirrors the canvas priority ordering: hard
// dependencies > hierarchy > supports > useful > inspired > related.
const CONNECTION_STRENGTH: Record<LinkKind, number> = {
  required_for: 98,
  belongs_to: 90,
  supports: 70,
  related_to: 30,
};

export interface ReadingConnection {
  id: string;
  title: string;
  node_type: Node["node_type"];
  label: string;
  edge_type: EdgeType;
  family: "direct" | "hidden";
  strength: number;
}

export interface ReadingNeighborPoint {
  id: string;
  title: string;
  family: "direct" | "hidden";
}

export interface ReadingPathNode {
  id: string;
  title: string;
}

export interface ReadingViewData {
  node: Node;
  workspace: { id: string; name: string } | null;
  connections: { direct: ReadingConnection[]; hidden: ReadingConnection[] };
  neighbors: ReadingNeighborPoint[];
  prev: ReadingPathNode | null;
  next: ReadingPathNode | null;
}

type MinimalNode = Pick<Node, "id" | "title" | "node_type">;

// ── Shared assembly ─────────────────────────────────────────────────────────

function buildConnections(
  nodeId: string,
  edges: Edge[],
  neighborById: Map<string, MinimalNode>,
) {
  const connections: ReadingConnection[] = [];
  for (const edge of normalizeEdges(edges)) {
    const otherId =
      edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id;
    const other = neighborById.get(otherId);
    if (!other) continue; // neighbor missing (deleted / not visible) — skip

    const perspective = edge.source_node_id === nodeId ? "source" : "target";
    connections.push({
      id: other.id,
      title: other.title,
      node_type: other.node_type,
      label: getDirectionalRelationshipLabel(edge.edge_type, perspective),
      edge_type: edge.edge_type,
      family: edgeFamily(edge.edge_type),
      strength: CONNECTION_STRENGTH[normalizeEdgeType(edge.edge_type)],
    });
  }

  connections.sort((a, b) => b.strength - a.strength || a.title.localeCompare(b.title));

  return {
    connections,
    direct: connections.filter((c) => c.family === "direct"),
    hidden: connections.filter((c) => c.family === "hidden"),
    neighbors: connections.map((c) => ({ id: c.id, title: c.title, family: c.family })),
  };
}

// Fetch the edges touching `nodeId` and resolve the node on the other end.
// `scope` narrows the queries: {userId} for a private read, {workspaceId} for a
// public read (RLS public policies do the actual gating there).
async function fetchNeighborhood(
  supabase: SupabaseClient,
  nodeId: string,
  scope: { userId?: string; workspaceId: string },
) {
  let edgeQuery = supabase
    .from("edges")
    .select("*")
    .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`);
  if (scope.userId) edgeQuery = edgeQuery.eq("user_id", scope.userId);
  else edgeQuery = edgeQuery.eq("workspace_id", scope.workspaceId);

  const { data: edgeRows } = await edgeQuery;
  const edges = (edgeRows ?? []) as Edge[];

  const neighborIds = Array.from(
    new Set(
      edges.map((edge) =>
        edge.source_node_id === nodeId ? edge.target_node_id : edge.source_node_id,
      ),
    ),
  );

  const neighborById = new Map<string, MinimalNode>();
  if (neighborIds.length > 0) {
    let neighborQuery = supabase
      .from("nodes")
      .select("id, title, node_type")
      .in("id", neighborIds);
    if (scope.userId) neighborQuery = neighborQuery.eq("user_id", scope.userId);
    else neighborQuery = neighborQuery.eq("workspace_id", scope.workspaceId);

    const { data: neighborRows } = await neighborQuery;
    for (const row of (neighborRows ?? []) as MinimalNode[]) {
      neighborById.set(row.id, row);
    }
  }

  return { edges, neighborById };
}

// Prev/Next: follow the explicit reading_order sequence when this node has one;
// otherwise Prev is empty and Next follows the strongest connection. Reading
// order stays independent of edges — we only *fall back* to them.
async function resolvePath(
  supabase: SupabaseClient,
  node: Node,
  connections: ReadingConnection[],
  userId: string | null,
): Promise<{ prev: ReadingPathNode | null; next: ReadingPathNode | null }> {
  if (node.reading_order != null && node.workspace_id) {
    let query = supabase
      .from("nodes")
      .select("id, title, reading_order")
      .eq("workspace_id", node.workspace_id)
      .not("reading_order", "is", null)
      .order("reading_order", { ascending: true });
    if (userId) query = query.eq("user_id", userId);

    const { data: orderedRows } = await query;
    const ordered = (orderedRows ?? []) as Array<ReadingPathNode & { reading_order: number }>;
    const index = ordered.findIndex((row) => row.id === node.id);
    if (index !== -1) {
      const prevRow = index > 0 ? ordered[index - 1] : null;
      const nextRow = index < ordered.length - 1 ? ordered[index + 1] : null;
      return {
        prev: prevRow ? { id: prevRow.id, title: prevRow.title } : null,
        next: nextRow ? { id: nextRow.id, title: nextRow.title } : null,
      };
    }
  }

  const strongest = connections[0];
  return {
    prev: null,
    next: strongest ? { id: strongest.id, title: strongest.title } : null,
  };
}

// ── Private (owner) read ────────────────────────────────────────────────────

export async function getReadingViewData(
  supabase: SupabaseClient,
  userId: string,
  nodeId: string,
): Promise<ReadingViewData | null> {
  const { data: nodeRow, error } = await supabase
    .from("nodes")
    .select("*")
    .eq("user_id", userId)
    .eq("id", nodeId)
    .maybeSingle();

  if (error || !nodeRow) return null;
  const node = nodeRow as Node;

  const workspaceResult = node.workspace_id
    ? await supabase
        .from("workspaces")
        .select("id, name")
        .eq("id", node.workspace_id)
        .maybeSingle()
    : { data: null };
  const workspace = (workspaceResult.data as { id: string; name: string } | null) ?? null;

  const { edges, neighborById } = await fetchNeighborhood(supabase, nodeId, {
    userId,
    workspaceId: node.workspace_id ?? "",
  });
  const built = buildConnections(nodeId, edges, neighborById);
  const { prev, next } = await resolvePath(supabase, node, built.connections, userId);

  return {
    node,
    workspace,
    connections: { direct: built.direct, hidden: built.hidden },
    neighbors: built.neighbors,
    prev,
    next,
  };
}

// ── Public (shared) read ────────────────────────────────────────────────────

export interface PublicReadingViewData extends ReadingViewData {
  slug: string;
}

export async function getPublicReadingViewData(
  supabase: SupabaseClient,
  slug: string,
  nodeId?: string,
): Promise<PublicReadingViewData | null> {
  const { data: workspaceRow } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .maybeSingle();

  if (!workspaceRow) return null;
  const workspace = workspaceRow as { id: string; name: string };

  // A specific node, or the first in reading order as the landing node.
  let nodeQuery = supabase.from("nodes").select("*").eq("workspace_id", workspace.id);
  if (nodeId) {
    nodeQuery = nodeQuery.eq("id", nodeId);
  } else {
    nodeQuery = nodeQuery
      .order("reading_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(1);
  }

  const { data: nodeRow } = await nodeQuery.maybeSingle();
  if (!nodeRow) return null;
  const node = nodeRow as Node;

  const { edges, neighborById } = await fetchNeighborhood(supabase, node.id, {
    workspaceId: workspace.id,
  });
  const built = buildConnections(node.id, edges, neighborById);
  const { prev, next } = await resolvePath(supabase, node, built.connections, null);

  return {
    slug,
    node,
    workspace,
    connections: { direct: built.direct, hidden: built.hidden },
    neighbors: built.neighbors,
    prev,
    next,
  };
}
