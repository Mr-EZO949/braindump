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
  /** Their words without the length or time, as a block title ("Italian", "Mealprep"). */
  label: string;
  /** A clock time they gave ("mealprep from 12:30", "12:30–14:00"): minutes of the day. */
  start: number | null;
  /** Its end: from a range, else start + length (1h when none). */
  end: number | null;
  /** A list in brackets ("6h academics (Calculus, Probability, ML)"): each item's phrase. */
  parts: string[];
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
  "like",
  "me",
  "my",
  "need",
  "now",
  "of",
  "on",
  "plan",
  "please",
  "practice",
  "practise",
  "right",
  "session",
  "some",
  "study",
  "studying",
  "the",
  "time",
  "to",
  "today",
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

// A clock time in a request: "from 12:30", "at 4pm", "12:30–14:00", "4-6pm".
// A bare hour 1–7 with no am/pm is the afternoon ("at 4" = 16:00).
const CLOCK = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?`;
const RANGE_RE = new RegExp(String.raw`\b(?:from\s+)?${CLOCK}\s*(?:-|–|—|to|until|till)\s*${CLOCK}(?![\d])`, "i");
const AT_RE = new RegExp(String.raw`\b(?:from|at|@|starting(?:\s+at)?)\s+(?:like\s+|around\s+|about\s+)?${CLOCK}(?![\d]|\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b)`, "i");
const BARE_CLOCK_RE = /\b(\d{1,2}):(\d{2})\b/;

function clockMinute(hourText: string, minuteText: string | undefined, meridiem: string | undefined): number | null {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (hour > 23 || minute > 59) return null;
  const ampm = meridiem?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  else if (ampm === "am" && hour === 12) hour = 0;
  else if (!ampm && !minuteText && hour >= 1 && hour <= 7) hour += 12;
  else if (!ampm && minuteText && hour >= 1 && hour <= 6) hour += 12;
  return hour * 60 + minute;
}

function parseClock(chunk: string): { start: number | null; end: number | null; rest: string } {
  const cut = (m: RegExpMatchArray) => `${chunk.slice(0, m.index)} ${chunk.slice((m.index ?? 0) + m[0].length)}`;
  const range = chunk.match(RANGE_RE);
  // A range needs a sure clock on one side: "2-3 hours" is a length, not a time.
  if (range && (range[2] || range[3] || range[5] || range[6])) {
    const endMeridiem = range[6];
    const start = clockMinute(range[1], range[2], range[3] ?? (endMeridiem && Number(range[1]) < 12 ? endMeridiem : undefined));
    const end = clockMinute(range[4], range[5], endMeridiem);
    if (start !== null && end !== null && end > start) return { start, end, rest: cut(range) };
  }
  const at = chunk.match(AT_RE);
  if (at) {
    const start = clockMinute(at[1], at[2], at[3]);
    if (start !== null) return { start, end: null, rest: cut(at) };
  }
  const bare = chunk.match(BARE_CLOCK_RE);
  if (bare) {
    const start = clockMinute(bare[1], bare[2], undefined);
    if (start !== null) return { start, end: null, rest: cut(bare) };
  }
  return { start: null, end: null, rest: chunk };
}

// "mealprep right now" → "Mealprep": the user's words, filler trimmed off the
// ends, first letter up.
function labelOf(rest: string): string {
  const parts = rest.replace(/[()[\]"“”]/g, " ").split(/\s+/).filter(Boolean);
  const isFiller = (w: string) => FILLER.has(w.toLowerCase().replace(/[^a-z0-9à-ÿ]/g, ""));
  while (parts.length > 0 && isFiller(parts[0])) parts.shift();
  while (parts.length > 0 && isFiller(parts[parts.length - 1])) parts.pop();
  const label = parts.join(" ").replace(/[,.;:!?—–-]+$/, "").slice(0, 80);
  return label ? label[0].toUpperCase() + label.slice(1) : "";
}

// Split on commas / "and" before a length — but not inside brackets:
// "6h academics (Calculus, Probability, ML), coding" is two requests (owner's
// Wednesday plan, 10-06: the 6h went to "academics (Calculus" alone).
function splitChunks(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const rest = text.slice(0, 400);
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
    if (depth === 0 && /[,;\n+]/.test(ch)) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.flatMap((chunk) =>
    chunk.split(/\band\b(?=\s*(?:\d|an?\s+hour|half\b|one\b|two\b|three\b))|&(?=\s*\d)/i),
  );
}

function bracketParts(text: string): string[] {
  const inside = text.match(/[([]([^)\]]+)[)\]]/)?.[1];
  if (!inside) return [];
  return inside
    .split(/,|\band\b|&|\//i)
    .map((part) => words(part).filter((w) => !FILLER.has(w)).join(" "))
    .filter(Boolean)
    .slice(0, 6);
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
  // "3h of Italian and 2h of math": split on "and" only before a length,
  // so "numbers and telling time" stays one item.
  const chunks = splitChunks(text)
    .map((c) => c.trim())
    .filter(Boolean);
  const out: PlanRequest[] = [];
  for (const chunk of chunks) {
    const clock = parseClock(chunk);
    const { minutes, rest } = parseDuration(clock.rest);
    const phrase = words(rest)
      .filter((w) => !FILLER.has(w))
      .join(" ");
    if (!phrase) continue;
    const end =
      clock.start === null ? null : (clock.end ?? Math.min(24 * 60, clock.start + (minutes ?? 60)));
    out.push({
      text: chunk.replace(/\s+/g, " "),
      phrase,
      minutes: clock.start !== null && end !== null ? end - clock.start : minutes,
      label: labelOf(rest) || phrase,
      start: clock.start,
      end,
      parts: bracketParts(rest),
    });
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
  return matchRequestAll(phrase, nodes)[0] ?? null;
}

/** Every node a phrase names by its words, best first (matchRequest's order). */
export function matchRequestAll<T extends RequestableNode>(phrase: string, nodes: T[]): T[] {
  const want = words(phrase);
  if (want.length === 0) return [];
  const found: Array<{ node: T; extra: number; pref: number }> = [];
  for (const node of nodes) {
    const have = words(node.title).filter((w) => !FILLER.has(w));
    if (have.length === 0) continue;
    if (!want.every((w) => have.some((h) => tokenMatch(w, h)))) continue;
    const extra = have.filter((h) => !want.some((w) => tokenMatch(w, h))).length;
    found.push({ node, extra, pref: TYPE_PREFERENCE[node.node_type] ?? 0 });
  }
  // Stable: equal matches keep the nodes' order.
  return found.sort((a, b) => a.extra - b.extra || b.pref - a.pref).map((f) => f.node);
}

// Words that say what KIND of work, not what it is about: "look into the
// selectives" and "research selectives" are the same request.
const WEAK_WORDS = new Set([
  "bunch",
  "check",
  "do",
  "few",
  "find",
  "finish",
  "fully",
  "get",
  "go",
  "into",
  "look",
  "lot",
  "make",
  "more",
  "out",
  "prep",
  "prepare",
  "properly",
  "read",
  "research",
  "review",
  "start",
  "stuff",
  "things",
  "up",
  "update",
  "write",
]);

/**
 * Does a block title cover what a request asked for? Its subject words (weak
 * verbs dropped) must be in the title — all of one or two, most of more.
 */
export function titleCoversRequest(title: string, phrase: string): boolean {
  const all = words(phrase).filter((w) => !FILLER.has(w));
  const subject = all.filter((w) => !WEAK_WORDS.has(w));
  const want = subject.length > 0 ? subject : all;
  if (want.length === 0) return false;
  const have = words(title);
  const hits = want.filter((w) => have.some((h) => tokenMatch(w, h))).length;
  return hits >= Math.ceil(want.length * 0.6);
}

/** "2h", "1h 30m", "45 min" */
export function formatRequestMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * What the user asked for AT a time ("1.5h mealprep from 12:30", "dentist at
 * 4"): fixed time on the plan's day — planned around and put on the day as
 * it is, not handed to the model as something to fit in.
 */
export function timedRequests(text: string | null | undefined): Array<{ id: string; title: string; start: number; end: number }> {
  return parsePlanRequests(text).flatMap((request, index) =>
    request.start !== null && request.end !== null && request.end > request.start
      ? [{ id: `at-${index}`, title: request.label, start: request.start, end: request.end }]
      : [],
  );
}

/**
 * The chat model sometimes drops the time from what the user said ("i want
 * 1.5h mealprep right now from like 12:30" → include "1.5h mealprep", owner
 * 10-06). An include item the user's own message gives a clock time for is
 * fixed time at that clock time; the rest stays to fit in.
 */
export function pinFromMessage(
  include: string | null | undefined,
  message: string | null | undefined,
): { include: string | null; fixed: Array<{ id: string; title: string; start: number; end: number }> } {
  const fixed = timedRequests(include);
  // Sentence by sentence: "a lecture at 15:30 to 18:30. Other than that look
  // into the selectives" must not give the selectives the lecture's time.
  const said = parsePlanRequests((message ?? "").replace(/[.!?]+\s+/g, ", ")).filter(
    (r) => r.start !== null && r.end !== null,
  );
  const rest: string[] = [];
  for (const request of parsePlanRequests(include)) {
    if (request.start !== null) continue;
    const want = words(request.phrase);
    // The timed words are about this item: all of it named, at most two words more.
    const match = said.find((t) => {
      const have = words(t.phrase);
      if (want.length === 0 || !want.every((w) => have.some((h) => tokenMatch(w, h)))) return false;
      return have.filter((h) => !want.some((w) => tokenMatch(w, h))).length <= 2;
    });
    if (!match || match.start === null || match.end === null) {
      rest.push(request.text);
      continue;
    }
    const end = request.minutes ? Math.min(24 * 60, match.start + request.minutes) : match.end;
    fixed.push({ id: `said-${fixed.length}`, title: request.label, start: match.start, end });
  }
  return { include: rest.length > 0 ? rest.join(", ") : null, fixed };
}
