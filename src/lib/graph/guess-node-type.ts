// A free, deterministic guess at a new node's type from its title — the
// create sheet pre-selects it and the user changes it with one tap. No model
// call: a wrong guess costs one click, a model call costs a wait on every
// keystroke. The type rules themselves live in node-types.ts; this only reads
// the words.
//
// Conservative on purpose: anything it can't place is a task (the type most
// new nodes are), and "is it really several sittings?" stays with the sizing
// check that runs after a task is created (lib/ai/sizing.ts).

import { classifyTaskSize } from "@/lib/ai/sizing";
import type { NodeType } from "@/types/graph";

const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun";

// "every morning", "3x a week", "twice a day", "daily", "on weekdays"…
const HABIT_PATTERN = new RegExp(
  [
    String.raw`\bevery\s*(day|morning|evening|night|week|weekday|weekend|other day|${WEEKDAYS})s?\b`,
    String.raw`\beach\s+(day|morning|evening|night|week)\b`,
    String.raw`\b(daily|nightly|weekly)\b`,
    String.raw`\b\d+\s*(x|×|times)\s*(a|per|\/)\s*(day|week)\b`,
    String.raw`\b\d+x\/(day|week|wk)\b`,
    String.raw`\b(once|twice)\s+(a|per)\s+(day|week)\b`,
    String.raw`\bon\s+(weekdays|weekends)\b`,
  ].join("|"),
);

// A result you'll know you reached: "pass X", "land an internship", "1450+".
const GOAL_LEADERS = new Set([
  "pass",
  "land",
  "reach",
  "hit",
  "win",
  "graduate",
  "achieve",
  "ace",
  "become",
]);
const GOAL_PHRASES = /^(get (into|accepted|an? (internship|job|offer)|my (degree|license|licence))|lose \d|save \$?\d|earn \$?\d)/;
const SCORE_TARGET = /\b\d{2,}\s*\+(?=\s|$)/;

const IDEA_LEADERS = /^(maybe|idea[:\s]|what if|could|might|someday|one day|thinking about)\b/;
const NOTE_LEADERS = /^(note[:\s]|remember( that)?\b|fyi\b|advice[:\s]|tip[:\s]|reminder[:\s])/;
// "Noah Kim is my TA" — a fact about someone or something.
const NOTE_FACT = /\bis (my|our)\b/;

// Parts of life with no finish line, as people name them.
const AREA_TITLES = new Set([
  "health",
  "fitness",
  "university",
  "uni",
  "school",
  "college",
  "career",
  "work",
  "job",
  "finances",
  "finance",
  "money",
  "family",
  "friends",
  "home",
  "life admin",
  "admin",
  "relationships",
  "personal development",
  "personal growth",
  "hobbies",
  "side projects",
  "learning",
]);

// "Linear Algebra class", "Deep Learning course" — but not "Italian crash course".
const CLASS_SUFFIX = /\b(class|course|module|seminar|lecture|lectures)$/;

// One piece of work over several sittings, named by what you produce.
const BIG_WORK = /^(write|finish|draft) (the |my |a |an )?(thesis|dissertation|book|novel|portfolio)\b/;

function normalize(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function guessNodeType(title: string): NodeType {
  const text = normalize(title);
  if (!text) return "task";
  const firstWord = text.split(" ")[0].replace(/[^a-z]/g, "");

  if (NOTE_LEADERS.test(text) || NOTE_FACT.test(text)) return "note";
  if (IDEA_LEADERS.test(text)) return "idea";
  if (HABIT_PATTERN.test(text)) return "habit";
  if (GOAL_LEADERS.has(firstWord) || GOAL_PHRASES.test(text) || SCORE_TARGET.test(text)) return "goal";
  if (AREA_TITLES.has(text)) return "area";
  if (CLASS_SUFFIX.test(text) && !/crash course$/.test(text) && classifyTaskSize(text) === "ambiguous") {
    return "class";
  }
  if (BIG_WORK.test(text)) return "big_task";
  if (classifyTaskSize(text) === "project") return firstWord === "launch" ? "project" : "big_task";
  return "task";
}
