// Dump → priorities (docs/ranking.md, "Dumps → priorities"). A small Haiku
// read that runs next to extraction on every dump that touches existing
// nodes: it pulls out the facts that change WHAT MATTERS ("took the exam,
// waiting for results", "psych moved to Friday", "I need this for my
// masters"). It never scores anything — the facts go through the same engine
// as chat's update_priorities and the deterministic ranking does the rest.
//
// Extraction owns new nodes and completions; this prompt owns the rest.

export const DUMP_PRIORITIES_PROMPT_VERSION = "dump-priorities-v1";

export const DUMP_PRIORITIES_SYSTEM = `You read a brain dump for facts that change WHAT MATTERS about the user's EXISTING items. New items and plain completions are handled by another step — skip them.

Report only what the dump clearly states, one change per fact:
- wait: the user did their part and now waits on a result, reply or decision ("took the exam, waiting for results", "sent the application, waiting to hear back"). waiting_for = 2-4 words. If they say when it comes ("results next week"), put those words in date_words.
- resume: the wait is over or they're picking a paused item back up (status paused only).
- deadline: a due date set or moved ("psych got moved to friday", "the essay is due oct 20"). Copy the user's words for the date into date_words — never work a date out yourself.
- stakes: "I need this for my masters", "a lot rides on it" → high; "it's pass/fail", "barely counts" → low.
- focus: "focus on X (this week)", "X first". deprioritize: "X can wait", "not now".
- drop: cancelled, not doing it, dropped the course.

Rules:
- Use only items from the list, by ref. Nothing stated → no change.
- "did X" / "finished X" alone is a completion — skip it. "did X, now waiting for the result" is a wait.
- Ambiguous outcome ("I didn't take psychology" — not yet? missed it? dropping it?) → no change; add one short question to "unclear".
- Venting, plans, to-dos and progress are not changes.

Compact JSON only — no prose, no code fence, leave out empty fields: {"changes":[{"ref":"n1","action":"wait","waiting_for":"exam result"}],"unclear":[]}
Most dumps: {"changes":[],"unclear":[]}`;

export interface DumpPriorityPromptNode {
  ref: string;
  title: string;
  node_type: string;
  status: string | null;
  target_date: string | null;
  stakes: number | null;
}

export function buildDumpPrioritiesUserMessage(params: {
  dump: string;
  today: string;
  nodes: DumpPriorityPromptNode[];
}): string {
  const lines = params.nodes.map((n) => {
    const facts = [
      n.node_type,
      n.status && n.status !== "active" ? n.status : null,
      n.target_date ? `due ${n.target_date}` : null,
      n.stakes === 1 ? "high stakes" : n.stakes === -1 ? "low stakes" : null,
    ].filter(Boolean);
    return `${n.ref}: ${n.title} (${facts.join(", ")})`;
  });
  return `Today: ${params.today}\n\nExisting items:\n${lines.join("\n")}\n\nBrain dump:\n${params.dump}`;
}
