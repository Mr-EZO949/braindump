// Chat/dump → fixed commitments (docs/commitments.md). Pure validation for the
// set_commitments tool and the dump read, plus the Undo snapshot — shared by
// the server handler (lib/ai/tools/commitment-mutations.ts) and the tests.
//
// The model copies the user's words for dates ("until dec 20", "from next
// monday") and the server resolves them (lib/time/relative-day.ts), like
// update_priorities' date_words: Haiku's own dates were wrong 7 of 9 times.

import { resolveRelativeDay } from "@/lib/time/relative-day";
import {
  DEFAULT_COMMITMENT_MINUTES,
  minutesToTime,
  timeToMinutes,
  type Commitment,
} from "./commitments";

export const COMMITMENT_ACTIONS = ["add", "update", "remove"] as const;
export type CommitmentAction = (typeof COMMITMENT_ACTIONS)[number];

export interface CommitmentFields {
  title: string;
  node_id: string | null;
  days: number[];
  start_time: string;
  end_time: string;
  starts_on: string | null;
  ends_on: string | null;
}

export type CommitmentChange =
  | { action: "add"; fields: CommitmentFields }
  | { action: "update"; commitment_id: string; patch: Partial<CommitmentFields> }
  | { action: "remove"; commitment_id: string };

const MAX_CHANGES = 8;
const MAX_TITLE = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "mon" / "Mondays" / 1 / "weekdays" / "every day" → ISO weekdays. */
export function parseDays(value: unknown): number[] | null {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,/&]|\band\b/) : [];
  const days = new Set<number>();
  for (const item of items) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 7) {
      days.add(item);
      continue;
    }
    const word = str(item).toLowerCase().replace(/[^a-z ]/g, "").trim();
    if (!word) continue;
    if (word === "weekdays" || word === "weekday") [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    else if (word === "weekends" || word === "weekend") [6, 7].forEach((d) => days.add(d));
    else if (word === "every day" || word === "everyday" || word === "daily") [1, 2, 3, 4, 5, 6, 7].forEach((d) => days.add(d));
    else {
      const stem = word.replace(/s$/, "");
      const index = stem.length >= 2 ? DAY_NAMES.findIndex((d) => d.startsWith(stem)) : -1;
      if (index < 0) return null;
      days.add(index + 1);
    }
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** "14:00", "2pm", "2:30 p.m.", "noon", "9" → "HH:MM". A bare 1–7 reads as afternoon. */
export function parseClock(value: unknown): string | null {
  const text = str(value).toLowerCase().replace(/\./g, "");
  if (!text) return null;
  if (text === "noon" || text === "midday") return "12:00";
  const asTime = timeToMinutes(text);
  if (asTime !== null) return minutesToTime(asTime);
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  if (minutes > 59) return null;
  if (match[3]) {
    if (hours < 1 || hours > 12) return null;
    if (match[3] === "pm" && hours !== 12) hours += 12;
    if (match[3] === "am" && hours === 12) hours = 0;
  } else if (hours >= 1 && hours <= 7) {
    hours += 12;
  }
  return hours <= 23 ? minutesToTime(hours * 60 + minutes) : null;
}

/**
 * A date bound from the user's words: "dec 20", "until friday", "for 6 weeks",
 * or YYYY-MM-DD. "" / "none" → null (no bound). Unresolvable → undefined.
 */
export function parseDateBound(value: unknown, today: string): string | null | undefined {
  const text = str(value).toLowerCase();
  if (!text || text === "none" || text === "no end" || text === "never") return null;
  if (DATE_RE.test(text)) return text;
  const words = text.replace(/^(until|till|til|through|thru|from|starting)\s+/, "").replace(/^for\s+/, "in ");
  return resolveRelativeDay(words, today) ?? undefined;
}

function fieldsFrom(
  row: Record<string, unknown>,
  at: string,
  today: string,
  base: CommitmentFields | null,
): { ok: true; fields: Partial<CommitmentFields> } | { ok: false; error: string } {
  const fields: Partial<CommitmentFields> = {};
  const title = str(row.title).slice(0, MAX_TITLE);
  if (title) fields.title = title;
  if ("node_id" in row) {
    const nodeId = str(row.node_id);
    if (nodeId && !UUID_RE.test(nodeId)) return { ok: false, error: `${at}.node_id must be a node's UUID` };
    fields.node_id = nodeId || null;
  }
  if ("days" in row && row.days !== undefined && row.days !== null) {
    const days = parseDays(row.days);
    if (!days) return { ok: false, error: `${at}.days must be weekdays like ["mon","wed"]` };
    fields.days = days;
  }
  const startRaw = str(row.start_time);
  const endRaw = str(row.end_time);
  if (startRaw) {
    const start = parseClock(startRaw);
    if (!start) return { ok: false, error: `${at}.start_time must be a time like "14:00"` };
    fields.start_time = start;
  }
  if (endRaw) {
    const end = parseClock(endRaw);
    if (!end) return { ok: false, error: `${at}.end_time must be a time like "15:30"` };
    fields.end_time = end;
  }
  // A new start with no end keeps the old length (or the default hour).
  if (fields.start_time && !fields.end_time) {
    const length =
      base && timeToMinutes(base.end_time)! > timeToMinutes(base.start_time)!
        ? timeToMinutes(base.end_time)! - timeToMinutes(base.start_time)!
        : DEFAULT_COMMITMENT_MINUTES;
    fields.end_time = minutesToTime(Math.min(timeToMinutes(fields.start_time)! + length, 24 * 60 - 1));
  }
  for (const [key, column] of [
    ["until", "ends_on"],
    ["from", "starts_on"],
  ] as const) {
    if (!(key in row) || row[key] === undefined) continue;
    const bound = parseDateBound(row[key], today);
    if (bound === undefined) {
      return { ok: false, error: `${at}.${key} "${str(row[key])}" isn't a date I can read — ask the user for the day` };
    }
    fields[column] = bound;
  }
  const start = timeToMinutes(fields.start_time ?? base?.start_time);
  const end = timeToMinutes(fields.end_time ?? base?.end_time);
  if (start !== null && end !== null && end <= start) {
    return { ok: false, error: `${at}.end_time must be after start_time` };
  }
  const startsOn = "starts_on" in fields ? fields.starts_on : base?.starts_on;
  const endsOn = "ends_on" in fields ? fields.ends_on : base?.ends_on;
  if (startsOn && endsOn && endsOn < startsOn) return { ok: false, error: `${at}: it ends before it starts` };
  return { ok: true, fields };
}

// Words that name the kind of slot, not the activity ("Stats lecture" and
// "Stats" are the same thing; "Volleyball practice" and "Stats lecture" aren't).
const GENERIC_WORDS = new Set([
  "the", "and", "for", "with", "class", "classes", "lecture", "lectures", "lesson", "lessons",
  "course", "seminar", "shift", "shifts", "practice", "session", "meeting", "weekly", "every",
]);

function activityWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-zà-ÿ0-9]+/)
      .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)),
  );
}

/** True unless the two titles clearly name different activities. */
export function sameActivity(a: string, b: string): boolean {
  const wordsA = activityWords(a);
  const wordsB = activityWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return true;
  return [...wordsA].some((w) => wordsB.has(w));
}

/**
 * Validates set_commitments input. `existing` are the user's commitments
 * (update/remove must name one of them). Returns the changes or the first
 * problem, worded for the model to fix or ask about.
 */
export function parseCommitmentChanges(
  input: unknown,
  options: { today: string; existing: Commitment[] },
): { ok: true; changes: CommitmentChange[] } | { ok: false; error: string } {
  const raw = (input as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "changes must be a non-empty array" };
  if (raw.length > MAX_CHANGES) return { ok: false, error: `at most ${MAX_CHANGES} changes per call` };
  const byId = new Map(options.existing.map((c) => [c.id, c]));
  const touched = new Set<string>();
  const changes: CommitmentChange[] = [];

  for (const [index, item] of raw.entries()) {
    const at = `changes[${index}]`;
    const row = (item ?? {}) as Record<string, unknown>;
    const action = str(row.action) as CommitmentAction;
    if (!COMMITMENT_ACTIONS.includes(action)) {
      return { ok: false, error: `${at}.action must be add, update or remove` };
    }

    if (action === "add") {
      const parsed = fieldsFrom(row, at, options.today, null);
      if (!parsed.ok) return parsed;
      const { fields } = parsed;
      if (!fields.title) return { ok: false, error: `${at}.title is required` };
      if (!fields.days) return { ok: false, error: `${at}.days is required` };
      if (!fields.start_time || !fields.end_time) return { ok: false, error: `${at}.start_time is required` };
      changes.push({
        action,
        fields: {
          title: fields.title,
          node_id: fields.node_id ?? null,
          days: fields.days,
          start_time: fields.start_time,
          end_time: fields.end_time,
          starts_on: fields.starts_on ?? null,
          ends_on: fields.ends_on ?? null,
        },
      });
      continue;
    }

    const id = str(row.commitment_id);
    const current = byId.get(id);
    if (!current) return { ok: false, error: `${at}.commitment_id must be one of the user's commitments` };

    // Haiku sometimes "updates" the one listed commitment to save a new one
    // (volleyball practice → Stats lecture, eval 2026-09-29). A new schedule
    // under an unrelated name is a new commitment: add it, leave the old one.
    const retitled = str(row.title);
    const reschedules = Boolean(row.days) || Boolean(str(row.start_time));
    if (action === "update" && retitled && reschedules && !sameActivity(retitled, current.title)) {
      const parsed = fieldsFrom(row, at, options.today, null);
      if (!parsed.ok) return parsed;
      const { fields } = parsed;
      if (!fields.days || !fields.start_time || !fields.end_time) {
        return { ok: false, error: `${at}: "${current.title}" isn't "${retitled}" — use add for a new commitment` };
      }
      changes.push({
        action: "add",
        fields: {
          title: fields.title ?? retitled,
          node_id: fields.node_id ?? null,
          days: fields.days,
          start_time: fields.start_time,
          end_time: fields.end_time,
          starts_on: fields.starts_on ?? null,
          ends_on: fields.ends_on ?? null,
        },
      });
      continue;
    }
    if (touched.has(id)) return { ok: false, error: `${at} changes the same commitment twice` };
    touched.add(id);
    if (action === "remove") {
      changes.push({ action, commitment_id: id });
      continue;
    }
    const parsed = fieldsFrom(row, at, options.today, current);
    if (!parsed.ok) return parsed;
    if (Object.keys(parsed.fields).length === 0) return { ok: false, error: `${at} changes nothing` };
    changes.push({ action, commitment_id: id, patch: parsed.fields });
  }
  return { ok: true, changes };
}

export const COMMITMENT_ACTION_GLYPH: Record<CommitmentAction, string> = {
  add: "+",
  update: "◷",
  remove: "−",
};

// ── Undo ────────────────────────────────────────────────────────────────────
// set_commitments applies at once; the browser keeps this snapshot and sends
// it back on Undo: delete what was added, put back what was changed/removed.

export interface CommitmentUndo {
  created: string[];
  before: Commitment[];
}

export function parseCommitmentUndo(
  input: unknown,
): { ok: true; undo: CommitmentUndo } | { ok: false; error: string } {
  const raw = (input ?? {}) as { created?: unknown; before?: unknown };
  const created = Array.isArray(raw.created) ? raw.created : [];
  const before = Array.isArray(raw.before) ? raw.before : [];
  if (created.length === 0 && before.length === 0) return { ok: false, error: "nothing to undo" };
  if (created.length > MAX_CHANGES || before.length > MAX_CHANGES) return { ok: false, error: "undo snapshot too large" };
  if (!created.every((id) => typeof id === "string" && UUID_RE.test(id))) return { ok: false, error: "bad commitment id" };

  const rows: Commitment[] = [];
  for (const item of before) {
    const row = (item ?? {}) as Record<string, unknown>;
    const id = str(row.id);
    const title = str(row.title).slice(0, MAX_TITLE);
    const days = parseDays(row.days);
    const start = timeToMinutes(str(row.start_time));
    const end = timeToMinutes(str(row.end_time));
    const nodeId = row.node_id === null ? null : str(row.node_id);
    const bound = (value: unknown) => (value === null ? null : DATE_RE.test(str(value)) ? str(value) : undefined);
    const startsOn = bound(row.starts_on);
    const endsOn = bound(row.ends_on);
    if (!UUID_RE.test(id) || !title || !days || start === null || end === null || end <= start) {
      return { ok: false, error: "bad commitment in undo" };
    }
    if ((nodeId !== null && !UUID_RE.test(nodeId)) || startsOn === undefined || endsOn === undefined) {
      return { ok: false, error: "bad commitment in undo" };
    }
    rows.push({
      id,
      title,
      node_id: nodeId,
      days,
      start_time: minutesToTime(start),
      end_time: minutesToTime(end),
      starts_on: startsOn,
      ends_on: endsOn,
    });
  }
  return { ok: true, undo: { created: created as string[], before: rows } };
}
