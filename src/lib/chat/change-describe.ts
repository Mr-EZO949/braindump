// A change-set op in the user's words — shared by the cards that list ops
// (pending-action-card, turn-card) and by the note that tells the chat model
// what a brain dump changed (turn-note.ts).

import { normalizeEdgeType, type LinkKind } from "@/lib/graph/edge-types";

// An op as it arrives in a tool input: untyped JSON.
export type ChangeOpView = {
  kind?: unknown;
  local_ref?: unknown;
  title?: unknown;
  node_type?: unknown;
  node_id?: unknown;
  parent_node_id?: unknown;
  parent_local_ref?: unknown;
  new_parent_node_id?: unknown;
  new_parent_local_ref?: unknown;
  source_node_id?: unknown;
  target_node_id?: unknown;
  edge_type?: unknown;
  into_node_id?: unknown;
  target_date?: unknown;
  summary?: unknown;
  // Written when the card is prepared (tools/change.ts): the node's title
  // before a rename, how many nodes a delete takes with it.
  before_title?: unknown;
  subtree_count?: unknown;
};

export type NameOf = (ref: unknown) => string;

// The tools whose card is a change set, row by row (change, build_graph, and
// write_steps — the step-writer's suggested steps). Client and server share it.
export const CHANGE_SET_TOOLS: ReadonlySet<string> = new Set(["change", "build_graph", "write_steps"]);

export function isChangeList(value: unknown): value is ChangeOpView[] {
  return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null);
}

export const CHANGE_KIND_GLYPH: Record<string, string> = {
  create_node: "+",
  move: "↳",
  update: "✎",
  create_edge: "⇄",
  complete: "✓",
  archive: "⌫",
  remove_edge: "⊘",
  delete_node: "✕",
  merge: "⇉",
};

export const HIERARCHY_EDGE_TYPES = new Set(["belongs_to", "contains"]);

// The four link kinds in the user's words (lib/graph/edge-types.ts).
const LINK_WORDS: Record<LinkKind, string> = {
  belongs_to: "belongs to",
  required_for: "needed for",
  supports: "helps",
  related_to: "related to",
};

export function edgeLabel(edgeType: unknown): string {
  if (typeof edgeType !== "string") return "linked to";
  if (edgeType === "contains") return "contains";
  if (edgeType === "depends_on") return "needs";
  return LINK_WORDS[normalizeEdgeType(edgeType)];
}

export function typeLabel(nodeType: unknown): string {
  return typeof nodeType === "string" ? nodeType.replace(/_/g, " ") : "";
}

// belongs_to / contains are a MOVE: who goes under whom.
export function hierarchyEnds(op: {
  edge_type?: unknown;
  source_node_id?: unknown;
  target_node_id?: unknown;
}): { child: unknown; parent: unknown } {
  return op.edge_type === "contains"
    ? { child: op.target_node_id, parent: op.source_node_id }
    : { child: op.source_node_id, parent: op.target_node_id };
}

// A node as the user knows it: its title, or — for a node the same set
// creates — the title the set gives it.
export function namerFor(ops: ChangeOpView[], nodeTitles?: ReadonlyMap<string, string>): NameOf {
  const localTitles = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === "create_node" && typeof op.local_ref === "string" && typeof op.title === "string") {
      localTitles.set(op.local_ref, op.title);
    }
  }
  return (ref) =>
    typeof ref === "string" && ref.length > 0
      ? (localTitles.get(ref) ?? nodeTitles?.get(ref) ?? "a node")
      : "a node";
}

export function describeChange(op: ChangeOpView, nameOf: NameOf): string {
  const kind = typeof op.kind === "string" ? op.kind : "";
  switch (kind) {
    case "create_node": {
      const title = typeof op.title === "string" ? op.title : "(untitled)";
      const type = typeLabel(op.node_type);
      const parent = op.parent_node_id ?? op.parent_local_ref;
      return `${title}${type ? ` · ${type}` : ""}${parent ? ` — under ${nameOf(parent)}` : ""}`;
    }
    case "move":
      return `Move ${nameOf(op.node_id)} under ${nameOf(op.new_parent_node_id ?? op.new_parent_local_ref)}`;
    case "update": {
      const parts = [
        typeof op.title === "string" ? `rename to "${op.title}"` : null,
        typeof op.node_type === "string" ? `make it a ${typeLabel(op.node_type)}` : null,
        typeof op.target_date === "string" ? (op.target_date ? `due ${op.target_date}` : "no deadline") : null,
        typeof op.summary === "string" ? "new summary" : null,
      ].filter(Boolean);
      // After a rename the node's title IS the new one — name it by the old.
      const name = typeof op.before_title === "string" && op.before_title ? op.before_title : nameOf(op.node_id);
      return `${name}: ${parts.length > 0 ? parts.join(", ") : "edit"}`;
    }
    case "create_edge": {
      if (typeof op.edge_type === "string" && HIERARCHY_EDGE_TYPES.has(op.edge_type)) {
        const { child, parent } = hierarchyEnds(op);
        return `Move ${nameOf(child)} under ${nameOf(parent)}`;
      }
      return `${nameOf(op.source_node_id)} ${edgeLabel(op.edge_type)} ${nameOf(op.target_node_id)}`;
    }
    case "complete":
      return `Complete ${nameOf(op.node_id)}`;
    case "archive":
      return `Archive ${nameOf(op.node_id)}`;
    case "remove_edge":
      return typeof op.edge_type === "string" && op.edge_type
        ? `Remove "${nameOf(op.source_node_id)} ${edgeLabel(op.edge_type)} ${nameOf(op.target_node_id)}"`
        : `Unlink ${nameOf(op.source_node_id)} and ${nameOf(op.target_node_id)}`;
    case "delete_node": {
      const under = typeof op.subtree_count === "number" && op.subtree_count > 0 ? op.subtree_count : 0;
      const name = typeof op.before_title === "string" && op.before_title ? op.before_title : nameOf(op.node_id);
      return `Delete ${name} for good${under > 0 ? ` with the ${under} under it` : ""} — no undo`;
    }
    case "merge":
      return `Merge ${nameOf(op.node_id)} into ${nameOf(op.into_node_id)}`;
    default:
      return kind || "(unknown)";
  }
}
