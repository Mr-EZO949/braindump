// Task sizing heuristic.
//
// Cheap, LLM-free first pass that labels a new task title as one of:
//   - 'task'      — clearly a single sitting; create as-is
//   - 'project'   — clearly multi-step; offer to break it down
//   - 'ambiguous' — can't tell from the words; caller escalates to Haiku
//                   (POST /api/assistant/classify-size, which fails safe to 'task')
//
// The point is to NOT call the model on the obvious cases ("call mom",
// "build authentication system"), which is most of them. 'ambiguous' is the
// safety net — when in doubt we defer to the cheap classifier rather than
// guessing wrong here. Promoting a real task to a project by mistake is the
// expensive error (it interrupts capture and invites orphan children), so the
// rules below only commit to 'project' when the title LEADS with a scope verb.

export type TaskSize = "task" | "project" | "ambiguous";

// Verbs that, as the FIRST word of a title, reliably signal a multi-step
// endeavour: "learn Italian", "build auth", "redesign onboarding".
// Lead-position only — matching anywhere wrongly promotes "fix the build
// script" (noun sense). Deliberately EXCLUDES "create" and "design": those
// lead single-sitting tasks just as often ("create account", "design a logo")
// as projects, so they fall through to the classifier rather than auto-promote.
const PROJECT_VERB_LEADERS = new Set([
  "build", "implement", "learn", "launch", "master",
  "develop", "redesign", "rebuild",
]);

// Concrete, single-sitting action verbs. A short title led by one of these
// is almost always a real task ("call mom", "fix login bug"). Deliberately
// excludes vague verbs like "plan" — those should escalate to the classifier.
const ACTION_VERBS = new Set([
  "call", "email", "text", "fix", "send", "read", "buy", "book", "schedule",
  "draft", "review", "update", "add", "remove", "check", "ask", "pay",
  "submit", "file", "print", "reply", "watch", "clean", "renew", "cancel",
]);

function words(title: string): string[] {
  return title.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function classifyTaskSize(title: string): TaskSize {
  const w = words(title);
  if (w.length === 0) return "task";

  // (1) A single token has no object to scope an endeavour around — "Build",
  // "Learn", "thread_create" alone are quick labels, not projects. Guard
  // before the leader check so a lone verb isn't force-promoted.
  if (w.length === 1) return "task";

  // (2) Leading project verb → project. Checked before the short-action rule
  // so "learn italian" (2 words) isn't short-circuited to a task.
  if (PROJECT_VERB_LEADERS.has(w[0])) return "project";

  // (3) Short + concrete action verb → task ("call mom", "fix login bug").
  if (w.length <= 3 && ACTION_VERBS.has(w[0])) return "task";

  // Can't tell from the words alone — defer to the cheap classifier.
  return "ambiguous";
}
