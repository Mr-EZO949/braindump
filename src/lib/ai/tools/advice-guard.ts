// Advice stays advice — the server's backstop (owner, 2026-10-02: what the
// user SAYS applies at once with Undo; what the assistant ADVISES waits for
// OK on a Suggested card).
//
// The prompt says it, and Haiku still folds its own answer into the user's
// update_priorities call: "the CV update can wait till next week, should I
// focus on stats or the internship today?" applied "Pass Statistics Midterm —
// Focus this week" next to the CV (assistant-v26…v28; real route 2026-10-04).
//
// Rule: in a message that ASKS something, a judgment row — focus, can-wait,
// stakes, drop — counts as the user's only when a clause they STATED carries
// that kind of word. Otherwise it's the assistant's answer to the question,
// and waits. Facts (done, waiting, resume, a deadline) always stay the
// user's. A message that asks nothing is left to the model.

type Row = { action?: unknown };

const JUDGMENT_WORDS: Record<string, RegExp> = {
  focus: /\b(focus\w*|first|priorit\w*|main thing|most important|top priority|all in)\b/i,
  deprioritize:
    /\b(can wait|wait (till|until)|later|next (week|month)|not (now|urgent|a priority)|less important|deprioriti\w*|back ?burner|on hold|park\w*|push\w* (it |that )?back|put (it |that )?off|postpon\w*)\b/i,
  // "need the stats midterm for my scholarship" too, not only "need it for" (#22 eval).
  stakes: /\b(matters?|important|rides on|depends on|need (it|this|that|the [\w' -]{1,40}?) for|pass\/fail|barely counts|counts?|high stakes|low stakes|big deal)\b/i,
  drop: /\b(drop\w*|cancel\w*|not doing|quit\w*|giv\w* up|abandon\w*|no longer|forget (about )?it|scrap\w*)\b/i,
};

const ASKING = /^(should|shall|which|what|what's|whats|would you|do you think|is it|are they|how)\b/i;

// The message's clauses: sentences, and a ", should I…" tail split off the
// statement it follows. A clause is a question when it ends with "?" or
// opens like one.
export function messageClauses(message: string): Array<{ text: string; asks: boolean }> {
  return message
    .split(/(?<=[.!?;\n])\s+|(?:,\s*|\s+[—–-]+\s+)(?=(?:should|shall|which|what|or should|do you think|would you)\b)/i)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, asks: text.endsWith("?") || ASKING.test(text) }));
}

// The positions of the rows that are the assistant's advice, not the user's.
export function adviceRows(message: string, rows: Row[]): number[] {
  const clauses = messageClauses(message);
  if (!clauses.some((c) => c.asks)) return [];
  const stated = clauses.filter((c) => !c.asks).map((c) => c.text);
  return rows.flatMap((row, i) => {
    const words = typeof row?.action === "string" ? JUDGMENT_WORDS[row.action] : undefined;
    if (!words) return [];
    return stated.some((text) => words.test(text)) ? [] : [i];
  });
}
