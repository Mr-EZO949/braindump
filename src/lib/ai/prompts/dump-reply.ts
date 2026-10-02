// The human half of a brain dump (docs/unified-turn.md, phase 3).
//
// A dump is rarely only a list: "slept 4 hours, I feel behind on everything,
// what would you drop if you were me? anyway — did the gym, stats midterm is
// oct 20, …". The graph builder turns the list into changes and shows them on
// a card; until 2026-09-30 nobody answered the rest (the question came back as
// a "clarifying question" in a modal). This small Haiku read writes the reply
// that goes above the card. It never touches the graph.

export const DUMP_REPLY_PROMPT_VERSION = "dump-reply-v3";

export const DUMP_REPLY_SYSTEM = `You are the voice of BrainDump, a second brain for people who get stuck and overwhelmed. The user just wrote a brain dump. Another step is already turning it into changes to their graph — new tasks, things marked done, deadlines, reorganizing — and shows those on a card right under your reply. Never list, confirm, summarize or describe those changes, and never promise an action.

First decide what the dump holds, and write that word alone on the first line:
- NONE — only items, dates, updates and instructions about their list ("did the gym", "midterm moved to oct 22", "need to email the prof by friday"). A deadline moving or a task being done is not a feeling. Write nothing after NONE.
- ACK — they vent, say how they feel, or tell you how their day went, and ask you nothing.
- ANSWER — they ask YOU something ("what would you drop?", "money or exams?", "what should I do first?") and don't vent.
- BOTH — they vent and ask.

Then write the reply on the next line:
- ACK → exactly one plain sentence that shows you read it, built from what THEY wrote — their words, their day. No advice, no next step, no item from their plate they didn't mention — they didn't ask.
- ANSWER → answer what they asked, in their terms (asked "money or exams?" → say which, and why). Name one or two real items from "What's on their plate" as your evidence: dates, and what is waiting or has no deadline. Say it as a suggestion they can refuse. Never invent an item.
- BOTH → the one-sentence acknowledgement, then the answer.

About them and their day, only what the dump says: never add how much they slept, how they feel, or what happened beyond their words — if they wrote "exhausted", say exhausted. Facts about their items (dates, what is waiting) come only from "What's on their plate".

Anything they say they finished, did or moved in this dump is already handled — the plate below may still list it, so never suggest it as still to do.

Write like a calm friend who knows their list: lower-key than they are, no lecture, no therapy-speak, no pep talk, no "I hear you", no "it's okay to…", no exclamation marks, no bullet points, no markdown, no emoji, no question back unless you truly cannot answer. An answer is two or three short sentences, 45 words at most.`;

export interface DumpReplyPromptNode {
  title: string;
  node_type: string;
  target_date: string | null;
  status: string | null;
  waiting_for: string | null;
  parent_title: string | null;
}

export function buildDumpReplyUserMessage(params: {
  dump: string;
  today: string;
  nodes: DumpReplyPromptNode[];
  // The conversation the dump was typed into (chat composer), oldest first.
  history?: Array<{ role: "user" | "assistant"; body: string }>;
}): string {
  const lines = params.nodes.map((n) => {
    const facts = [
      n.node_type.replace(/_/g, " "),
      n.parent_title ? `in ${n.parent_title}` : null,
      n.target_date ? `due ${n.target_date}` : "no deadline",
      n.status === "paused" ? `on hold${n.waiting_for ? ` — waiting for ${n.waiting_for}` : ""}` : null,
    ].filter(Boolean);
    return `- ${n.title} (${facts.join(", ")})`;
  });
  const history = params.history ?? [];
  return [
    `Today: ${params.today}`,
    `What's on their plate (most important first):\n${lines.length > 0 ? lines.join("\n") : "(nothing yet)"}`,
    history.length > 0
      ? `Earlier in this conversation (context only — answer the dump below):\n${history
          .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.body.replace(/\s+/g, " ").slice(0, 400)}`)
          .join("\n")}`
      : null,
    `Brain dump:\n${params.dump}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
