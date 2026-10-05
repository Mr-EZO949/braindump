import type { EdgeType } from "@/types/graph";

// Four link kinds, each clearly different (owner, 2026-10-05: fewer TYPES of
// links, because the old nine overlapped in meaning):
//   belongs_to   — part of (the parent; structure)
//   required_for — needed for (source must be done before target; blocks it)
//   supports     — helps
//   related_to   — related
// Older rows keep their stored type (no migration); everything that reads an
// edge passes it through `normalizeEdge` so it shows and behaves as its kind.
export const LINK_KINDS = ["belongs_to", "required_for", "supports", "related_to"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

// Lateral (non-parent) kinds a writer may emit as a link.
export const LATERAL_LINK_KINDS = ["required_for", "supports", "related_to"] as const;
export type LateralLinkKind = (typeof LATERAL_LINK_KINDS)[number];

const LEGACY_KIND: Record<string, LinkKind> = {
  belongs_to: "belongs_to",
  contains: "belongs_to", // retired parent → child form (3 rows in prod) → flipped
  required_for: "required_for",
  prerequisite_for: "required_for",
  blocks: "required_for",
  depends_on: "required_for", // written from the dependent's side → flipped
  supports: "supports",
  useful_for: "supports",
  related_to: "related_to",
  inspired_by: "related_to",
};

/** The kind a stored edge type means. Unknown types read as `related_to`. */
export function normalizeEdgeType(edgeType: EdgeType | string | null | undefined): LinkKind {
  return (edgeType && LEGACY_KIND[edgeType]) || "related_to";
}

/** True when the stored type points the other way from its kind (`depends_on`, `contains`). */
export function isReversedEdgeType(edgeType: EdgeType | string | null | undefined): boolean {
  return edgeType === "depends_on" || edgeType === "contains";
}

/** A retired name for a lateral kind (`useful_for`, `prerequisite_for`, …), not `contains`. */
export function isLegacyLinkType(edgeType: string): boolean {
  return (
    edgeType in LEGACY_KIND &&
    edgeType !== "contains" &&
    !(LINK_KINDS as readonly string[]).includes(edgeType)
  );
}

type EdgeLike = { edge_type: string; source_node_id: string; target_node_id: string };

/**
 * An edge as its kind: legacy types renamed, `depends_on` / `contains` flipped
 * so the source is what's needed / the child. Returns the same object when nothing changes.
 */
export function normalizeEdge<T extends EdgeLike>(edge: T): T {
  const kind = normalizeEdgeType(edge.edge_type);
  if (isReversedEdgeType(edge.edge_type)) {
    return {
      ...edge,
      edge_type: kind,
      source_node_id: edge.target_node_id,
      target_node_id: edge.source_node_id,
    };
  }
  return kind === edge.edge_type ? edge : { ...edge, edge_type: kind };
}

export function normalizeEdges<T extends EdgeLike>(edges: readonly T[]): T[] {
  return edges.map(normalizeEdge);
}

/**
 * Stored types that read as `kind` in the same direction — for DB filters
 * (`.in("edge_type", …)` next to a source/target filter). Leaves out the
 * reversed `depends_on` / `contains` (0 and 3 rows in prod on 2026-10-05).
 */
export function storedTypesFor(kind: LinkKind): string[] {
  return Object.keys(LEGACY_KIND).filter(
    (type) => LEGACY_KIND[type] === kind && !isReversedEdgeType(type),
  );
}
