// Ranking v2 signals — pure, deterministic, shared by importance (scoring.ts),
// start priority (planner.ts) and the chat snapshot. Spec: docs/ranking.md.
//
// Everything here is computed from rows the callers already load (nodes +
// edges + a few feedback events); no I/O, no model calls. Tunables live in
// RANKING (src/lib/ai/config.ts).

import { RANKING } from "@/lib/ai/config";
import { formatShortDate } from "./short-date";

export { formatShortDate };

export type StakesLevel = "low" | "normal" | "high";

export interface RankNode {
  id: string;
  node_type: string;
  status: string | null;
  created_at: string;
  title?: string | null;
  target_date?: string | null;
  stakes?: number | null;
  waiting_for?: string | null;
  resume_on?: string | null;
  reading_order?: number | null;
}

export interface RankEdge {
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
}

export interface SteerEvent {
  event_type: string;
  entity_id: string;
  created_at?: string | null;
}

export type HoldState = "none" | "self" | "check_back" | "ancestor";

export interface DeadlineInfo {
  /** The deadline that applies (own, inherited from an ancestor, or from a dated node this is required for). */
  date: string;
  /** The node that owns the date. */
  ownerId: string;
  inherited: boolean;
  /** Whole days from today to the date; negative when overdue. */
  daysLeft: number;
  /** Estimated work sessions still open under the deadline's owner. */
  sessionsLeft: number;
  /** 0–100, stakes applied. */
  pressure: number;
}

// Types that never carry or inherit a deadline: habits run on cadence, areas
// have no finish line, notes/ideas aren't work.
const DEADLINE_FREE_TYPES = new Set(["habit", "area", "note", "idea"]);
// Types whose own open work counts toward a deadline's sessions-left.
const WORK_TYPES = new Set(["task", "big_task"]);
const PREREQUISITE_EDGE_TYPES = new Set(["prerequisite_for", "required_for"]);

const DAY_MS = 86_400_000;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function isOpen(status: string | null | undefined): boolean {
  return (status ?? "active") === "active";
}

function isLive(status: string | null | undefined): boolean {
  const s = status ?? "active";
  return s !== "completed" && s !== "archived";
}

/** Whole days from `fromISO` to `toISO` (both YYYY-MM-DD, or ISO timestamps — only the date part is used). */
export function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

export function stakesLevel(value: number | null | undefined): StakesLevel {
  if (value === 1) return "high";
  if (value === -1) return "low";
  return "normal";
}

export function stakesValue(level: StakesLevel): number | null {
  if (level === "high") return 1;
  if (level === "low") return -1;
  return null;
}

/**
 * Deadline pressure, 0–100. Lead-time aware: what matters is slack — days left
 * minus the days of work still open — not the raw date. A 10-minute task due in
 * 3 days is calm; an exam in 7 days with 12 sessions of prep is already urgent.
 */
export function deadlinePressure(params: {
  daysLeft: number;
  sessionsLeft: number;
  stakes: StakesLevel;
}): number {
  const { daysLeft, sessionsLeft, stakes } = params;
  const horizon = RANKING.PRESSURE_HORIZON_DAYS * RANKING.STAKES_HORIZON_FACTOR[stakes];
  let base: number;
  if (daysLeft < 0) {
    // Overdue: full pressure just past the date, then fade so a stale date
    // doesn't shout forever — Focus asks "done, moved or dropped?" instead.
    const overdueDays = -daysLeft;
    base =
      overdueDays <= RANKING.OVERDUE_GRACE_DAYS
        ? 100
        : Math.max(
            RANKING.OVERDUE_FLOOR,
            100 - RANKING.OVERDUE_FADE_PER_DAY * (overdueDays - RANKING.OVERDUE_GRACE_DAYS),
          );
  } else {
    const slack = daysLeft - sessionsLeft / RANKING.SESSIONS_PER_DAY;
    base = 100 * clamp((horizon - slack) / horizon, 0, 1);
  }
  return clamp(base * RANKING.STAKES_PRESSURE_FACTOR[stakes], 0, 100);
}

/**
 * Net steering from "focus on X" (boost_node) and "X can wait" (demote_node)
 * events, each decaying with a 7-day half-life. Positive = pushed up.
 */
export function steerFromEvents(events: SteerEvent[], nowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const ev of events) {
    const sign = ev.event_type === "boost_node" ? 1 : ev.event_type === "demote_node" ? -1 : 0;
    if (sign === 0 || !ev.created_at) continue;
    const ageDays = Math.max(0, (nowMs - Date.parse(ev.created_at)) / DAY_MS);
    const weight = Math.pow(0.5, ageDays / RANKING.STEER_HALF_LIFE_DAYS);
    out.set(ev.entity_id, (out.get(ev.entity_id) ?? 0) + sign * weight);
  }
  for (const [id, v] of out) out.set(id, clamp(v, -RANKING.STEER_CAP, RANKING.STEER_CAP));
  return out;
}

export interface RankingContext {
  byId: Map<string, RankNode>;
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  today: string;
  /** Ancestors nearest-first (bounded by MAX_INHERIT_DEPTH, cycle-safe). */
  ancestors(nodeId: string): RankNode[];
  deadline(nodeId: string): DeadlineInfo | null;
  stakes(nodeId: string): StakesLevel;
  steer(nodeId: string): number;
  hold(nodeId: string): HoldState;
  /** The node on hold that puts `nodeId` on hold (itself or an ancestor). */
  holdingNode(nodeId: string): RankNode | null;
}

/**
 * Builds the lookups every signal needs once per recompute. `edges` should
 * already exclude orphaned / rejected edges.
 */
export function createRankingContext(params: {
  nodes: RankNode[];
  edges: RankEdge[];
  today: string;
  steerEvents?: SteerEvent[];
  nowMs?: number;
}): RankingContext {
  const { nodes, edges, today } = params;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const requiredFor = new Map<string, string[]>();

  const link = (child: string, parent: string) => {
    if (child === parent || parentOf.has(child)) return;
    if (!byId.has(child) || !byId.has(parent)) return;
    parentOf.set(child, parent);
    const kids = childrenOf.get(parent) ?? [];
    kids.push(child);
    childrenOf.set(parent, kids);
  };

  for (const e of edges) {
    if (e.edge_type === "belongs_to") link(e.source_node_id, e.target_node_id);
    else if (e.edge_type === "contains") link(e.target_node_id, e.source_node_id);
    else if (PREREQUISITE_EDGE_TYPES.has(e.edge_type)) {
      const list = requiredFor.get(e.source_node_id) ?? [];
      list.push(e.target_node_id);
      requiredFor.set(e.source_node_id, list);
    }
  }

  const ownSteer = steerFromEvents(params.steerEvents ?? [], params.nowMs ?? Date.now());

  const ancestors = (nodeId: string): RankNode[] => {
    const out: RankNode[] = [];
    const seen = new Set<string>([nodeId]);
    let cur = parentOf.get(nodeId);
    while (cur && !seen.has(cur) && out.length < RANKING.MAX_INHERIT_DEPTH) {
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      out.push(node);
      cur = parentOf.get(cur);
    }
    return out;
  };

  const stakes = (nodeId: string): StakesLevel => {
    const own = byId.get(nodeId);
    if (own && own.stakes != null) return stakesLevel(own.stakes);
    for (const a of ancestors(nodeId)) {
      if (a.stakes != null) return stakesLevel(a.stakes);
    }
    return "normal";
  };

  // Sessions of open work under a deadline's owner. Held (paused) subtrees
  // don't count — that work is parked.
  const sessionsCache = new Map<string, number>();
  const sessionsLeft = (ownerId: string): number => {
    const cached = sessionsCache.get(ownerId);
    if (cached !== undefined) return cached;
    const owner = byId.get(ownerId);
    let total = 0;
    const stack = [...(childrenOf.get(ownerId) ?? [])];
    const seen = new Set<string>([ownerId]);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (!n || !isOpen(n.status)) continue;
      const kids = childrenOf.get(id) ?? [];
      const hasOpenWorkKid = kids.some((k) => {
        const kn = byId.get(k);
        return !!kn && isOpen(kn.status) && WORK_TYPES.has(kn.node_type);
      });
      if (n.node_type === "task") total += RANKING.SESSIONS_TASK;
      else if (n.node_type === "big_task" && !hasOpenWorkKid) total += RANKING.SESSIONS_BIG_TASK;
      stack.push(...kids);
    }
    if (total === 0 && owner) {
      if (owner.node_type === "task") total = RANKING.SESSIONS_TASK;
      else if (owner.node_type === "big_task") total = RANKING.SESSIONS_BIG_TASK;
      else total = RANKING.SESSIONS_UNKNOWN_OWNER;
    }
    const capped = Math.min(RANKING.SESSIONS_CAP, total);
    sessionsCache.set(ownerId, capped);
    return capped;
  };

  const deadlineCache = new Map<string, DeadlineInfo | null>();
  const deadline = (nodeId: string): DeadlineInfo | null => {
    if (deadlineCache.has(nodeId)) return deadlineCache.get(nodeId)!;
    const node = byId.get(nodeId);
    let result: DeadlineInfo | null = null;
    if (node && !DEADLINE_FREE_TYPES.has(node.node_type)) {
      let owner: RankNode | null = null;
      if (node.target_date) owner = node;
      if (!owner) {
        owner =
          ancestors(nodeId).find(
            (a) => !!a.target_date && !DEADLINE_FREE_TYPES.has(a.node_type) && isLive(a.status),
          ) ?? null;
      }
      if (!owner) {
        // "X is required for Y (due Friday)" → X is due by Friday too. One hop.
        const dated = (requiredFor.get(nodeId) ?? [])
          .map((id) => byId.get(id))
          .filter((t): t is RankNode => !!t && !!t.target_date && isLive(t.status))
          .sort((a, b) => a.target_date!.localeCompare(b.target_date!));
        owner = dated[0] ?? null;
      }
      if (owner && owner.target_date) {
        const level = stakes(nodeId);
        const daysLeft = daysBetween(today, owner.target_date);
        const left = sessionsLeft(owner.id);
        result = {
          date: owner.target_date,
          ownerId: owner.id,
          inherited: owner.id !== nodeId,
          daysLeft,
          sessionsLeft: left,
          pressure: deadlinePressure({ daysLeft, sessionsLeft: left, stakes: level }),
        };
      }
    }
    deadlineCache.set(nodeId, result);
    return result;
  };

  const steer = (nodeId: string): number => {
    const own = ownSteer.get(nodeId) ?? 0;
    // "Focus on the Stats final" boosts the steps you actually start.
    const inherited = ancestors(nodeId).find((a) => (ownSteer.get(a.id) ?? 0) !== 0);
    const fromParent = inherited ? (ownSteer.get(inherited.id) ?? 0) * RANKING.STEER_INHERIT_FACTOR : 0;
    return clamp(own + fromParent, -RANKING.STEER_CAP, RANKING.STEER_CAP);
  };

  const holdingNode = (nodeId: string): RankNode | null => {
    const node = byId.get(nodeId);
    if (node?.status === "paused") return node;
    return ancestors(nodeId).find((a) => a.status === "paused") ?? null;
  };

  const hold = (nodeId: string): HoldState => {
    const node = byId.get(nodeId);
    if (node?.status === "paused") {
      return node.resume_on && node.resume_on.slice(0, 10) <= today ? "check_back" : "self";
    }
    return ancestors(nodeId).some((a) => a.status === "paused") ? "ancestor" : "none";
  };

  return { byId, parentOf, childrenOf, today, ancestors, deadline, stakes, steer, hold, holdingNode };
}

export function holdFactor(state: HoldState): number {
  switch (state) {
    case "self":
      return RANKING.HOLD_SELF_FACTOR;
    case "check_back":
      return RANKING.HOLD_CHECK_BACK_FACTOR;
    case "ancestor":
      return RANKING.HOLD_ANCESTOR_FACTOR;
    default:
      return 1;
  }
}

export function relativeDue(daysLeft: number): string {
  if (daysLeft < 0) return `overdue by ${-daysLeft} day${daysLeft === -1 ? "" : "s"}`;
  if (daysLeft === 0) return "due today";
  if (daysLeft === 1) return "due tomorrow";
  return `due in ${daysLeft} days`;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// Pressure below this is background — not worth naming in a reason.
const REASON_PRESSURE_MIN = 35;
const REASON_STEER_MIN = 0.3;

/**
 * One short, deterministic sentence for "why is this this size / this high?".
 * Null when nothing notable applies (callers fall back to the AI judgment's
 * reason). Order = what the user most needs to know first.
 */
export function rankingReason(ctx: RankingContext, nodeId: string): string | null {
  const node = ctx.byId.get(nodeId);
  if (!node || node.status === "completed" || node.status === "archived") return null;
  const parts: string[] = [];

  const state = ctx.hold(nodeId);
  if (state === "self" || state === "check_back") {
    const what = node.waiting_for ? `Waiting for ${node.waiting_for}` : "Paused";
    if (state === "check_back") parts.push(`${what} — time to check back`);
    else if (node.resume_on) parts.push(`${what} — check back ${formatShortDate(node.resume_on)}`);
    else parts.push(what);
    return parts[0];
  }
  if (state === "ancestor") {
    const holder = ctx.holdingNode(nodeId);
    return holder?.title ? `On hold with "${holder.title}"` : "Its parent is on hold";
  }

  const dl = ctx.deadline(nodeId);
  if (dl && dl.pressure >= REASON_PRESSURE_MIN) {
    const due = relativeDue(dl.daysLeft);
    if (dl.daysLeft < 0) {
      parts.push(`${capitalize(due)} — done, moved or dropped?`);
    } else {
      const owner = dl.inherited ? ctx.byId.get(dl.ownerId)?.title : null;
      const head = owner ? `"${owner}" ${due}` : capitalize(due);
      parts.push(`${head} — about ${dl.sessionsLeft} session${dl.sessionsLeft === 1 ? "" : "s"} left`);
    }
  }

  const steer = ctx.steer(nodeId);
  if (steer >= REASON_STEER_MIN) parts.push("You asked to focus on this");
  else if (steer <= -REASON_STEER_MIN) parts.push("You said this can wait");

  const level = ctx.stakes(nodeId);
  if (level === "high") parts.push("High stakes");
  else if (level === "low") parts.push("Low stakes");

  return parts.length > 0 ? parts.slice(0, 2).join(" · ") : null;
}
