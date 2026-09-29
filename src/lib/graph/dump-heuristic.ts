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

// Should this chat turn run on the stronger model (Sonnet)? Only STRUCTURAL
// graph edits and full planning — where the weaker model made bad calls
// (issue #19: replacing a parent instead of adding children under it, wrong
// level, un-batched splits). Simple edits — add one item, mark done, rename,
// move a time, delete, set a deadline — are a single tool call with no
// structural judgment, so they stay on Haiku: they're most chat turns, and
// Sonnet costs 2–3× per turn.
//
// Deliberately NOT gated on "?": editing asks are often polite questions
// ("can you split this?"). We only bail on advice/how-to openers, which are
// discussion, not commands.
export function looksLikeStructuralEdit(text: string): boolean {
  const raw = text.trim();
  const t = raw.toLowerCase();
  if (t.length < 3) return false;

  // Advice / how-to / opinion openers → discussion, let the default model chat.
  if (
    /^(how (do|to|can|should|would)|how's|what('s| is| are| would)|why |when should|where should|is it|are there|should i|do you think|what do you think|thoughts on|any (advice|tips|ideas))/.test(
      t,
    )
  ) {
    return false;
  }

  // Reshaping the tree: split / merge / regroup / restructure.
  const RESHAPE =
    /\b(split|break (it|them|this|that|down|up)|break .+ (into|down)|reparent|merge|combine|dedupe|deduplicate|nest|regroup|group .+ (under|into|together)|reorganiz|restructure)\b/;

  // Placing things in the hierarchy ("under the backlog", "move X under Y",
  // "it should belong to the ML exam").
  const PLACEMENT =
    /\b(under|beneath|inside|into|below) (the |my |a |an |two |three )?(backlog|goal|project|task|node|area|parent|epic|exam|class)/;
  const PUT_UNDER =
    /\b(add|create|move|put|place|file|attach)\b.+\b(under|beneath|inside|into|as a (child|subtask|sub-task) of)\b/;
  const BELONGS = /\bbelongs? (to|under|in)\b/;

  // Building a whole plan (one per day or so) — not nudging one block.
  const FULL_PLAN = /\b(plan my|re-?plan|make me a schedule|time.?block)\b/;

  // Adding several things with structure in one go ("add a project X with
  // tasks a, b, c", or a bulleted list).
  const MULTI_ADD =
    /\b(add|create)\b/.test(t) &&
    (/\b(with|including) (\w+ )?(tasks?|steps?|subtasks?|sub-tasks?|children|phases?)\b/.test(t) ||
      (t.match(/,/g)?.length ?? 0) >= 3 ||
      /\n\s*([-*•]|\d+[.)])/.test(raw));

  return (
    RESHAPE.test(t) ||
    PLACEMENT.test(t) ||
    PUT_UNDER.test(t) ||
    BELONGS.test(t) ||
    FULL_PLAN.test(t) ||
    MULTI_ADD
  );
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
