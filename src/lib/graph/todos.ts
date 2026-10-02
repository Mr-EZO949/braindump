// What the Todos view shows: open tasks and big tasks, arranged one of three
// ways. Pure — the component renders what this returns.
//
//   project  — sections per parent (project / goal / area), a big task's open
//              steps nested under it, sections ordered by their most pressing
//              item. The default: "what's on my plate, where does it live".
//   priority — one flat list in ranking order (the same score Focus uses).
//   due      — Overdue / Today / Tomorrow / Next 7 days / Later / No date.
//              A task with no date of its own inherits its nearest dated
//              parent's deadline (ranking does the same, docs/ranking.md).
//
// Paused and done work sit in their own sections at the bottom; archived work
// is not a todo (History holds it).

import type { GraphData, Node } from "@/types/graph";
import { addDaysISO } from "@/lib/time/local-date";

import { CHECKABLE_TYPES } from "./node-types";
import { buildPrimaryStructuralTree } from "./structure";

export type TodosGrouping = "project" | "priority" | "due";

export const TODOS_GROUPINGS: readonly TodosGrouping[] = ["project", "priority", "due"];

export type TodoDue = {
  date: string;
  // The dated ancestor the deadline comes from; null when it's the node's own.
  from: Node | null;
};

export type TodoItem = {
  node: Node;
  parent: Node | null;
  due: TodoDue | null;
  // Open steps nested under a big task (project grouping only).
  steps: TodoItem[];
};

export type TodoSectionKind = "parent" | "none" | "due" | "flat" | "search";

export type TodoSection = {
  key: string;
  kind: TodoSectionKind;
  title: string;
  // The project / goal / area a "parent" section stands for.
  parent: Node | null;
  items: TodoItem[];
  // Every item in the section, steps included.
  count: number;
  tone?: "overdue";
};

export type TodosModel = {
  sections: TodoSection[];
  paused: TodoItem[];
  done: TodoItem[];
  openCount: number;
  doneCount: number;
};

export type TodosOptions = {
  grouping: TodosGrouping;
  today: string;
  search?: string;
  // Just checked off in this view: keep them where they were for a moment
  // (rendered as done) instead of jumping to Done under the pointer.
  settling?: ReadonlySet<string>;
};

export function todoScore(node: Node): number {
  return node.current_importance_score ?? node.importance_index ?? 0;
}

function byScore(a: TodoItem, b: TodoItem): number {
  return todoScore(b.node) - todoScore(a.node) || a.node.title.localeCompare(b.node.title);
}

function countItems(items: TodoItem[]): number {
  return items.reduce((sum, item) => sum + 1 + countItems(item.steps), 0);
}

function topScore(items: TodoItem[]): number {
  let best = -Infinity;
  for (const item of items) {
    best = Math.max(best, todoScore(item.node), topScore(item.steps));
  }
  return best;
}

const DUE_BUCKETS = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Today" },
  { key: "tomorrow", title: "Tomorrow" },
  { key: "week", title: "Next 7 days" },
  { key: "later", title: "Later" },
  { key: "none", title: "No date" },
] as const;

function dueBucket(date: string | null, today: string): (typeof DUE_BUCKETS)[number]["key"] {
  if (!date) return "none";
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date === addDaysISO(today, 1)) return "tomorrow";
  if (date <= addDaysISO(today, 6)) return "week";
  return "later";
}

export function buildTodos(graph: GraphData, options: TodosOptions): TodosModel {
  const { grouping, today } = options;
  const settling = options.settling ?? new Set<string>();
  const query = (options.search ?? "").trim().toLowerCase();

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parentIdOf = new Map<string, string>();
  buildPrimaryStructuralTree(graph).parentCandidates.forEach((candidate, childId) => {
    parentIdOf.set(childId, candidate.parentId);
  });
  const parentOf = (node: Node): Node | null => byId.get(parentIdOf.get(node.id) ?? "") ?? null;

  const dueOf = (node: Node): TodoDue | null => {
    if (node.target_date) return { date: node.target_date, from: null };
    let current = parentOf(node);
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (current.target_date) return { date: current.target_date, from: current };
      current = parentOf(current);
    }
    return null;
  };

  const item = (node: Node): TodoItem => ({ node, parent: parentOf(node), due: dueOf(node), steps: [] });

  const isOpen = (node: Node) =>
    node.status === "active" || node.status == null || (node.status === "completed" && settling.has(node.id));

  const checkable = graph.nodes.filter((n) => CHECKABLE_TYPES.has(n.node_type));
  const open = checkable.filter(isOpen);
  const paused = checkable.filter((n) => n.status === "paused").map(item);
  const done = checkable.filter((n) => n.status === "completed" && !settling.has(n.id)).map(item);

  paused.sort(
    (a, b) =>
      (a.node.resume_on ?? "9999").localeCompare(b.node.resume_on ?? "9999") || byScore(a, b),
  );
  done.sort((a, b) =>
    (b.node.completed_at ?? b.node.updated_at ?? "").localeCompare(a.node.completed_at ?? a.node.updated_at ?? ""),
  );

  const counts = { openCount: open.length, doneCount: done.length };

  if (query) {
    const matches = (n: Node) => `${n.title} ${n.summary ?? ""}`.toLowerCase().includes(query);
    const items = [...open, ...checkable.filter((n) => n.status === "paused")]
      .filter(matches)
      .map(item)
      .sort(byScore);
    const found = [...items, ...done.filter((d) => matches(d.node))];
    return {
      sections: [
        {
          key: "search",
          kind: "search",
          title: found.length === 1 ? "1 match" : `${found.length} matches`,
          parent: null,
          items: found,
          count: found.length,
        },
      ],
      paused: [],
      done: [],
      ...counts,
    };
  }

  if (grouping === "priority") {
    const items = open.map(item).sort(byScore);
    return {
      sections: [{ key: "flat", kind: "flat", title: "By priority", parent: null, items, count: items.length }],
      paused,
      done,
      ...counts,
    };
  }

  if (grouping === "due") {
    const buckets = new Map<string, TodoItem[]>();
    for (const node of open) {
      const entry = item(node);
      const key = dueBucket(entry.due?.date ?? null, today);
      const list = buckets.get(key) ?? [];
      list.push(entry);
      buckets.set(key, list);
    }
    const sections: TodoSection[] = [];
    for (const bucket of DUE_BUCKETS) {
      const items = buckets.get(bucket.key);
      if (!items?.length) continue;
      items.sort((a, b) => (a.due?.date ?? "").localeCompare(b.due?.date ?? "") || byScore(a, b));
      sections.push({
        key: `due:${bucket.key}`,
        kind: "due",
        title: bucket.title,
        parent: null,
        items,
        count: items.length,
        tone: bucket.key === "overdue" ? "overdue" : undefined,
      });
    }
    return { sections, paused, done, ...counts };
  }

  // project: nest open steps under their open big task, section the rest by
  // parent.
  const openIds = new Set(open.map((n) => n.id));
  const items = new Map(open.map((n) => [n.id, item(n)]));
  const roots: TodoItem[] = [];
  for (const entry of items.values()) {
    const parent = entry.parent;
    if (parent && openIds.has(parent.id)) items.get(parent.id)!.steps.push(entry);
    else roots.push(entry);
  }
  const sortSteps = (list: TodoItem[]) => {
    list.sort(byScore);
    for (const entry of list) sortSteps(entry.steps);
  };

  const sectionsByKey = new Map<string, TodoSection>();
  for (const entry of roots) {
    const parent = entry.parent;
    const key = parent ? `parent:${parent.id}` : "none";
    let section = sectionsByKey.get(key);
    if (!section) {
      section = {
        key,
        kind: parent ? "parent" : "none",
        title: parent ? parent.title : "No project",
        parent,
        items: [],
        count: 0,
      };
      sectionsByKey.set(key, section);
    }
    section.items.push(entry);
  }
  const sections = [...sectionsByKey.values()];
  for (const section of sections) {
    sortSteps(section.items);
    section.count = countItems(section.items);
  }
  sections.sort((a, b) => {
    if (a.kind === "none" && b.kind !== "none") return 1;
    if (b.kind === "none" && a.kind !== "none") return -1;
    return topScore(b.items) - topScore(a.items) || a.title.localeCompare(b.title);
  });
  return { sections, paused, done, ...counts };
}

export type DueLabel = { text: string; tone: "overdue" | "today" | "soon" | "later" };

// "Today", "Tomorrow", "Fri", "Oct 20" — relative to the user's local today.
export function dueLabel(date: string, today: string): DueLabel {
  const at = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  const short = (opts: Intl.DateTimeFormatOptions) =>
    at.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
  if (date < today) {
    return { text: date === addDaysISO(today, -1) ? "Yesterday" : short({ month: "short", day: "numeric" }), tone: "overdue" };
  }
  if (date === today) return { text: "Today", tone: "today" };
  if (date === addDaysISO(today, 1)) return { text: "Tomorrow", tone: "soon" };
  if (date <= addDaysISO(today, 6)) return { text: short({ weekday: "short" }), tone: "soon" };
  if (date.slice(0, 4) !== today.slice(0, 4)) {
    return { text: short({ month: "short", day: "numeric", year: "numeric" }), tone: "later" };
  }
  return { text: short({ month: "short", day: "numeric" }), tone: "later" };
}
