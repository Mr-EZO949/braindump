// "friday" / "next tuesday" / "tomorrow" / "in 3 days" → YYYY-MM-DD, against
// the user's local today. Deterministic on purpose: Haiku resolved "this
// Friday" (said on a Wednesday) to the Saturday in 1 of 2 runs even with the
// next seven dates listed in its prompt (assistant-v21 eval), so tools that
// take dates accept the user's words and resolve them here.
//
// Rules: a bare weekday or "this <weekday>" is the coming one (today counts
// only with "this"); "next <weekday>" is the one in next week's Mon–Sun when
// the coming one still falls in this week, else the coming one.

import { addDaysISO } from "./local-date";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function weekdayIndex(word: string): number {
  // "fri", "friday", "fridays"
  return WEEKDAYS.findIndex((day) => word.length >= 3 && day.startsWith(word.replace(/s$/, "").slice(0, 9)));
}

function monthIndex(word: string): number {
  // "oct", "october", "sept"
  return word.length >= 3 ? MONTHS.findIndex((month) => month.startsWith(word)) : -1;
}

// "oct 20", "20 october", "october 20th" → the next such date (this year, or
// next year once it has passed).
function monthDay(text: string, todayISO: string): string | null {
  const match =
    text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/) ??
    text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/);
  if (!match) return null;
  const [monthWord, dayText] = /^\d/.test(match[1]) ? [match[2], match[1]] : [match[1], match[2]];
  const month = monthIndex(monthWord);
  const day = Number(dayText);
  if (month < 0 || day < 1 || day > 31) return null;
  let year = Number(todayISO.slice(0, 4));
  const iso = (y: number) => `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (iso(year) < todayISO) year += 1;
  const candidate = iso(year);
  // Reject Feb 30 and friends (Date rolls them over).
  return new Date(`${candidate}T12:00:00Z`).toISOString().slice(0, 10) === candidate ? candidate : null;
}

function dayOfWeek(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** Returns YYYY-MM-DD, the input itself if it already is one, or null. */
export function resolveRelativeDay(phrase: string, todayISO: string): string | null {
  const text = phrase.trim().toLowerCase().replace(/[.,!?]/g, "").replace(/^(on|by|until|till)\s+/, "");
  if (ISO_RE.test(text)) return text;
  if (!ISO_RE.test(todayISO)) return null;

  if (text === "today" || text === "tonight") return todayISO;
  if (text === "tomorrow" || text === "tmrw" || text === "tmr") return addDaysISO(todayISO, 1);
  if (text === "day after tomorrow" || text === "the day after tomorrow") return addDaysISO(todayISO, 2);
  if (text === "next week" || text === "in a week") return addDaysISO(todayISO, 7);

  const inN = text.match(/^in\s+(\d+|[a-z]+)\s+(day|days|week|weeks)$/);
  if (inN) {
    const n = /^\d+$/.test(inN[1]) ? Number(inN[1]) : WORD_NUMBERS[inN[1]];
    if (!n || n > 365) return null;
    return addDaysISO(todayISO, inN[2].startsWith("week") ? n * 7 : n);
  }

  const dated = monthDay(text, todayISO);
  if (dated) return dated;

  const weekday = text.match(/^(this|next|coming|this coming)?\s*([a-z]+)$/);
  if (weekday) {
    const target = weekdayIndex(weekday[2]);
    if (target < 0) return null;
    const qualifier = weekday[1] ?? "";
    const today = dayOfWeek(todayISO);
    let ahead = (target - today + 7) % 7;
    if (ahead === 0 && qualifier !== "this") ahead = 7;
    if (qualifier === "next") {
      // Days left in this Mon–Sun week (Sunday ends it).
      const leftThisWeek = (7 - today) % 7;
      if (ahead <= leftThisWeek) ahead += 7;
    }
    return addDaysISO(todayISO, ahead);
  }
  return null;
}
