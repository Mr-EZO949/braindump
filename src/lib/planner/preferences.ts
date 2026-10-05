// Standing preferences (docs/preferences.md) — how the user wants to spend
// their time, said once and kept: "4h a day coding", "2h of Italian on
// weekdays", "no work after 10pm", "I'm sharpest 9–12", "gym in the mornings".
//
// Not busy time (that's fixed commitments, lib/planner/commitments.ts) and not
// graph nodes. Kept per user in Supabase auth user_metadata — no table, no
// migration (like the auto-add switch) — and read by the chat snapshot, the
// planner (budgets → "fit this in" requests, working hours → where a day plan
// ends) and Focus (a budget not started today leans its work forward).
//
// Pure: validation for the set_preferences tool and the dump read, the list
// edit + its Undo snapshot, and the words every surface shows. Shared by the
// server and the browser. Storage: preference-store.ts (server only).

import { formatRequestMinutes, matchRequest, parsePlanRequests, type RequestableNode } from "./plan-requests";
import { describeDays, isoWeekday, minutesToTime, timeToMinutes } from "./commitments";
import { parseClock, parseDays } from "./commitment-changes";

export const PREFERENCE_KINDS = ["budget", "hours", "peak", "rule"] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];
export const PARTS_OF_DAY = ["morning", "afternoon", "evening"] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];
export const PREFERENCE_ACTIONS = ["add", "update", "remove"] as const;
export type PreferenceAction = (typeof PREFERENCE_ACTIONS)[number];

/**
 * - budget: time on something per day or week ("Coding", 240, per day).
 * - hours: when work happens at all — start_time = not before, end_time =
 *   no work after. One per user.
 * - peak: their best focus hours (start–end). One per user.
 * - rule: anything else they want kept, in their words ("Gym in the mornings").
 */
export interface Preference {
  id: string;
  kind: PreferenceKind;
  title: string;
  minutes: number | null;
  per: "day" | "week" | null;
  days: number[];
  node_id: string | null;
  start_time: string | null;
  end_time: string | null;
  part_of_day: PartOfDay | null;
}

export type PreferenceFields = Omit<Preference, "id">;

export type PreferenceChange =
  | { action: "add"; fields: PreferenceFields }
  | { action: "update"; preference_id: string; patch: Partial<PreferenceFields> }
  | { action: "remove"; preference_id: string };

/** The auth user_metadata key the list lives under. */
export const PREFERENCES_METADATA_KEY = "standing_preferences";
// user_metadata rides in the session cookie and the JWT — keep it small.
export const MAX_PREFERENCES = 12;
const MAX_CHANGES = 8;
const MAX_TITLE = 80;
const MAX_DAY_MINUTES = 16 * 60;
const MAX_WEEK_MINUTES = 80 * 60;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[0-9a-z-]{6,40}$/i;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Words that say how, not what ("4h of deep work on coding" is about coding).
const FILLER_WORDS = new Set([
  "the", "and", "for", "with", "time", "work", "working", "deep", "session", "sessions",
  "practice", "practise", "study", "studying", "daily", "day", "week", "hours", "hour", "on", "of", "my",
]);

function topicWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/)
    .filter((w) => w.length >= 2 && !FILLER_WORDS.has(w));
}

/** Two names for the same activity: a shared topic word ("coding" ~ "Coding project", "stats" ~ "statistics"). */
export function sameTopic(a: string, b: string): boolean {
  const wa = topicWords(a);
  const wb = topicWords(b);
  if (wa.length === 0 || wb.length === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const close = (x: string, y: string) => {
    if (x === y) return true;
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
    return i >= 4;
  };
  return wa.some((x) => wb.some((y) => close(x, y)));
}

function minutesFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = str(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  // "4h", "1h 30m", "90 min" — the plan request parser reads lengths.
  const parsed = parsePlanRequests(`${text} x`)[0];
  return parsed?.minutes ?? null;
}

// ── Stored rows ─────────────────────────────────────────────────────────────

/** A stored (or undo-snapshot) row → a clean Preference, or null. */
export function normalizePreference(raw: unknown): Preference | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = str(row.id);
  const kind = PREFERENCE_KINDS.find((k) => k === row.kind);
  if (!ID_RE.test(id) || !kind) return null;
  const title = str(row.title).slice(0, MAX_TITLE);
  const days = Array.isArray(row.days) ? row.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
  const minutes = typeof row.minutes === "number" && Number.isFinite(row.minutes) ? Math.round(row.minutes) : null;
  const per = row.per === "week" ? "week" : row.per === "day" ? "day" : null;
  const start = timeToMinutes(str(row.start_time));
  const end = timeToMinutes(str(row.end_time));
  const nodeId = str(row.node_id);
  const pref: Preference = {
    id,
    kind,
    title,
    minutes,
    per,
    days: days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : ALL_DAYS,
    node_id: UUID_RE.test(nodeId) ? nodeId : null,
    start_time: start === null ? null : minutesToTime(start),
    end_time: end === null ? null : minutesToTime(end),
    part_of_day: PARTS_OF_DAY.find((p) => p === row.part_of_day) ?? null,
  };
  return isComplete(pref) ? pref : null;
}

function isComplete(p: PreferenceFields): boolean {
  const start = timeToMinutes(p.start_time);
  const end = timeToMinutes(p.end_time);
  switch (p.kind) {
    case "budget":
      return Boolean(p.title) && p.minutes !== null && p.minutes >= 5 && p.minutes <= (p.per === "week" ? MAX_WEEK_MINUTES : MAX_DAY_MINUTES);
    case "hours":
      return (start !== null || end !== null) && (start === null || end === null || end > start);
    case "peak":
      return start !== null && end !== null && end > start;
    case "rule":
      return Boolean(p.title);
  }
}

/** The user's list from auth user_metadata (bad rows dropped). */
export function preferencesFromMetadata(metadata: Record<string, unknown> | null | undefined): Preference[] {
  const raw = metadata?.[PREFERENCES_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .map(normalizePreference)
    .filter((p): p is Preference => {
      if (!p || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    })
    .slice(0, MAX_PREFERENCES);
}

// ── Words ───────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<Exclude<PreferenceKind, "budget" | "rule">, string> = {
  hours: "Working hours",
  peak: "Best focus hours",
};

/** The name a card / the settings list shows: "Coding", "Working hours". */
export function preferenceLabel(p: Pick<Preference, "kind" | "title">): string {
  return p.kind === "budget" || p.kind === "rule" ? p.title : KIND_LABEL[p.kind];
}

function daysSuffix(days: number[]): string {
  return days.length === 7 ? "" : ` · ${describeDays(days)}`;
}

/** A budget's amount: "4h a day", "10h a week". */
export function formatBudget(p: Pick<Preference, "minutes" | "per">): string {
  return `${formatRequestMinutes(p.minutes ?? 0)} a ${p.per === "week" ? "week" : "day"}`;
}

/** "4h a day", "2h a day · Mon–Fri · mornings", "No work after 22:00". */
export function describePreference(p: PreferenceFields): string {
  const part = p.part_of_day ? ` · ${p.part_of_day}s` : "";
  switch (p.kind) {
    case "budget":
      return `${formatBudget(p)}${daysSuffix(p.days)}${part}`;
    case "hours":
      return p.start_time && p.end_time
        ? `${p.start_time}–${p.end_time}`
        : p.end_time
          ? `No work after ${p.end_time}`
          : `Not before ${p.start_time}`;
    case "peak":
      return `${p.start_time}–${p.end_time}`;
    case "rule":
      return `${p.days.length === 7 ? "Standing rule" : describeDays(p.days)}${part}`;
  }
}

// Byte-stable order for the chat snapshot (assistant-cache.ts): kind, then id.
function stableOrder(prefs: Preference[]): Preference[] {
  const rank = (k: PreferenceKind) => PREFERENCE_KINDS.indexOf(k);
  return [...prefs].sort((a, b) => rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id));
}

/** The chat snapshot block, or null with none saved. */
export function preferencesSnapshotBlock(prefs: Preference[]): string | null {
  if (prefs.length === 0) return null;
  const lines = stableOrder(prefs).map(
    (p) => `- ${preferenceLabel(p)}: ${describePreference(p)}${p.node_id ? ` (node ${p.node_id})` : ""} — id: ${p.id}`,
  );
  return `[STANDING PREFERENCES — how they want to spend their time]\n${lines.join("\n")}`;
}

// ── Planning ────────────────────────────────────────────────────────────────

/** A budget's minutes on one date (a weekly one spread over its days), or null. */
export function budgetMinutesOn(p: Preference, dateISO: string): number | null {
  if (p.kind !== "budget" || p.minutes === null || !p.days.includes(isoWeekday(dateISO))) return null;
  if (p.per !== "week") return p.minutes;
  return Math.max(15, Math.round(p.minutes / p.days.length / 15) * 15);
}

/** Where a day plan must end ("no work after 22:00"), in minutes, or null. */
export function workdayEndMinute(prefs: Preference[]): number | null {
  const hours = prefs.find((p) => p.kind === "hours");
  return timeToMinutes(hours?.end_time ?? null);
}

/** A plan this long gets the day's budgets as requests; a 1–2 h session is for what matters most now. */
export const BUDGET_MIN_SESSION_MINUTES = 4 * 60;

/** A day's budget as a plan request ("Coding — your 4h a day"). */
export interface BudgetRequest {
  text: string;
  /** What it's about, for matching a node by its words ("coding"). */
  phrase: string;
  minutes: number;
  node_id: string | null;
}

/**
 * The day's budgets as plan requests. What the user typed into the plan
 * request wins: a budget for something they already named is left out. All
 * budgets together get at most 60% of the session — the rest is for deadlines
 * and everything else — scaled down in 15-minute steps; under 30 min is
 * dropped.
 */
export function budgetRequestsFor(params: {
  prefs: Preference[];
  dateISO: string;
  sessionMinutes: number;
  include?: string | null;
}): BudgetRequest[] {
  const asked = parsePlanRequests(params.include).map((r) => r.phrase);
  const budgets = params.prefs.flatMap((p) => {
    const minutes = budgetMinutesOn(p, params.dateISO);
    if (minutes === null) return [];
    const phrase = parsePlanRequests(`1h of ${p.title}`)[0]?.phrase ?? p.title.toLowerCase();
    if (asked.some((a) => sameTopic(a, phrase))) return [];
    return [{ p, phrase, minutes }];
  });
  const cap = Math.floor(params.sessionMinutes * 0.6);
  const total = budgets.reduce((sum, b) => sum + b.minutes, 0);
  const scale = total > cap ? cap / total : 1;
  return budgets.flatMap(({ p, phrase, minutes }) => {
    const fitted = Math.floor((minutes * scale) / 15) * 15;
    if (fitted < 30) return [];
    return [{ text: `${p.title} — your ${formatBudget(p)}`, phrase, minutes: fitted, node_id: p.node_id }];
  });
}

/**
 * Focus's lean: today's budgets on something nothing inside was finished on
 * today → { node id → the signal line }. The budget's linked node, else the
 * node its name matches (areas too — "Coding" is often one).
 */
export function budgetsBehindToday(params: {
  prefs: Preference[];
  dateISO: string;
  nodes: RequestableNode[];
  workedToday: (nodeId: string) => boolean;
}): Map<string, string> {
  const behind = new Map<string, string>();
  for (const p of params.prefs) {
    if (budgetMinutesOn(p, params.dateISO) === null) continue;
    const target =
      (p.node_id ? params.nodes.find((n) => n.id === p.node_id) : undefined) ?? matchRequest(p.title, params.nodes);
    if (!target || params.workedToday(target.id) || behind.has(target.id)) continue;
    behind.set(target.id, `Your ${formatBudget(p)} on ${p.title} — not started today`);
  }
  return behind;
}

/**
 * Lines for the plan model's context: what a schedule can't express as a
 * request — best hours, working hours, standing rules, a budget's time of day.
 */
export function planningPreferenceLines(prefs: Preference[], dateISO: string): string[] {
  const weekday = isoWeekday(dateISO);
  return stableOrder(prefs).flatMap((p) => {
    if (!p.days.includes(weekday)) return [];
    if (p.kind === "peak") return [`Sharpest ${p.start_time}–${p.end_time}: put the hardest deep work there.`];
    if (p.kind === "hours") return [`${describePreference(p)}.`];
    if (p.kind === "rule") return [`${p.title}${p.part_of_day ? ` (${p.part_of_day}s)` : ""}.`];
    return p.part_of_day ? [`${p.title} in the ${p.part_of_day}.`] : [];
  });
}

// ── Changes (set_preferences, the dump read) ────────────────────────────────

function fieldsFrom(
  row: Record<string, unknown>,
  at: string,
): { ok: true; fields: Partial<PreferenceFields> } | { ok: false; error: string } {
  const fields: Partial<PreferenceFields> = {};
  const kind = str(row.kind);
  if (kind) {
    const known = PREFERENCE_KINDS.find((k) => k === kind);
    if (!known) return { ok: false, error: `${at}.kind must be budget, hours, peak or rule` };
    fields.kind = known;
  }
  // "coding" → "Coding": it's a label on cards and in settings.
  const title = str(row.title).slice(0, MAX_TITLE);
  if (title) fields.title = title.charAt(0).toUpperCase() + title.slice(1);
  if (row.minutes !== undefined && row.minutes !== null && row.minutes !== "") {
    const minutes = minutesFrom(row.minutes);
    if (minutes === null || minutes < 5) return { ok: false, error: `${at}.minutes must be a number of minutes (4h = 240)` };
    fields.minutes = minutes;
  }
  if (row.per !== undefined && row.per !== null && row.per !== "") {
    if (row.per !== "day" && row.per !== "week") return { ok: false, error: `${at}.per must be day or week` };
    fields.per = row.per;
  }
  if (row.days !== undefined && row.days !== null) {
    const days = parseDays(row.days);
    if (!days) return { ok: false, error: `${at}.days must be weekdays like ["mon","wed"]` };
    fields.days = days;
  }
  if ("node_id" in row) {
    const nodeId = str(row.node_id);
    if (nodeId && !UUID_RE.test(nodeId)) return { ok: false, error: `${at}.node_id must be a node's UUID` };
    fields.node_id = nodeId || null;
  }
  for (const [key, column] of [
    ["from", "start_time"],
    ["until", "end_time"],
  ] as const) {
    const raw = str(row[key]);
    if (!raw) continue;
    const clock = parseClock(raw);
    if (!clock) return { ok: false, error: `${at}.${key} must be a time like "22:00"` };
    fields[column] = clock;
  }
  if (row.part_of_day !== undefined && row.part_of_day !== null && row.part_of_day !== "") {
    const part = PARTS_OF_DAY.find((p) => p === row.part_of_day);
    if (!part) return { ok: false, error: `${at}.part_of_day must be morning, afternoon or evening` };
    fields.part_of_day = part;
  }
  return { ok: true, fields };
}

const REQUIRED: Record<PreferenceKind, string> = {
  budget: "a budget needs title and minutes",
  hours: "hours needs from and/or until",
  peak: "peak needs from and until",
  rule: "a rule needs title (the rule in their words)",
};

// The one this add is really about: the same budget (same node or the same
// activity by name), the single hours / peak row, or the same rule.
function sameAs(fields: PreferenceFields, existing: Preference[]): Preference | null {
  return (
    existing.find((p) => {
      if (p.kind !== fields.kind) return false;
      if (p.kind === "hours" || p.kind === "peak") return true;
      if (p.kind === "budget") {
        if (p.node_id && fields.node_id) return p.node_id === fields.node_id;
        return sameTopic(p.title, fields.title);
      }
      return p.title.toLowerCase() === fields.title.toLowerCase();
    }) ?? null
  );
}

function withPatch(base: Preference, patch: Partial<PreferenceFields>): Preference {
  return { ...base, ...patch, kind: base.kind };
}

function patchFrom(base: Preference, fields: Partial<PreferenceFields>): Partial<PreferenceFields> {
  const patch: Partial<PreferenceFields> = {};
  for (const key of Object.keys(fields) as Array<keyof PreferenceFields>) {
    if (key === "kind") continue;
    if (JSON.stringify(fields[key]) !== JSON.stringify(base[key])) {
      (patch as Record<string, unknown>)[key] = fields[key];
    }
  }
  return patch;
}

/**
 * Validates set_preferences input against the user's list. An "add" for
 * something already saved (the same budget, the hours, the best hours, the
 * same rule) becomes an update of it — "make it 3h" must never leave two
 * coding budgets (the lesson from commitments' add-vs-update guard).
 */
export function parsePreferenceChanges(
  input: unknown,
  existing: Preference[],
): { ok: true; changes: PreferenceChange[] } | { ok: false; error: string } {
  const raw = (input as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "changes must be a non-empty array" };
  if (raw.length > MAX_CHANGES) return { ok: false, error: `at most ${MAX_CHANGES} changes per call` };
  const byId = new Map(existing.map((p) => [p.id, p]));
  const touched = new Set<string>();
  const changes: PreferenceChange[] = [];
  let count = existing.length;

  for (const [index, item] of raw.entries()) {
    const at = `changes[${index}]`;
    const row = (item ?? {}) as Record<string, unknown>;
    const action = PREFERENCE_ACTIONS.find((a) => a === str(row.action));
    if (!action) return { ok: false, error: `${at}.action must be add, update or remove` };
    const parsed = fieldsFrom(row, at);
    if (!parsed.ok) return parsed;

    if (action === "add") {
      const kind = parsed.fields.kind;
      if (!kind) return { ok: false, error: `${at}.kind is required` };
      const fields: PreferenceFields = {
        kind,
        title: parsed.fields.title ?? "",
        minutes: kind === "budget" ? (parsed.fields.minutes ?? null) : null,
        per: kind === "budget" ? (parsed.fields.per ?? "day") : null,
        days: parsed.fields.days ?? ALL_DAYS,
        node_id: parsed.fields.node_id ?? null,
        start_time: kind === "hours" || kind === "peak" ? (parsed.fields.start_time ?? null) : null,
        end_time: kind === "hours" || kind === "peak" ? (parsed.fields.end_time ?? null) : null,
        part_of_day: kind === "budget" || kind === "rule" ? (parsed.fields.part_of_day ?? null) : null,
      };
      const current = sameAs(fields, existing);
      if (current) {
        if (touched.has(current.id)) return { ok: false, error: `${at} changes "${preferenceLabel(current)}" twice` };
        // Only what this message says changes: "make it 3h" keeps the saved
        // name, link, days and the other end of the working hours.
        const given: Partial<PreferenceFields> = { ...parsed.fields };
        delete given.title;
        if (!given.node_id) delete given.node_id;
        const patch = patchFrom(current, given);
        touched.add(current.id);
        if (Object.keys(patch).length === 0) continue;
        if (!isComplete(withPatch(current, patch))) return { ok: false, error: `${at}: ${REQUIRED[kind]}` };
        changes.push({ action: "update", preference_id: current.id, patch });
        continue;
      }
      if (!isComplete(fields)) return { ok: false, error: `${at}: ${REQUIRED[kind]}` };
      count += 1;
      if (count > MAX_PREFERENCES) {
        return { ok: false, error: `at most ${MAX_PREFERENCES} standing preferences — ask which one to remove` };
      }
      changes.push({ action: "add", fields });
      continue;
    }

    const id = str(row.preference_id);
    const current = byId.get(id);
    if (!current) return { ok: false, error: `${at}.preference_id must be an id from [STANDING PREFERENCES]` };
    if (touched.has(id)) return { ok: false, error: `${at} changes the same preference twice` };
    touched.add(id);
    if (action === "remove") {
      changes.push({ action, preference_id: id });
      count -= 1;
      continue;
    }
    const patch = patchFrom(current, parsed.fields);
    if (Object.keys(patch).length === 0) continue;
    if (!isComplete(withPatch(current, patch))) return { ok: false, error: `${at}: ${REQUIRED[current.kind]}` };
    changes.push({ action, preference_id: id, patch });
  }
  if (changes.length === 0) return { ok: false, error: "already saved exactly like that — nothing to change" };
  return { ok: true, changes };
}

// ── Applying + Undo ─────────────────────────────────────────────────────────

export interface PreferenceUndo {
  /** Ids this change added: Undo removes them. */
  created: string[];
  /** The rows it changed or removed, as they were: Undo puts them back. */
  before: Preference[];
}

export interface AppliedPreference {
  action: PreferenceAction;
  preference: Preference;
}

/** The new list after `changes` (validated by parsePreferenceChanges). */
export function applyToList(
  list: Preference[],
  changes: PreferenceChange[],
  newId: () => string,
): { next: Preference[]; applied: AppliedPreference[]; undo: PreferenceUndo } {
  let next = [...list];
  const applied: AppliedPreference[] = [];
  const undo: PreferenceUndo = { created: [], before: [] };
  for (const change of changes) {
    if (change.action === "add") {
      const preference = { id: newId(), ...change.fields };
      next.push(preference);
      undo.created.push(preference.id);
      applied.push({ action: "add", preference });
      continue;
    }
    const current = next.find((p) => p.id === change.preference_id);
    if (!current) continue;
    undo.before.push(current);
    if (change.action === "remove") {
      next = next.filter((p) => p.id !== current.id);
      applied.push({ action: "remove", preference: current });
      continue;
    }
    const updated = withPatch(current, change.patch);
    next = next.map((p) => (p.id === current.id ? updated : p));
    applied.push({ action: "update", preference: updated });
  }
  return { next, applied, undo };
}

/** Puts back exactly what applyToList changed; later edits to other rows stay. */
export function undoOnList(list: Preference[], undo: PreferenceUndo): Preference[] {
  const created = new Set(undo.created);
  let next = list.filter((p) => !created.has(p.id));
  for (const before of undo.before) {
    next = next.some((p) => p.id === before.id) ? next.map((p) => (p.id === before.id ? before : p)) : [...next, before];
  }
  return next.slice(0, MAX_PREFERENCES);
}

export function parsePreferenceUndo(input: unknown): { ok: true; undo: PreferenceUndo } | { ok: false; error: string } {
  const raw = (input ?? {}) as { created?: unknown; before?: unknown };
  const created = Array.isArray(raw.created) ? raw.created : [];
  const before = Array.isArray(raw.before) ? raw.before : [];
  if (created.length === 0 && before.length === 0) return { ok: false, error: "nothing to undo" };
  if (created.length > MAX_CHANGES || before.length > MAX_CHANGES) return { ok: false, error: "undo snapshot too large" };
  if (!created.every((id) => typeof id === "string" && ID_RE.test(id))) return { ok: false, error: "bad preference id" };
  const rows = before.map(normalizePreference);
  if (rows.some((r) => r === null)) return { ok: false, error: "bad preference in undo" };
  return { ok: true, undo: { created: created as string[], before: rows as Preference[] } };
}

/** A suggested set_preferences row in words, for the "Suggested" card. */
export function describeSuggestedPreference(row: Record<string, unknown>): string {
  const verb = row.action === "remove" ? "Forget" : row.action === "update" ? "Change" : "Keep";
  const parsed = fieldsFrom(row, "row");
  const f = parsed.ok ? parsed.fields : {};
  const kind = f.kind ?? "rule";
  const fields: PreferenceFields = {
    kind,
    title: f.title ?? "",
    minutes: f.minutes ?? null,
    per: f.per ?? "day",
    days: f.days ?? ALL_DAYS,
    node_id: null,
    start_time: f.start_time ?? null,
    end_time: f.end_time ?? null,
    part_of_day: f.part_of_day ?? null,
  };
  if (row.action === "remove" || !isComplete(fields)) return `${verb} ${f.title ?? "a preference"}`;
  return `${verb}: ${preferenceLabel(fields)} — ${describePreference(fields)}`;
}

export const PREFERENCE_ACTION_GLYPH: Record<PreferenceAction, string> = {
  add: "+",
  update: "◷",
  remove: "−",
};
