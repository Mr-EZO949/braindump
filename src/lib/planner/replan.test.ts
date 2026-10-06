import { describe, expect, it } from "vitest";

import {
  describeDayPlan,
  keptOutsideWindow,
  liveReplacements,
  pastUnfinished,
  replacementMarks,
  replanRestOfDay,
  replanStartMinute,
  supersededTasks,
  type DayPlanTask,
} from "./replan";

const DAY = "2026-10-05";

function task(id: string, start: string | null, minutes: number, extra: Partial<DayPlanTask> = {}): DayPlanTask {
  return {
    id,
    title: id,
    node_id: `n-${id}`,
    scheduled_date: DAY,
    start_time: start,
    duration_minutes: minutes,
    done: false,
    created_at: "2026-10-05T06:00:00Z",
    ...extra,
  };
}

const h = (hh: number, mm = 0) => hh * 60 + mm;

describe("a plan for part of the day", () => {
  // 15:00 now; the day has a 10:00 block (missed), 16:00 and 20:00 blocks.
  const tasks = [task("morning", "10:00", 60, { node_id: "a" }), task("afternoon", "16:00", 60, { node_id: "b" }), task("evening", "20:00", 60, { node_id: "c" })];

  it("rebuilding 19:00–21:00 keeps the afternoon, drops the missed morning (a skip)", () => {
    const gone = supersededTasks(tasks, DAY, h(21), undefined, { startMinute: h(19), nowMinute: h(15) });
    expect(gone.map((t) => t.id)).toEqual(["morning", "evening"]);
  });

  it("without a start, as before: everything before the plan's end goes", () => {
    expect(supersededTasks(tasks, DAY, h(21)).map((t) => t.id)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("on a later day nothing has happened yet, so all before the start stays", () => {
    const gone = supersededTasks(tasks, DAY, null, undefined, { startMinute: h(19), nowMinute: null });
    expect(gone.map((t) => t.id)).toEqual(["evening"]);
  });

  it("the planner skips what stays outside 14:00–17:00: the 20:00 block, not the missed morning", () => {
    expect(keptOutsideWindow(tasks, DAY, h(14), h(17), h(13)).map((t) => t.id)).toEqual(["evening"]);
    expect(keptOutsideWindow(tasks, DAY, h(17), h(19), h(15)).map((t) => t.id)).toEqual(["afternoon", "evening"]);
  });
});

describe("supersededTasks — what a new plan for a day replaces", () => {
  const tasks = [
    task("gym", "09:00", 60, { done: true }),
    task("essay", "10:00", 120),
    task("stats", "15:00", 60),
    task("dentist", "13:00", 60, { node_id: null }), // typed by hand
    task("other-day", "10:00", 60, { scheduled_date: "2026-10-06" }),
  ];

  it("a day plan takes over every unfinished plan task; ticked and hand-typed ones stay", () => {
    expect(supersededTasks(tasks, DAY, null).map((t) => t.id)).toEqual(["essay", "stats"]);
  });

  it("a 1–2 h session takes over only what starts before it ends", () => {
    expect(supersededTasks(tasks, DAY, h(12)).map((t) => t.id)).toEqual(["essay"]);
  });

  it("past unfinished = skipped; a future day has none", () => {
    expect(pastUnfinished(tasks, DAY, DAY, h(12, 30)).map((t) => t.id)).toEqual(["essay"]);
    expect(pastUnfinished(tasks, "2026-10-06", DAY, h(12))).toEqual([]);
  });
});

describe("replanRestOfDay — the rest of today from now", () => {
  it("keeps unfinished blocks, re-timed from now; future ones keep their time; ticked ones drop out", () => {
    const result = replanRestOfDay({
      tasks: [
        task("gym", "08:00", 60, { done: true }),
        task("essay", "09:00", 90),
        task("reading", "10:30", 30),
        task("stats", "16:00", 60),
      ],
      date: DAY,
      startMinute: h(11),
      endMinute: h(23),
      busy: [],
    });
    expect(result.placed.map((p) => [p.task.id, p.start])).toEqual([
      ["essay", h(11)],
      ["reading", h(12, 30)],
      ["stats", h(16)],
    ]);
    expect(result.missed).toEqual([]);
    expect(result.didntFit).toEqual([]);
  });

  it("running late: everything shifts in order, never over a fixed commitment", () => {
    const result = replanRestOfDay({
      tasks: [task("a", "09:00", 60), task("b", "10:00", 60), task("c", "11:00", 60)],
      date: DAY,
      startMinute: h(11),
      endMinute: h(23),
      busy: [{ start: h(12), end: h(14) }],
    });
    expect(result.placed.map((p) => [p.task.id, p.start])).toEqual([
      ["a", h(11)],
      ["b", h(14)],
      ["c", h(15)],
    ]);
  });

  it("what they missed leaves the plan, the rest is carried", () => {
    const result = replanRestOfDay({
      tasks: [task("workout", "07:00", 60), task("essay", "09:00", 60)],
      date: DAY,
      startMinute: h(10),
      endMinute: h(23),
      busy: [],
      missedNodeIds: new Set(["n-workout"]),
    });
    expect(result.missed.map((t) => t.id)).toEqual(["workout"]);
    expect(result.placed.map((p) => [p.task.id, p.start])).toEqual([["essay", h(10)]]);
  });

  it("too little time left: undated work drops first, last first", () => {
    const result = replanRestOfDay({
      tasks: [task("dated", "09:00", 120), task("undated1", "11:00", 60), task("undated2", "12:00", 60)],
      date: DAY,
      startMinute: h(20),
      endMinute: h(23),
      busy: [],
      datedNodeIds: new Set(["n-dated"]),
    });
    expect(result.placed.map((p) => p.task.id)).toEqual(["dated", "undated1"]);
    expect(result.didntFit.map((t) => t.id)).toEqual(["undated2"]);
  });

  it("a task with no time is carried after the timed ones", () => {
    const result = replanRestOfDay({
      tasks: [task("loose", null, 30), task("timed", "09:00", 30)],
      date: DAY,
      startMinute: h(10),
      endMinute: h(23),
      busy: [],
    });
    expect(result.placed.map((p) => [p.task.id, p.start])).toEqual([
      ["timed", h(10)],
      ["loose", h(10, 30)],
    ]);
  });

  it("starts on the next quarter hour", () => {
    expect(replanStartMinute(h(11, 7))).toBe(h(11, 15));
    expect(replanStartMinute(h(11))).toBe(h(11));
  });
});

describe("replacement records", () => {
  const rows = [
    {
      id: "r1",
      created_at: "2026-10-04T12:00:00Z",
      metadata: { date: "2026-10-04", skipped: [{ node_id: "n-essay", title: "Essay" }], missed: [] },
    },
    {
      id: "r2",
      created_at: "2026-10-05T12:00:00Z",
      metadata: { date: DAY, skipped: [], missed: [{ node_id: "n-gym", title: "Gym" }] },
    },
    {
      id: "r3",
      created_at: "2026-10-05T13:00:00Z",
      metadata: { date: DAY, skipped: [{ node_id: "n-x", title: "X" }], missed: [{ node_id: "n-run", title: "Run" }] },
    },
    { id: "u3", created_at: "2026-10-05T13:05:00Z", metadata: { undoes: "r3", date: DAY } },
  ];

  it("an undone replacement no longer counts", () => {
    expect(liveReplacements(rows).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("skips become planned-and-undone days; habits missed today leave today's picks", () => {
    const marks = replacementMarks(rows, DAY);
    expect(marks.skipped).toEqual([{ node_id: "n-essay", scheduled_date: "2026-10-04", created_at: "2026-10-04T12:00:00Z" }]);
    expect([...marks.missedToday]).toEqual(["n-gym"]);
  });
});

describe("describeDayPlan — today's plan in the chat snapshot", () => {
  it("one line per task on the day with its time and tick; a node-less one has no id", () => {
    const text = describeDayPlan(
      [task("essay", "10:00", 90), task("gym", "08:00", 60, { done: true }), task("call", "12:00", 15, { node_id: null })],
      DAY,
    );
    expect(text).toBe(
      `Today's plan (Planner; "done ✓" = ticked):\n- 08:00–09:00 gym — done ✓ — id: n-gym\n- 10:00–11:30 essay — not done — id: n-essay\n- 12:00–12:15 call — not done`,
    );
    expect(describeDayPlan([], DAY)).toBeNull();
  });
});
