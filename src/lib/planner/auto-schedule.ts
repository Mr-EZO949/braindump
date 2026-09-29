// Auto-schedule helper: places a list of work items into the next free
// windows of the current day, with breaks between them. Pure functions —
// extracted for unit testing.

export type SchedulableNode = {
  id: string;
  title: string;
  node_type: string;
};

export type BusyBlock = { start: number; end: number };

export type ScheduledPlacement = {
  node: SchedulableNode;
  startMinute: number;
  durationMinutes: number;
};

// Per-node-type duration estimates (minutes). Tunable.
export const DURATION_BY_TYPE: Record<string, number> = {
  task: 30,
  habit: 45,
  // a big task is scheduled as one work session until it has steps
  big_task: 60,
  project: 60,
  goal: 60,
  class: 30,
  idea: 30,
  note: 15,
  area: 30,
};

export const BREAK_MINUTES = 10;
export const DAY_START_MINUTE = 9 * 60;
export const DAY_END_MINUTE = 21 * 60;

export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nowMinutesFloor(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function parseHHMM(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

// Returns ordered free intervals within [windowStart, DAY_END_MINUTE) after
// subtracting any busy blocks. Slots clamped to DAY_START_MINUTE on the low end.
export function findFreeWindows(
  busy: BusyBlock[],
  windowStart: number,
): BusyBlock[] {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const free: BusyBlock[] = [];
  let cursor = Math.max(windowStart, DAY_START_MINUTE);
  for (const block of sorted) {
    if (block.end <= cursor) continue;
    if (block.start > cursor) {
      free.push({ start: cursor, end: Math.min(block.start, DAY_END_MINUTE) });
    }
    cursor = Math.max(cursor, block.end);
    if (cursor >= DAY_END_MINUTE) break;
  }
  if (cursor < DAY_END_MINUTE) {
    free.push({ start: cursor, end: DAY_END_MINUTE });
  }
  return free;
}

// Greedy placement — drops each node into the next slot large enough,
// reserves the slot + break minutes for subsequent placements.
// Returns null if any node couldn't fit.
//
// Duration resolution order:
//   1. options.durationByNodeId[node.id]  ← per-id AI estimate
//   2. options.durationByType[node.node_type]
//   3. DURATION_BY_TYPE[node.node_type]
//   4. 30 (final fallback)
export function planSchedule(
  nodes: SchedulableNode[],
  busy: BusyBlock[],
  options?: {
    now?: Date;
    durationByType?: Record<string, number>;
    durationByNodeId?: Record<string, number>;
  },
): ScheduledPlacement[] | null {
  const now = options?.now ?? new Date();
  const durationByType = options?.durationByType ?? DURATION_BY_TYPE;
  const durationByNodeId = options?.durationByNodeId ?? {};
  const placed: ScheduledPlacement[] = [];
  const liveBusy = [...busy];
  const windowStart = nowMinutesFloor(now);

  for (const node of nodes) {
    const duration =
      durationByNodeId[node.id] ??
      durationByType[node.node_type] ??
      DURATION_BY_TYPE[node.node_type] ??
      30;
    const free = findFreeWindows(liveBusy, windowStart);

    let placedSlot: BusyBlock | null = null;
    for (const slot of free) {
      if (slot.end - slot.start >= duration) {
        placedSlot = { start: slot.start, end: slot.start + duration };
        break;
      }
    }

    if (!placedSlot) {
      return null;
    }

    placed.push({ node, startMinute: placedSlot.start, durationMinutes: duration });
    liveBusy.push({ start: placedSlot.start, end: placedSlot.end + BREAK_MINUTES });
  }

  return placed;
}
