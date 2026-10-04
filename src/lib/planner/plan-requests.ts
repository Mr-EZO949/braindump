// "Plan 3h of Italian, 2h of math" → what the plan must include. The words come
// from the Planner's "Anything to fit in?" box or chat's plan_day `include`.
// Parsing and the match to a node are deterministic; a phrase that names no
// node by its words ("math" when the class is called "Statistics") goes to the
// plan model as the user's words, and it picks the item they mean.

export interface PlanRequest {
  /** The user's words for this item ("3h of Italian"). */
  text: string;
  /** What they want time for, filler stripped ("italian"). */
  phrase: string;
  /** Requested length, when they gave one. */
  minutes: number | null;
}

const MAX_REQUESTS = 6;
const MAX_REQUEST_MINUTES = 8 * 60;

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

const HOURS = String.raw`(?:h|hr|hrs|hour|hours)`;
const MINS = String.raw`(?:m|min|mins|minute|minutes)`;
const DURATION_RES: Array<{ re: RegExp; minutes: (m: RegExpMatchArray) => number }> = [
  // "half an hour"
  { re: /\bhalf\s+an?\s+hour\b/i, minutes: () => 30 },
  // "1h30", "1.5h", "2 hours", "1 hour 30 min", "1h 15m"
  {
    re: new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*${HOURS}(?![a-z])\.?(?:\s*(?:and\s*)?(\d{1,2})\s*(?:${MINS}(?![a-z]))?)?`, "i"),
    minutes: (m) => Math.round(Number(m[1].replace(",", ".")) * 60) + (m[2] ? Number(m[2]) : 0),
  },
  // "90 min", "45m"
  { re: new RegExp(String.raw`(\d+)\s*${MINS}(?![a-z])`, "i"), minutes: (m) => Number(m[1]) },
  // "an hour", "two hours"
  {
    re: new RegExp(String.raw`\b(a|an|one|two|three|four|five|six)\s+${HOURS}(?![a-z])`, "i"),
    minutes: (m) => (NUMBER_WORDS[m[1].toLowerCase()] ?? 1) * 60,
  },
];

const FILLER = new Set([
  "a",
  "about",
  "add",
  "also",
  "an",
  "around",
  "at",
  "block",
  "do",
  "doing",
  "for",
  "i",
  "in",
  "include",
  "least",
  "me",
  "my",
  "need",
  "of",
  "on",
  "plan",
  "please",
  "practice",
  "practise",
  "session",
  "some",
  "study",
  "studying",
  "the",
  "time",
  "to",
  "want",
  "with",
  "work",
  "working",
]);

function parseDuration(chunk: string): { minutes: number | null; rest: string } {
  for (const { re, minutes } of DURATION_RES) {
    const m = chunk.match(re);
    if (m && m.index !== undefined) {
      const value = minutes(m);
      const rest = `${chunk.slice(0, m.index)} ${chunk.slice(m.index + m[0].length)}`;
      return { minutes: value > 0 ? Math.min(MAX_REQUEST_MINUTES, value) : null, rest };
    }
  }
  return { minutes: null, rest: chunk };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

export function parsePlanRequests(text: string | null | undefined): PlanRequest[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const chunks = text
    .slice(0, 400)
    // "3h of Italian and 2h of math": split on "and" only before a length,
    // so "numbers and telling time" stays one item.
    .split(/[,;\n+]|\band\b(?=\s*(?:\d|an?\s+hour|half\b|one\b|two\b|three\b))|&(?=\s*\d)/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const out: PlanRequest[] = [];
  for (const chunk of chunks) {
    const { minutes, rest } = parseDuration(chunk);
    const phrase = words(rest)
      .filter((w) => !FILLER.has(w))
      .join(" ");
    if (!phrase) continue;
    out.push({ text: chunk.replace(/\s+/g, " "), phrase, minutes });
    if (out.length >= MAX_REQUESTS) break;
  }
  return out;
}

export interface RequestableNode {
  id: string;
  title: string;
  node_type: string;
}

function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // "stats" ~ "statistics": a shared stem of 4+ letters.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= 4;
}

// Bigger things first on a tie: "Italian" means the course, not a lesson.
const TYPE_PREFERENCE: Record<string, number> = { class: 3, big_task: 3, project: 3, goal: 2, task: 1, habit: 1 };

/**
 * The node a phrase names by its words, or null. Every phrase word must match
 * a title word ("stats midterm" → "Pass Statistics Midterm"); ties go to the
 * title with fewer extra words, then the bigger item.
 */
export function matchRequest<T extends RequestableNode>(phrase: string, nodes: T[]): T | null {
  const want = words(phrase);
  if (want.length === 0) return null;
  let best: { node: T; extra: number; pref: number } | null = null;
  for (const node of nodes) {
    const have = words(node.title).filter((w) => !FILLER.has(w));
    if (have.length === 0) continue;
    if (!want.every((w) => have.some((h) => tokenMatch(w, h)))) continue;
    const extra = have.filter((h) => !want.some((w) => tokenMatch(w, h))).length;
    const pref = TYPE_PREFERENCE[node.node_type] ?? 0;
    if (!best || extra < best.extra || (extra === best.extra && pref > best.pref)) {
      best = { node, extra, pref };
    }
  }
  return best?.node ?? null;
}

/** "2h", "1h 30m", "45 min" */
export function formatRequestMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
