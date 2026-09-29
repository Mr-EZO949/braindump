// Chat → priorities (docs/ranking.md, "Chat → priorities"). Pure validation and
// wording for the update_priorities tool — shared by the server handler
// (src/lib/ai/tools/priority-mutations.ts) and the chat confirmation card.

import { resolveRelativeDay } from "@/lib/time/relative-day";
import type { StakesLevel } from "./priority-signals";
import { formatShortDate } from "./short-date";

export const PRIORITY_ACTIONS = [
  "focus",
  "deprioritize",
  "stakes",
  "wait",
  "resume",
  "deadline",
  "complete",
  "drop",
] as const;

export type PriorityAction = (typeof PRIORITY_ACTIONS)[number];

export type PriorityChange =
  | { action: "focus" | "deprioritize" | "resume" | "complete" | "drop"; node_id: string; title: string; reason?: string }
  | { action: "stakes"; node_id: string; title: string; stakes: StakesLevel; reason?: string }
  | {
      action: "wait";
      node_id: string;
      title: string;
      waiting_for: string;
      check_back_on: string | null;
      reason?: string;
    }
  | { action: "deadline"; node_id: string; title: string; target_date: string | null; reason?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_ACTIONS = new Set<PriorityAction>(["wait", "resume", "complete", "drop"]);
const MAX_CHANGES = 12;
const MAX_WAITING_FOR = 80;
const MAX_REASON = 120;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// A date field: YYYY-MM-DD, or the user's words ("friday", "next tuesday",
// "in 3 days") resolved against `today`. "" → null (clear / none). The
// model's verbatim `date_words`, when they resolve, beat a date it computed:
// Haiku got "this Friday" wrong in 2 of 3 runs (assistant-v21 eval).
function dateField(value: unknown, today: string | undefined, words?: unknown): string | null | undefined {
  const said = str(words);
  const fromWords = said && today ? resolveRelativeDay(said, today) : null;
  if (fromWords) return fromWords;
  const text = str(value);
  if (!text) return null;
  if (DATE_RE.test(text)) return text;
  return (today && resolveRelativeDay(text, today)) || undefined;
}

/**
 * Validates the tool input. Returns the changes, or the first problem found.
 * With `today`, relative days in date fields resolve deterministically.
 */
export function parsePriorityChanges(
  input: unknown,
  options: { today?: string } = {},
): { ok: true; changes: PriorityChange[] } | { ok: false; error: string } {
  const raw = (input as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "changes must be a non-empty array" };
  }
  if (raw.length > MAX_CHANGES) {
    return { ok: false, error: `at most ${MAX_CHANGES} changes per call` };
  }
  const changes: PriorityChange[] = [];
  const seen = new Set<string>();
  // One status move per node — "wait" and "complete" on the same node conflict.
  const statusMoved = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const at = `changes[${index}]`;
    const row = (item ?? {}) as Record<string, unknown>;
    const action = str(row.action) as PriorityAction;
    const node_id = str(row.node_id);
    const title = str(row.title).slice(0, 120) || "this node";
    const reason = str(row.reason).slice(0, MAX_REASON) || undefined;
    if (!PRIORITY_ACTIONS.includes(action)) {
      return { ok: false, error: `${at}.action must be one of ${PRIORITY_ACTIONS.join(", ")}` };
    }
    if (!node_id) return { ok: false, error: `${at}.node_id is required` };
    if (seen.has(`${node_id}:${action}`)) {
      return { ok: false, error: `${at} repeats ${action} for the same node` };
    }
    seen.add(`${node_id}:${action}`);
    if (STATUS_ACTIONS.has(action)) {
      if (statusMoved.has(node_id)) {
        return { ok: false, error: `${at} gives the same node two status changes` };
      }
      statusMoved.add(node_id);
    }

    switch (action) {
      case "stakes": {
        const stakes = str(row.stakes);
        if (stakes !== "high" && stakes !== "normal" && stakes !== "low") {
          return { ok: false, error: `${at}.stakes must be high, normal or low` };
        }
        changes.push({ action, node_id, title, stakes, reason });
        break;
      }
      case "wait": {
        const waiting_for = str(row.waiting_for).slice(0, MAX_WAITING_FOR) || "an update";
        const checkBack = dateField(row.check_back_on, options.today, row.date_words);
        if (checkBack === undefined) {
          return { ok: false, error: `${at}.check_back_on must be YYYY-MM-DD or a day like "friday"` };
        }
        changes.push({ action, node_id, title, waiting_for, check_back_on: checkBack, reason });
        break;
      }
      case "deadline": {
        const date = dateField(row.target_date, options.today, row.date_words);
        if (date === undefined) {
          return { ok: false, error: `${at}.target_date must be YYYY-MM-DD, a day like "friday", or empty to clear` };
        }
        changes.push({ action, node_id, title, target_date: date, reason });
        break;
      }
      default:
        changes.push({ action, node_id, title, reason });
    }
  }
  return { ok: true, changes };
}

/** Plain words for one change — the card line and the confirmation reply. */
export function describePriorityChange(change: PriorityChange): string {
  switch (change.action) {
    case "focus":
      return `Focus on ${change.title} this week`;
    case "deprioritize":
      return `${change.title} can wait`;
    case "stakes":
      return `${change.title}: ${change.stakes} stakes`;
    case "wait":
      return `${change.title}: waiting for ${change.waiting_for}${
        change.check_back_on ? ` — check back ${formatShortDate(change.check_back_on)}` : ""
      }`;
    case "resume":
      return `Pick ${change.title} back up`;
    case "deadline":
      return change.target_date
        ? `${change.title}: due ${formatShortDate(change.target_date)}`
        : `${change.title}: no deadline`;
    case "complete":
      return `Mark ${change.title} done`;
    case "drop":
      return `Drop ${change.title}`;
  }
}

export const PRIORITY_ACTION_GLYPH: Record<PriorityAction, string> = {
  focus: "↑",
  deprioritize: "↓",
  stakes: "!",
  wait: "⏸",
  resume: "▶",
  deadline: "◷",
  complete: "✓",
  drop: "⌫",
};

/**
 * The change as a state, for the applied card's second line (the title sits on
 * the first): "Waiting for exam result · check back Oct 15", "Due Oct 20".
 */
export function describePriorityDetail(change: PriorityChange): string {
  switch (change.action) {
    case "focus":
      return "Focus this week";
    case "deprioritize":
      return "Can wait";
    case "stakes":
      return change.stakes === "normal" ? "Normal stakes" : change.stakes === "high" ? "High stakes" : "Low stakes";
    case "wait":
      return `Waiting for ${change.waiting_for}${
        change.check_back_on ? ` · check back ${formatShortDate(change.check_back_on)}` : ""
      }`;
    case "resume":
      return "Back on";
    case "deadline":
      return change.target_date ? `Due ${formatShortDate(change.target_date)}` : "No deadline";
    case "complete":
      return "Done";
    case "drop":
      return "Dropped";
  }
}

// ── Undo ────────────────────────────────────────────────────────────────────
// update_priorities applies at once (no Accept card); the client keeps this
// snapshot and sends it back if the user taps Undo. Only the fields a change
// touched are recorded, so Undo never clobbers an unrelated later edit.

export type PriorityNodeStatus = "active" | "completed" | "paused" | "archived";

export interface PriorityNodeBefore {
  node_id: string;
  status?: PriorityNodeStatus;
  waiting_for?: string | null;
  resume_on?: string | null;
  stakes?: number | null;
  target_date?: string | null;
}

export interface PriorityUndo {
  nodes: PriorityNodeBefore[];
  /** Steering events the change logged; Undo logs the opposite to cancel them. */
  steer: { node_id: string; event_type: "boost_node" | "demote_node" }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_STATUSES = new Set<string>(["active", "completed", "paused", "archived"]);
const MAX_WAITING_FOR_STORED = 140;

function nullableDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && DATE_RE.test(value) ? value : undefined;
}

/**
 * Validates an Undo snapshot coming back from the browser. It only ever
 * restores the user's own nodes (the route scopes every write to them), but
 * the values still have to be ones the columns accept.
 */
export function parsePriorityUndo(
  input: unknown,
): { ok: true; undo: PriorityUndo } | { ok: false; error: string } {
  const raw = (input ?? {}) as { nodes?: unknown; steer?: unknown };
  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : [];
  const steerRaw = Array.isArray(raw.steer) ? raw.steer : [];
  if (nodesRaw.length === 0 && steerRaw.length === 0) return { ok: false, error: "nothing to undo" };
  if (nodesRaw.length > MAX_CHANGES || steerRaw.length > MAX_CHANGES) {
    return { ok: false, error: "undo snapshot too large" };
  }

  const nodes: PriorityNodeBefore[] = [];
  for (const item of nodesRaw) {
    const row = (item ?? {}) as Record<string, unknown>;
    if (typeof row.node_id !== "string" || !UUID_RE.test(row.node_id)) {
      return { ok: false, error: "bad node id" };
    }
    const before: PriorityNodeBefore = { node_id: row.node_id };
    if ("status" in row) {
      if (typeof row.status !== "string" || !NODE_STATUSES.has(row.status)) {
        return { ok: false, error: "bad status" };
      }
      before.status = row.status as PriorityNodeStatus;
    }
    if ("waiting_for" in row) {
      if (row.waiting_for !== null && typeof row.waiting_for !== "string") {
        return { ok: false, error: "bad waiting_for" };
      }
      before.waiting_for =
        typeof row.waiting_for === "string" ? row.waiting_for.slice(0, MAX_WAITING_FOR_STORED) : null;
    }
    for (const key of ["resume_on", "target_date"] as const) {
      if (!(key in row)) continue;
      const date = nullableDate(row[key]);
      if (date === undefined) return { ok: false, error: `bad ${key}` };
      before[key] = date;
    }
    if ("stakes" in row) {
      if (row.stakes !== null && row.stakes !== 1 && row.stakes !== -1) {
        return { ok: false, error: "bad stakes" };
      }
      before.stakes = row.stakes as number | null;
    }
    nodes.push(before);
  }

  const steer: PriorityUndo["steer"] = [];
  for (const item of steerRaw) {
    const row = (item ?? {}) as Record<string, unknown>;
    if (typeof row.node_id !== "string" || !UUID_RE.test(row.node_id)) {
      return { ok: false, error: "bad node id" };
    }
    if (row.event_type !== "boost_node" && row.event_type !== "demote_node") {
      return { ok: false, error: "bad steering event" };
    }
    steer.push({ node_id: row.node_id, event_type: row.event_type });
  }
  return { ok: true, undo: { nodes, steer } };
}
