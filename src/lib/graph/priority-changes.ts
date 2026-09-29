// Chat → priorities (docs/ranking.md, "Chat → priorities"). Pure validation and
// wording for the update_priorities tool — shared by the server handler
// (src/lib/ai/tools/priority-mutations.ts) and the chat confirmation card.

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

/** Validates the tool input. Returns the changes, or the first problem found. */
export function parsePriorityChanges(
  input: unknown,
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
        const checkBack = str(row.check_back_on);
        if (checkBack && !DATE_RE.test(checkBack)) {
          return { ok: false, error: `${at}.check_back_on must be YYYY-MM-DD` };
        }
        changes.push({ action, node_id, title, waiting_for, check_back_on: checkBack || null, reason });
        break;
      }
      case "deadline": {
        const date = str(row.target_date);
        if (date && !DATE_RE.test(date)) {
          return { ok: false, error: `${at}.target_date must be YYYY-MM-DD (or empty to clear)` };
        }
        changes.push({ action, node_id, title, target_date: date || null, reason });
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
