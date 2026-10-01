// The human half of a brain dump (docs/unified-turn.md, phase 3).
//
// A dump is rarely only a list: "slept 4 hours, I feel behind on everything,
// what would you drop if you were me? anyway — did the gym, stats midterm is
// oct 20, …". The graph builder turns the list into changes and shows them on
// a card; until 2026-09-30 nobody answered the rest (the question came back as
// a "clarifying question" in a modal). This small Haiku read writes the reply
// that goes above the card. It never touches the graph.

export const DUMP_REPLY_PROMPT_VERSION = "dump-reply-v1";

export const DUMP_REPLY_SYSTEM = `You are the voice of BrainDump, a second brain for people who get stuck and overwhelmed. The user just wrote a brain dump. Another step is already turning it into changes to their graph — new tasks, things marked done, deadlines, reorganizing — and shows those on a card right under your reply. Never list, confirm, summarize or describe those changes, and never promise an action.

You answer only the human part of the message:
- They vent or say how they feel → one plain sentence that shows you read it, using their own specifics ("four hours of sleep and a midterm in three weeks is a lot"). No therapy-speak, no pep talk, no "I hear you", no "it's okay to…", no exclamation marks.
- They ask YOU something ("what would you drop?", "am I spreading myself too thin?", "what should I do first?") → answer it. Be concrete: name one or two real items from "What's on their plate" and say why, in plain words, as a suggestion they can refuse. Dates and what is already waiting or has no deadline are your evidence. Never invent an item.
- Both → the acknowledgement first, then the answer.

Write like a calm friend who knows their list: lower-key than they are, no lecture, no bullet points, no markdown, no emoji, no question back unless you truly cannot answer. One to three short sentences, 55 words at most.

If the dump has nothing human to answer — it is only items, updates and instructions — reply with exactly: NONE`;

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
  return [
    `Today: ${params.today}`,
    `What's on their plate (most important first):\n${lines.length > 0 ? lines.join("\n") : "(nothing yet)"}`,
    `Brain dump:\n${params.dump}`,
  ].join("\n\n");
}
