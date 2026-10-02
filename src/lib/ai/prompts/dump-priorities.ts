// Dump → priorities (docs/ranking.md, "Dumps → priorities") and fixed
// commitments (docs/commitments.md). A small Haiku read that runs next to
// extraction on every dump that touches existing nodes or names a weekly time:
// it pulls out the facts that change WHAT MATTERS ("took the exam, waiting for
// results", "psych moved to Friday", "I need this for my masters") and the
// user's fixed weekly commitments ("stats every day at 2pm"). It never scores
// anything — the facts go through the same engines as chat's update_priorities
// and set_commitments, and the deterministic ranking does the rest.
//
// Extraction owns new nodes and completions; this prompt owns the rest.

// v3 (2026-09-30): a date or to-do for something NEW is not a change to the
// existing class / project it belongs to — "for ML I have to pick a dataset by
// friday" put "due Oct 2" on the class Machine Learning, and "need to review
// chapters 1-4" became "focus" on Statistics; and one fact changes one item
// ("stats midterm is oct 20" dated the midterm goal AND the class); a to-do
// about an item ("email the prof about the midterm by friday") does not date
// the item.
export const DUMP_PRIORITIES_PROMPT_VERSION = "dump-priorities-v3";

export const DUMP_PRIORITIES_SYSTEM = `You read a brain dump for two kinds of facts. New items and plain completions are handled by another step — skip them.

1. "changes" — facts that change WHAT MATTERS about the user's EXISTING items, one change per fact:
- wait: the user did their part and now waits on a result, reply or decision ("took the exam, waiting for results", "sent the application, waiting to hear back"). waiting_for = 2-4 words. If they say when it comes ("results next week"), put those words in date_words.
- resume: the wait is over or they're picking a paused item back up (status paused only).
- deadline: a due date set or moved FOR THAT ITEM ("psych got moved to friday", "the essay is due oct 20"). Copy the user's words for the date into date_words — never work a date out yourself. A date on a to-do that is ABOUT an item is the to-do's date, not the item's: "need to email prof marino about the stats midterm review by friday" → no change (the email is new; the midterm's date didn't move).
- stakes: "I need this for my masters", "a lot rides on it" → high; "it's pass/fail", "barely counts" → low.
- focus: only when they say it — "focus on X (this week)", "X first"; "need to finish X" is a to-do, not focus. deprioritize: "X can wait", "not now".
- drop: cancelled, not doing it, dropped the course.
Use only items from the list, by ref (n1…), and only when the fact is about THAT item itself. One fact changes ONE item — the most specific one it is about ("stats midterm is oct 20" → the midterm goal, not also the Statistics class). A date or a to-do for a step or a new piece of work inside a listed class, project or area ("for ML I have to pick a dataset by friday", "need to review chapters 1-4 for stats") is a new item — skip it, it is not a deadline or a focus for the class or project. "did X" / "finished X" alone is a completion — skip it; "did X, now waiting for the result" is a wait. Ambiguous outcome ("I didn't take psychology" — not yet? missed it? dropping it?) → no change; add one short question to "unclear". Venting, plans, to-dos and progress are not changes. Requests to reorganize the graph (move X under Y, rename, regroup, "keep that connection") are carried out by another step — no change, and never an "unclear" question about them. Write questions with the item's title, never its ref.

2. "commitments" — FIXED weekly times the user is busy because of something set by others: a class or lecture, lab, work shift, practice, standing meeting.
- add: {"action":"add","title":"Stats lecture","days":["mon","tue","wed","thu","fri"],"start":"14:00","end":"15:30","until":"dec 20","node":"n2"}. days from mon,tue,wed,thu,fri,sat,sun; "every day" for a class, lecture or job = mon–fri. start/end are 24h HH:MM; leave end out if not said. until = the user's words for when it stops, only if said. node = the listed item it belongs to, if any.
- update or remove one from the Fixed commitments list by its ref (c1…) — only when the dump talks about that same activity: {"action":"update","ref":"c1","start":"18:00"} · {"action":"remove","ref":"c1"}. Never add one that's already listed.
- Commitment rows (c refs, add/update/remove) go ONLY in "commitments", never in "changes". Naming a class's schedule is not a focus, stakes or deadline change for it.
- Not commitments: one-off events ("dentist thursday at 3"), deadlines, and habits or routines they set for themselves ("gym every morning", "read at 9pm").

Compact JSON only — no prose, no code fence, leave out empty fields: {"changes":[{"ref":"n1","action":"wait","waiting_for":"exam result"}],"commitments":[],"unclear":[]}
Most dumps: {"changes":[],"commitments":[],"unclear":[]}`;

export interface DumpPriorityPromptNode {
  ref: string;
  title: string;
  node_type: string;
  status: string | null;
  target_date: string | null;
  stakes: number | null;
}

export interface DumpPriorityPromptCommitment {
  ref: string;
  title: string;
  /** describeCommitment() — "Mon–Fri 14:00–15:00 · until Dec 20". */
  when: string;
}

export function buildDumpPrioritiesUserMessage(params: {
  dump: string;
  today: string;
  nodes: DumpPriorityPromptNode[];
  commitments?: DumpPriorityPromptCommitment[];
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
  const commitments = params.commitments ?? [];
  return [
    `Today: ${params.today}`,
    `Existing items:\n${lines.length > 0 ? lines.join("\n") : "(none)"}`,
    commitments.length > 0
      ? `Fixed commitments:\n${commitments.map((c) => `${c.ref}: ${c.title} (${c.when})`).join("\n")}`
      : null,
    `Brain dump:\n${params.dump}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
