// "Safe to ignore today" — what Focus and a day plan leave out, and why it's
// fine to (owner 10-06: "BrainDump tells you the one thing, what you're
// allowed to ignore, and why"). Deterministic: every line is a fact the
// ranking already knows (a hold, a far deadline, yesterday's work, the user's
// own "it can wait"), so it costs nothing and never invents a reason. A node
// with no clear reason gets no line.
//
// buildSetAside() runs inside buildPlannerCandidates (it has the signals);
// setAsideFor() drops whatever the plan / Focus did pick and keeps a few.

import { formatShortDate } from "@/lib/graph/short-date";
import type { RankingContext } from "@/lib/graph/priority-signals";

export type SetAsideKind = "waiting" | "can_wait" | "later" | "worked" | "blocked" | "habit_met" | "low_stakes";

/** One reason, before the picks are known. */
export interface SetAsideItem {
  /** The node the line names (a deadline's owner, a project, the node itself). */
  id: string;
  title: string;
  reason: string;
  kind: SetAsideKind;
  /** The node and every open node under it — a pick among them drops the line. */
  node_ids: string[];
  importance: number;
}

/** What Focus / the Planner show. */
export interface SetAsideLine {
  id: string;
  title: string;
  reason: string;
  kind: SetAsideKind;
}

// Order = how much relief the line gives ("nothing to do until the result").
const KIND_ORDER: SetAsideKind[] = ["waiting", "later", "worked", "can_wait", "blocked", "habit_met", "low_stakes"];
/** At most this many lines of one kind, so three holds don't hide the rest. */
const PER_KIND = 2;
export const SET_ASIDE_FOCUS_MAX = 3;
export const SET_ASIDE_PLAN_MAX = 4;

/** A deadline this far out with low pressure is "plenty of time". */
export const LATER_MIN_DAYS = 7;
export const LATER_MAX_PRESSURE = 20;
/** Yesterday's work rests today only below this pressure (momentum takes over above it). */
export const WORKED_MAX_PRESSURE = 40;

export interface SetAsideNode {
  id: string;
  title: string;
  node_type: string;
  status: string | null;
  current_importance_score: number | null;
  waiting_for: string | null;
  resume_on: string | null;
  habit_target_per_week: number | null;
}

export function buildSetAside(params: {
  /** Active and paused nodes of the workspace. */
  nodes: SetAsideNode[];
  ctx: RankingContext;
  /** Not a candidate for a line at all: structure/knowledge types, done today, stale (asked about elsewhere). */
  skip: (nodeId: string) => boolean;
  /** The project the node is a step of (its parent unless that's an area), else itself. */
  clusterOf: (nodeId: string) => string;
  /** When this node / cluster last got work: "today", "yesterday" or null. */
  workedOn: (key: string) => "today" | "yesterday" | null;
  /** Titles of open prerequisites / blockers. */
  waitsOn: (nodeId: string) => string[];
  /** Distinct days a habit was done this week. */
  habitDoneThisWeek: (nodeId: string) => number;
}): SetAsideItem[] {
  const { ctx } = params;
  const byId = new Map(params.nodes.map((node) => [node.id, node]));
  const isOpen = (id: string) => {
    const status = byId.get(id)?.status ?? null;
    return byId.has(id) && (status === null || status === "active" || status === "paused");
  };
  const under = (rootId: string): string[] => {
    const out = [rootId];
    const seen = new Set(out);
    for (let i = 0; i < out.length && out.length < 200; i += 1) {
      for (const kid of ctx.childrenOf.get(out[i]) ?? []) {
        if (seen.has(kid) || !isOpen(kid)) continue;
        seen.add(kid);
        out.push(kid);
      }
    }
    return out;
  };
  const importance = (id: string) => byId.get(id)?.current_importance_score ?? 0;

  const items = new Map<string, SetAsideItem>();
  const add = (kind: SetAsideKind, ownerId: string, reason: string) => {
    const owner = byId.get(ownerId);
    if (!owner || items.has(ownerId)) return;
    items.set(ownerId, {
      id: ownerId,
      title: owner.title,
      reason,
      kind,
      node_ids: under(ownerId),
      importance: importance(ownerId),
    });
  };

  // Holds first: the node the user is waiting on (not what's parked under it,
  // and not one whose check-back day came — that's a question in Focus).
  for (const node of params.nodes) {
    if (node.status !== "paused" || ctx.hold(node.id) !== "self") continue;
    const what = node.waiting_for ? `Waiting for ${node.waiting_for}` : "On hold";
    add(
      "waiting",
      node.id,
      node.resume_on ? `${what} — nothing to do until ${formatShortDate(node.resume_on)}` : what,
    );
  }

  // The farthest ancestor (or the node) that carries a signal — that's where
  // the user said it, so the line names it once for everything under it.
  const sourceOf = (nodeId: string, has: (id: string) => boolean): string => {
    let source = nodeId;
    for (const ancestor of ctx.ancestors(nodeId)) {
      if (!isOpen(ancestor.id) || !has(ancestor.id)) break;
      source = ancestor.id;
    }
    return source;
  };

  for (const node of params.nodes) {
    if ((node.status ?? "active") !== "active" || params.skip(node.id)) continue;
    if (ctx.hold(node.id) !== "none") continue;

    if (ctx.steer(node.id) <= -0.3) {
      add("can_wait", sourceOf(node.id, (id) => ctx.steer(id) <= -0.3), "You said it can wait");
      continue;
    }

    const waits = params.waitsOn(node.id);
    if (waits.length > 0) {
      add("blocked", node.id, `Can't start until "${waits[0]}" is done`);
      continue;
    }

    const deadline = ctx.deadline(node.id);
    const pressure = deadline?.pressure ?? 0;
    if (deadline && deadline.daysLeft >= LATER_MIN_DAYS && pressure < LATER_MAX_PRESSURE) {
      add("later", deadline.ownerId, `Not due until ${formatShortDate(deadline.date)} — plenty of time`);
      continue;
    }

    if (pressure < WORKED_MAX_PRESSURE) {
      const cluster = params.clusterOf(node.id);
      const when = params.workedOn(cluster);
      if (when) {
        add(
          "worked",
          cluster,
          when === "today" ? "You already put time into it today" : "You worked on it yesterday — fine to rest it today",
        );
        continue;
      }
    }

    if (node.node_type === "habit" && node.habit_target_per_week && node.habit_target_per_week < 7) {
      const done = params.habitDoneThisWeek(node.id);
      if (done >= node.habit_target_per_week) {
        add("habit_met", node.id, `Done ${done}/${node.habit_target_per_week} this week already`);
        continue;
      }
    }

    if (ctx.stakes(node.id) === "low" && pressure < WORKED_MAX_PRESSURE) {
      add("low_stakes", sourceOf(node.id, (id) => ctx.stakes(id) === "low"), "Low stakes — it can slide a day");
    }
  }

  return [...items.values()];
}

/**
 * The lines to show next to what was picked: none that names or contains a
 * pick, in relief order (most important first within a kind), at most
 * PER_KIND of a kind and `max` in all.
 */
export function setAsideFor(items: SetAsideItem[], picked: Iterable<string>, max: number): SetAsideLine[] {
  const chosen = new Set(picked);
  const perKind = new Map<SetAsideKind, number>();
  const lines: SetAsideLine[] = [];
  const sorted = items
    .filter((item) => !item.node_ids.some((id) => chosen.has(id)))
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        b.importance - a.importance ||
        a.title.localeCompare(b.title),
    );
  for (const item of sorted) {
    if (lines.length >= max) break;
    const count = perKind.get(item.kind) ?? 0;
    if (count >= PER_KIND) continue;
    perKind.set(item.kind, count + 1);
    lines.push({ id: item.id, title: item.title, reason: item.reason, kind: item.kind });
  }
  return lines;
}

/** For a chat plan message: `"Italian" (not due until Nov 2) and "CV" (waiting for a reply)`. */
export function describeSetAside(lines: SetAsideLine[]): string | null {
  if (lines.length === 0) return null;
  const parts = lines.map((line) => {
    const why = line.reason.split(" — ")[0];
    return `"${line.title}" (${why.charAt(0).toLowerCase()}${why.slice(1)})`;
  });
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Every node a plan covers: its blocks' nodes, and the steps inside a block on a bigger thing. */
export function plannedIds(
  blocks: Array<{ node_id: string | null }>,
  timeBlocks: Array<{ id: string; step_ids: string[] }>,
): string[] {
  const stepsOf = new Map(timeBlocks.map((block) => [block.id, block.step_ids]));
  return blocks.flatMap((block) => (block.node_id ? [block.node_id, ...(stepsOf.get(block.node_id) ?? [])] : []));
}
