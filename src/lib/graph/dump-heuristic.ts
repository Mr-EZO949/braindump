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

// Does a chat message look like a GRAPH-EDITING command (add / connect / split /
// merge / move / rename / archive / complete something in the graph) rather than
// a plain question? Used to route the turn to the stronger reasoning model
// (Sonnet) — structural edits are where the weaker model made bad calls
// (e.g. replacing a parent instead of adding children under it). A miss just
// falls back to the default model, so this leans toward recall.
//
// Deliberately NOT gated on "?": editing asks are often polite questions
// ("can you connect X to Y?", "could you mark these done?"). We only bail on
// advice/how-to openers, which are discussion, not commands.
export function looksLikeGraphEdit(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 3) return false;

  // Advice / how-to / opinion openers → discussion, let the default model chat.
  if (
    /^(how (do|to|can|should|would)|how's|what('s| is| are| would)|why |when should|where should|is it|are there|should i|do you think|what do you think|thoughts on|any (advice|tips|ideas))/.test(
      t,
    )
  ) {
    return false;
  }

  // Structural / lifecycle editing verbs. Word-boundaried to avoid substrings
  // like "made" matching "add". "break … into", "put/group/nest under" are the
  // hierarchy phrasings that tripped up the weak model.
  const EDIT_INTENT =
    /\b(add|create|capture|track|split|break (it|them|this|that|down|up)|break .+ (into|down)|reparent|move|rename|retitle|relabel|merge|combine|dedupe|deduplicate|connect|link|attach|nest|group|reorganiz|restructure|delete|remove|archive|complete|finish|finished|mark .+ (done|complete|completed)|done with|shipped|wrapped up|knocked out|set (the )?deadline|schedule|plan my|time.?block|make me a schedule)\b/;

  // Hierarchy prepositions paired with a graph noun ("under the backlog",
  // "into two projects", "as a child of …").
  const STRUCTURAL_PLACEMENT =
    /\b(under|beneath|inside|into|below) (the |my |a |an |two |three )?(backlog|goal|project|task|node|area|parent|epic|exam|class)/;

  return EDIT_INTENT.test(t) || STRUCTURAL_PLACEMENT.test(t);
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
