import type { GraphData } from "@/types/graph";

// Pure, dependency-free graph/chat heuristics. Extracted from app-shell so
// they can be unit-tested without dragging in React/CSS/Next.

// Conservative heuristic: does a chat message look like a brain dump rather
// than a question/command? Deliberately strict so it never nags on normal
// chat — only fires on longer, multi-item, non-question text. When it fires
// the user is shown a "Brain dump / Just chatting" chooser; it never routes
// silently.
export function looksLikeBrainDump(text: string): boolean {
  const t = text.trim();
  if (t.length < 60) return false; // dumps are substantial
  if (t.endsWith("?")) return false; // questions → chat
  if (
    /^(what|why|how|who|when|where|which|can you|could you|would you|should i|do you|does|did|is |are |explain|summari[sz]e|tell me|give me|show me|help me|find |search)/i.test(
      t,
    )
  ) {
    return false; // conversational opener → chat
  }
  const commas = (t.match(/,/g) ?? []).length;
  const newlines = (t.match(/\n/g) ?? []).length;
  const segments = t
    .split(/[.!\n]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
  // Multi-item signal: list-like or several clauses.
  return newlines >= 1 || commas >= 2 || segments >= 3;
}

// Active projects with no children — candidates for a "want a roadmap?"
// nudge. A child belongs_to a parent (edge: source=child, target=parent),
// so a childless project is never the target of an active belongs_to edge.
export function findChildlessProjects(
  graph: GraphData,
): Array<{ id: string; title: string }> {
  const parentsWithChildren = new Set<string>();
  for (const edge of graph.edges) {
    if (
      edge.edge_type === "belongs_to" &&
      (edge.status ?? "active") === "active"
    ) {
      parentsWithChildren.add(edge.target_node_id);
    }
  }
  return graph.nodes
    .filter(
      (n) =>
        n.node_type === "project" &&
        (n.status ?? "active") === "active" &&
        !parentsWithChildren.has(n.id),
    )
    .map((n) => ({ id: n.id, title: n.title }));
}
