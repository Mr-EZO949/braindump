// One message, every intent (#22, 2026-10-05) — the server's check that a
// chat turn's tool calls cover everything the user STATED.
//
// "Did the gym. Also the CV update can wait till next week, should I focus on
// stats or the internship?" — in 2 of 4 runs (assistant-v29, real route) Haiku
// logged the gym and answered the question but made no update_priorities call
// for the CV at all. Nothing dropped it: the call was never made, and the card
// for the gym ended the turn.
//
// The check: split the message into clauses (advice-guard.ts), find the kinds
// of thing each STATED clause says (done, can wait, focus, stakes, a date, add,
// move, plan, a weekly time…), and count them against what the calls carry.
// When a kind comes up short, the route asks the model ONCE for only the
// missing calls (the calls it made are held, not run), folds them into its
// first response and runs the whole set as one turn — one card, one Undo. A
// false alarm costs one short round (~$0.002) and no change: the model may
// answer with no call. Questions ("should I drop X?") never count: advice
// stays advice.

import { CHANGE_KINDS } from "@/lib/graph/change-set";
import { messageClauses } from "./advice-guard";

export type IntentKind =
  | "complete"
  | "deprioritize"
  | "focus"
  | "stakes"
  | "drop"
  | "deadline"
  | "wait"
  | "add"
  | "move"
  | "rename"
  | "plan"
  | "commitment"
  | "link"
  | "archive"
  | "merge";

const DAY = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE = new RegExp(
  `\\b(?:${DAY}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|tomorrow|next (?:week|month)|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2})\\b`,
  "i",
);
const CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}(?::\d{2})?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\b|\bat \d{1,2}\b/i;
// "I should finish X", "didn't do it", "planning to" — not done.
const NOT_DONE = /\b(didn'?t|did not|haven'?t|have not|not (yet )?(done|finished)|should|planning to|plan to|going to|gonna|need to|have to|want to|wanna|will)\b/i;
const CANT_FOCUS = /\b(can'?t|cannot|can not|hard to|unable to|trouble) focus/i;

type Detector = (clause: string) => boolean;

const DETECTORS: Record<IntentKind, Detector> = {
  complete: (c) =>
    /\b(did|done|finished|completed|went (to|for)|shipped|submitted|handed in|turned in|wrapped up|checked off|finally \w+ed)\b/i.test(c) &&
    !NOT_DONE.test(c),
  deprioritize: (c) =>
    /\b(can wait|could wait|wait (till|until)|not (now|urgent|a priority)|less important|deprioriti\w*|back ?burner|on hold|put (it |that |\w+ )?off|push(ed|ing)? (it |that )?back|postpon\w*)\b/i.test(c),
  focus: (c) => /\b(focus(ing)? on|my focus is|prioriti[sz]\w*|top priority|main thing|most important|all in on|matters? more|more important than)\b/i.test(c) && !CANT_FOCUS.test(c),
  stakes: (c) =>
    /\b(need (it|this|that|the [\w' -]{1,40}?) for (my|the|a|an)\b|rides on|depends on it|pass\/fail|barely counts|high stakes|low stakes|big deal)/i.test(c),
  drop: (c) =>
    /\b(not doing|cancel(l?ed|ling|ing)?|giving up on|gave up on|quit(ting)?|dropp(ed|ing)|scrap(ped|ping)?|no longer (doing|need|want)|abandon\w*)\b|^(also,? |and )?drop\b/i.test(c),
  deadline: (c) => /\b(due|deadline|moved|pushed|postponed|rescheduled|is (on|at)|got moved)\b/i.test(c) && DATE.test(c),
  wait: (c) => /\b(waiting (on|for|to hear)|wait(ing)? to hear back)\b/i.test(c),
  add: (c) =>
    /^(?:(?:also|and|ok|okay|pls|please)[,\s]+)*(add|create|track|capture)\b|\b(add|create) (a|an|another|new|the|task|node|it|that|this|to)\b|\bremind me to\b/i.test(c),
  move: (c) =>
    /\bmove\b[^.?!]*\b(under|into|to|in)\b|\b(belongs?|goes|should go) (under|in|into)\b|\bis part of\b|\bits own (project|area|big task)\b/i.test(c),
  rename: (c) => /\brename\b/i.test(c),
  plan: (c) =>
    /\bplan (my|the|out|today|tomorrow|this)\b|\bmake (me )?a (schedule|plan)\b|\btime-?block\b|\bschedule my (day|afternoon|morning|evening|week)\b/i.test(c),
  commitment: (c) =>
    (new RegExp(`\\bevery (?:day|weekday|morning|evening|week|${DAY})\\b|\\b${DAY} and ${DAY}\\b`, "i").test(c)) && CLOCK.test(c),
  link: (c) => /\b(connect|link|unlink)\b|\b(aren'?t|not) related\b|\bremove (the|that) link\b/i.test(c),
  archive: (c) => /\b(archive|delete|get rid of)\b/i.test(c),
  merge: (c) => /\bmerge\b|\bis a duplicate\b/i.test(c),
};

// What each kind of statement is carried by: a change op's kind, an
// update_priorities action, or a tool's name.
const COVERED_BY: Record<IntentKind, string[]> = {
  complete: ["complete", "mark_task_done", "wait"],
  // Not archive / drop: "the BrainDump fixes can wait" came back as an
  // archive op once (eval) — a can-wait is not a goodbye.
  deprioritize: ["deprioritize", "wait", "deadline"],
  focus: ["focus", "stakes"],
  stakes: ["stakes"],
  drop: ["drop", "archive", "delete_node"],
  // Not add_task_to_calendar: "the midterm is on oct 20, and I need to book a
  // room" put the room on the calendar and left the midterm undated (eval).
  deadline: ["deadline", "reschedule_task", "set_commitments"],
  wait: ["wait"],
  add: ["create_node", "write_steps", "add_task_to_calendar", "set_commitments"],
  move: ["move", "reschedule_task", "deadline"],
  rename: ["update"],
  plan: ["plan_day"],
  commitment: ["set_commitments", "create_node", "add_task_to_calendar"],
  link: ["create_edge", "remove_edge"],
  archive: ["archive", "delete_node", "remove_edge", "drop", "merge"],
  merge: ["merge"],
};

// build_graph carries any change to the graph's contents; ask_choice is the
// model asking first, which the prompt allows for anything.
const BUILD_COVERS = new Set<IntentKind>(["complete", "add", "move", "rename", "link", "archive", "merge", "deadline"]);

const HINT: Record<IntentKind, string> = {
  complete: "done → change complete",
  deprioritize: "can wait → update_priorities deprioritize",
  focus: "their focus → update_priorities focus",
  stakes: "what rides on it → update_priorities stakes",
  drop: "not doing it → update_priorities drop",
  deadline: "a date → update_priorities deadline",
  wait: "waiting on a result → update_priorities wait",
  add: "a new item → change create_node",
  move: "a move → change move",
  rename: "a rename → change update",
  plan: "a plan → plan_day",
  commitment: "a weekly busy time → set_commitments",
  link: "a link → change create_edge / remove_edge",
  archive: "archive / delete → change archive / delete_node",
  merge: "a duplicate → change merge",
};

// A question that is really a request: "can you add X?", "could you move it?".
const REQUEST = /^(?:(?:also|and|ok|okay)[,\s]+)?(can|could|will) you\b|^please\b/i;

export interface StatedIntent {
  kind: IntentKind;
  clause: string;
}

// The kinds of thing the user STATED, one entry per (clause, kind).
export function statedIntents(message: string): StatedIntent[] {
  const out: StatedIntent[] = [];
  for (const { text, asks } of messageClauses(message)) {
    if (asks && !REQUEST.test(text)) continue;
    for (const kind of Object.keys(DETECTORS) as IntentKind[]) {
      if (DETECTORS[kind](text)) out.push({ kind, clause: text });
    }
  }
  return out;
}

export interface ModelCall {
  name: string;
  input: unknown;
}

const CHANGE_OP_KINDS = new Set<string>(CHANGE_KINDS);

function rows(input: unknown): Array<Record<string, unknown>> {
  const changes = (input as { changes?: unknown } | null)?.changes;
  return Array.isArray(changes) ? changes.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
}

// What a turn's calls carry, as counts per op kind / action / tool name.
export function callCoverage(calls: ModelCall[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const call of calls) {
    if (call.name === "change") {
      for (const op of rows(call.input)) {
        if (typeof op.kind === "string") bump(op.kind);
        if (typeof op.target_date === "string" && op.target_date) bump("deadline");
      }
    } else if (CHANGE_OP_KINDS.has(call.name)) {
      bump(call.name);
    } else if (call.name === "update_priorities") {
      for (const row of rows(call.input)) if (typeof row.action === "string") bump(row.action);
    } else {
      bump(call.name);
    }
  }
  return counts;
}

// The stated intents the calls leave out, grouped per kind. A kind is short
// when fewer calls/ops carry it than stated clauses say it.
export function missingIntents(message: string, calls: ModelCall[]): StatedIntent[] {
  const stated = statedIntents(message);
  if (stated.length === 0) return [];
  const counts = callCoverage(calls);
  if (counts.has("ask_choice")) return [];
  const build = counts.has("build_graph");
  const missing: StatedIntent[] = [];
  const kinds = [...new Set(stated.map((s) => s.kind))];
  for (const kind of kinds) {
    if (build && BUILD_COVERS.has(kind)) continue;
    const needed = stated.filter((s) => s.kind === kind);
    const have = COVERED_BY[kind].reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);
    if (have < needed.length) missing.push(...needed);
  }
  return missing;
}

// The note the model gets in place of its calls' results, asking for only the
// missing calls. Not the user's words — it says so.
export function coverageNudge(missing: StatedIntent[], hasCalls: boolean): string {
  const byClause = new Map<string, IntentKind[]>();
  for (const m of missing) byClause.set(m.clause, [...(byClause.get(m.clause) ?? []), m.kind]);
  const lines = [...byClause].map(([clause, kinds]) => `- "${clause}" (${kinds.map((k) => HINT[k]).join("; ")})`);
  return [
    `[BrainDump check — not from the user. ${hasCalls ? "Your calls are held, not run yet: they leave" : "Your reply makes no call, and leaves"} out part of what the user told you:`,
    ...lines,
    'Send ONLY the missing call(s) now — exact ids from the snapshot, source "user" (they stated it). No text: they already have your reply. If one of these isn\'t a change after all, leave it out; if none is, send no call.]',
  ].join("\n");
}

// A held call's placeholder result (every tool_use needs one before the
// model can be asked again).
export const HELD_RESULT = JSON.stringify({ held: "not run yet — see the check below" });

type ToolUseLike = { type: "tool_use"; id: string; name: string; input: unknown };

const rowKey = (row: Record<string, unknown>) =>
  JSON.stringify([row.kind ?? row.action ?? "", row.node_id ?? row.title ?? row.local_ref ?? "", row.new_parent_node_id ?? ""]);

// Folds the retry's calls into the first response's calls: a change or
// update_priorities call with the same source gains the new rows (one change
// call per turn, one card); rows and calls already there are dropped; anything
// else is appended. Returns the merged tool_use blocks, in order.
export function mergeRetryCalls<T extends ToolUseLike>(first: T[], retry: T[]): T[] {
  const merged = first.map((b) => ({ ...b, input: cloneInput(b.input) }));
  for (const call of retry) {
    if (call.name === "change" || call.name === "update_priorities") {
      const source = (call.input as { source?: unknown } | null)?.source;
      const target = merged.find((b) => b.name === call.name && (b.input as { source?: unknown } | null)?.source === source);
      // Across both tools: the gym "complete" sent as a change op first came
      // back as an update_priorities row in the retry — shown twice (e2e).
      const have = new Set(merged.flatMap(rowKeys));
      const fresh = rows(call.input).filter((r) => !have.has(rowKey(r)));
      if (fresh.length === 0) continue;
      if (target) {
        const input = target.input as { changes: unknown[] };
        input.changes = [...rows(input), ...fresh];
      } else {
        merged.push({ ...call, input: { ...(call.input as object), changes: fresh } });
      }
      continue;
    }
    if (merged.some((b) => b.name === call.name && JSON.stringify(b.input) === JSON.stringify(call.input))) continue;
    merged.push(call);
  }
  return merged;
}

function rowKeys(block: ToolUseLike): string[] {
  if (block.name === "change" || block.name === "update_priorities") return rows(block.input).map(rowKey);
  // An op or action called as a tool of its own.
  return [rowKey({ ...(block.input as Record<string, unknown>), kind: block.name })];
}

function cloneInput(input: unknown): unknown {
  return input && typeof input === "object" ? JSON.parse(JSON.stringify(input)) : input;
}

// A change op called as a tool without a source ("complete" with a node id):
// the user's when the message states that kind of thing, else a suggestion.
export function statedOpSource(message: string | undefined, opKind: string): "user" | "suggestion" {
  if (!message) return "suggestion";
  return statedIntents(message).some((s) => COVERED_BY[s.kind].includes(opKind)) ? "user" : "suggestion";
}
