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
  // Multi-item signal: any of the list-like / multi-clause cues. Two
  // sentences with no commas (e.g. "started X. also did Y.") is still a
  // dump even though the regex has no comma to count, so length-gated
  // two-segment messages count too.
  return (
    newlines >= 1 ||
    commas >= 2 ||
    segments >= 3 ||
    (t.length >= 100 && segments >= 2)
  );
}

// Advice / how-to / opinion openers → discussion, not a command.
const ADVICE_OPENER =
  /^(how (do|to|can|should|would)|how's|what('s| is| are| would)|why |when should|where should|is it|are there|should i|do you think|what do you think|thoughts on|any (advice|tips|ideas))/;

// Does the message ask the assistant to GENERATE a breakdown — steps, a
// roadmap, phases the user did not list? Never a route: it hints the chat
// model toward write_steps (chat-router.ts buildHint), where one focused
// Sonnet call writes the steps (lib/ai/step-writer.ts).
//
// Deliberately NOT gated on "?": asks are often polite questions ("can you
// break this down?"). Only advice/how-to openers bail.
export function looksLikeBreakdownAsk(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 3 || ADVICE_OPENER.test(t)) return false;
  return /\b(break (it|them|this|that) (down|up|into)|break .{1,60}? (down|up)\b|break .{1,60}? into (steps|phases|tasks|parts|pieces|chunks|milestones)|breakdown|roadmap|step[- ]by[- ]step|(sub-?tasks?|steps|phases|milestones) (for|to|of|under)\b)/.test(
    t,
  );
}

// Does the text ask to REORGANIZE nodes that already exist — regroup, split,
// re-home, "X should be its own project", "X doesn't belong under Y"? Never a
// route: it (a) hints the chat model toward build_graph and (b) tells the
// builder's retrieval to also show what sits inside the nodes named. One plain
// "move X under Y" and "merge X into Y" are left out — chat has direct tools
// for those.
export function looksLikeRestructure(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 3 || ADVICE_OPENER.test(t)) return false;

  const RESHAPE =
    /\b(split|re-?parent\w*|re-?home\w*|nest|regroup|group .+ (under|into|together)|reorganiz\w*|restructur\w*|convert .+ (into|to) (a |an |its own )?(new |separate |parent )*(project|area|goal|big task|task|parent)|(separate|its own|their own|a new|new parent) (project|area|goal|branch|parent))\b/;
  // "it should belong to the ML exam" — and the negative ("shouldn't belong
  // to", "doesn't go under"), which is a move too.
  const BELONGS =
    /\b(belongs? (to|under|in)|(tasks?|steps?|children|parts?) (in|of|under|inside) (the|that|this|a) (project|goal|area|big task))\b/;

  return RESHAPE.test(t) || BELONGS.test(t);
}

// Active projects and big tasks with no children — candidates for a "want a
// roadmap?" / "break it down?" nudge. A child belongs_to a parent (edge: source=child, target=parent),
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
        (n.node_type === "project" || n.node_type === "big_task") &&
        (n.status ?? "active") === "active" &&
        !parentsWithChildren.has(n.id),
    )
    .map((n) => ({ id: n.id, title: n.title }));
}
