// A plan that leaves out work due in a day or two says so (owner 10-06: "if
// the AI thinks my plan is bad it should say: you have this due — focus on
// that instead?"). Deterministic: the planner's deadlines against the blocks
// the model returned; no extra model call. Chat's plan message ends "want me
// to build around it?" (a reply to a question reaches the model with tools,
// so "yes" re-plans), the Planner shows a "Build around it" button — both plan
// again with it as a request, so it's guaranteed in (validation.ts withRequests).

import { relativeDue } from "@/lib/graph/priority-signals";

/** A dated node due soon and the open nodes whose deadline it is. */
export interface DueSoonItem {
  /** The node that owns the date. */
  id: string;
  title: string;
  /** Whole days from today; negative when overdue. */
  days_left: number;
  /** The owner and every open node under its deadline — a block on any covers it. */
  node_ids: string[];
}

export interface LeftOutDue {
  id: string;
  title: string;
  /** "due tomorrow", "overdue by 2 days". */
  label: string;
}

/** Due within this many days of the planned day counts. */
export const DUE_NUDGE_DAYS = 2;
/** Overdue longer than this is a "done, moved or dropped?" question, not a plan nudge. */
export const DUE_NUDGE_OVERDUE_DAYS = 7;
/** Named at most — one line in chat, not a list. */
const MAX_LEFT_OUT = 2;

function daysFrom(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

/**
 * What's due soon and has no block in the plan. A block covers an item when
 * its node is the item's owner or one of its open nodes, or a time block that
 * contains one of them. On a later day (`planDate` after `today`) only what is
 * still due on or after that day counts.
 */
export function dueLeftOut(params: {
  dueSoon: DueSoonItem[];
  blocks: { node_id: string | null }[];
  timeBlocks?: { id: string; step_ids: string[] }[];
  today: string;
  planDate?: string;
}): LeftOutDue[] {
  const ahead = params.planDate ? Math.max(0, daysFrom(params.today, params.planDate)) : 0;
  const stepsOf = new Map((params.timeBlocks ?? []).map((t) => [t.id, t.step_ids]));
  const planned = new Set<string>();
  for (const block of params.blocks) {
    if (!block.node_id) continue;
    planned.add(block.node_id);
    for (const id of stepsOf.get(block.node_id) ?? []) planned.add(id);
  }
  return params.dueSoon
    .filter((item) => {
      const fromPlanDay = item.days_left - ahead;
      if (fromPlanDay > DUE_NUDGE_DAYS || item.days_left < -DUE_NUDGE_OVERDUE_DAYS) return false;
      if (ahead > 0 && fromPlanDay < 0) return false;
      return !planned.has(item.id) && !item.node_ids.some((id) => planned.has(id));
    })
    .sort((a, b) => a.days_left - b.days_left || a.title.localeCompare(b.title))
    .slice(0, MAX_LEFT_OUT)
    .map((item) => ({ id: item.id, title: item.title, label: relativeDue(item.days_left) }));
}

/** `"Stats exam" (due tomorrow) and "CV" (due today)` — for a tool result. */
export function describeLeftOut(items: LeftOutDue[]): string | null {
  if (items.length === 0) return null;
  return items.map((item) => `"${item.title}" (${item.label})`).join(" and ");
}

/** The plan message's last line: `"Stats exam" is due tomorrow and isn't in it — want me to build around it?` */
export function leftOutQuestion(items: LeftOutDue[]): string | null {
  if (items.length === 0) return null;
  if (items.length === 1) {
    const [item] = items;
    return `"${item.title}" is ${item.label} and isn't in it — want me to build around it?`;
  }
  return `${describeLeftOut(items)} aren't in it — want me to build around them?`;
}
