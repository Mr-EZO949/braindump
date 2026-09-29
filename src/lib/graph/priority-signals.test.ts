import { describe, expect, it } from "vitest";

import {
  createRankingContext,
  daysBetween,
  deadlinePressure,
  holdFactor,
  rankingReason,
  steerFromEvents,
  type RankEdge,
  type RankNode,
} from "./priority-signals";

const TODAY = "2026-10-01";
const NOW = Date.parse("2026-10-01T12:00:00Z");

function node(id: string, node_type: string, extra: Partial<RankNode> = {}): RankNode {
  return { id, node_type, status: "active", created_at: "2026-09-01T00:00:00Z", title: id, ...extra };
}

function child(childId: string, parentId: string): RankEdge {
  return { source_node_id: childId, target_node_id: parentId, edge_type: "belongs_to" };
}

describe("daysBetween", () => {
  it("counts whole calendar days and ignores the time part", () => {
    expect(daysBetween("2026-10-01", "2026-10-04")).toBe(3);
    expect(daysBetween("2026-10-01T23:59:00Z", "2026-10-02")).toBe(1);
    expect(daysBetween("2026-10-05", "2026-10-01")).toBe(-4);
  });
});

describe("deadlinePressure — slack, not raw distance", () => {
  const p = (daysLeft: number, sessionsLeft: number, stakes: "low" | "normal" | "high" = "normal") =>
    deadlinePressure({ daysLeft, sessionsLeft, stakes });

  it("is zero when there is plenty of slack", () => {
    expect(p(30, 2)).toBe(0);
    expect(p(11, 1)).toBe(0);
  });

  it("is full at zero or negative slack", () => {
    expect(p(3, 6)).toBe(100); // 3 days, 3 days of work
    expect(p(2, 10)).toBe(100); // behind
  });

  it("a big job 7 days out is more urgent than a small job 3 days out", () => {
    const exam = p(7, 12); // 12 prep sessions left
    const email = p(3, 1);
    expect(exam).toBeGreaterThan(email);
    expect(exam).toBeGreaterThan(80);
  });

  it("rises smoothly as the date approaches (no 7-day cliff)", () => {
    const series = [12, 10, 8, 6, 4, 2, 1].map((d) => p(d, 2));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
    expect(p(8, 2)).toBeGreaterThan(0); // the old rule gave 8 days nothing
  });

  it("high stakes start earlier and press harder; low stakes later", () => {
    expect(p(12, 2, "high")).toBeGreaterThan(0);
    expect(p(12, 2, "normal")).toBe(0);
    expect(p(5, 2, "high")).toBeGreaterThan(p(5, 2, "normal"));
    expect(p(5, 2, "low")).toBeLessThan(p(5, 2, "normal"));
  });

  it("overdue: full for the grace days, then fades to the floor", () => {
    expect(p(-1, 1)).toBe(100);
    expect(p(-2, 1)).toBe(100);
    expect(p(-4, 1)).toBe(80);
    expect(p(-30, 1)).toBe(40);
  });
});

describe("createRankingContext — deadlines", () => {
  const nodes = [
    node("stats", "goal", { target_date: "2026-10-08" }),
    node("prep1", "task", { reading_order: 1 }),
    node("prep2", "task", { reading_order: 2 }),
    node("mock", "big_task"),
    node("done", "task", { status: "completed" }),
    node("gym", "habit"),
    node("tip", "note"),
    node("free", "task"),
  ];
  const edges = [
    child("prep1", "stats"),
    child("prep2", "stats"),
    child("mock", "stats"),
    child("done", "stats"),
    child("gym", "stats"),
    child("tip", "stats"),
  ];
  const ctx = createRankingContext({ nodes, edges, today: TODAY });

  it("the owner carries its own date with open work counted under it", () => {
    const dl = ctx.deadline("stats")!;
    expect(dl.inherited).toBe(false);
    expect(dl.daysLeft).toBe(7);
    // two tasks (1 each) + a big task without steps (3); completed work doesn't count
    expect(dl.sessionsLeft).toBe(5);
    expect(dl.pressure).toBeGreaterThan(0);
  });

  it("steps inherit the owner's deadline and pressure", () => {
    const dl = ctx.deadline("prep1")!;
    expect(dl.inherited).toBe(true);
    expect(dl.ownerId).toBe("stats");
    expect(dl.pressure).toBe(ctx.deadline("stats")!.pressure);
  });

  it("habits and notes never carry a deadline; undated work has none", () => {
    expect(ctx.deadline("gym")).toBeNull();
    expect(ctx.deadline("tip")).toBeNull();
    expect(ctx.deadline("free")).toBeNull();
  });

  it("a dated owner with nothing under it assumes some unknown prep", () => {
    const solo = createRankingContext({
      nodes: [node("psych", "goal", { target_date: "2026-10-05" })],
      edges: [],
      today: TODAY,
    });
    expect(solo.deadline("psych")!.sessionsLeft).toBe(3);
  });

  it("required_for passes the target's date back one hop", () => {
    const c = createRankingContext({
      nodes: [node("form", "task"), node("app", "goal", { target_date: "2026-10-03" })],
      edges: [{ source_node_id: "form", target_node_id: "app", edge_type: "required_for" }],
      today: TODAY,
    });
    expect(c.deadline("form")!.ownerId).toBe("app");
  });

  it("work under a paused step doesn't count toward sessions left", () => {
    const c = createRankingContext({
      nodes: [
        node("g", "goal", { target_date: "2026-10-10" }),
        node("a", "task"),
        node("parked", "big_task", { status: "paused" }),
        node("p1", "task"),
      ],
      edges: [child("a", "g"), child("parked", "g"), child("p1", "parked")],
      today: TODAY,
    });
    expect(c.deadline("g")!.sessionsLeft).toBe(1);
  });
});

describe("createRankingContext — stakes, steering, holds", () => {
  it("stakes inherit from the nearest ancestor that sets them", () => {
    const c = createRankingContext({
      nodes: [node("g", "goal", { stakes: 1 }), node("t", "task"), node("q", "task", { stakes: -1 })],
      edges: [child("t", "g"), child("q", "g")],
      today: TODAY,
    });
    expect(c.stakes("g")).toBe("high");
    expect(c.stakes("t")).toBe("high");
    expect(c.stakes("q")).toBe("low");
  });

  it("steering decays with a 7-day half-life and nets boosts against demotes", () => {
    const steer = steerFromEvents(
      [
        { event_type: "boost_node", entity_id: "a", created_at: "2026-10-01T12:00:00Z" },
        { event_type: "boost_node", entity_id: "b", created_at: "2026-09-24T12:00:00Z" },
        { event_type: "demote_node", entity_id: "c", created_at: "2026-10-01T12:00:00Z" },
        { event_type: "boost_node", entity_id: "d", created_at: "2026-10-01T12:00:00Z" },
        { event_type: "demote_node", entity_id: "d", created_at: "2026-10-01T12:00:00Z" },
        { event_type: "accept_node", entity_id: "e", created_at: "2026-10-01T12:00:00Z" },
      ],
      NOW,
    );
    expect(steer.get("a")).toBeCloseTo(1, 5);
    expect(steer.get("b")).toBeCloseTo(0.5, 5);
    expect(steer.get("c")).toBeCloseTo(-1, 5);
    expect(steer.get("d")).toBeCloseTo(0, 5);
    expect(steer.has("e")).toBe(false);
  });

  it("a boost on a goal reaches the steps under it", () => {
    const c = createRankingContext({
      nodes: [node("g", "goal"), node("t", "task")],
      edges: [child("t", "g")],
      today: TODAY,
      steerEvents: [{ event_type: "boost_node", entity_id: "g", created_at: "2026-10-01T12:00:00Z" }],
      nowMs: NOW,
    });
    expect(c.steer("t")).toBeCloseTo(0.8, 5);
  });

  it("hold: self, check-back when resume_on arrives, and under a held parent", () => {
    const c = createRankingContext({
      nodes: [
        node("waiting", "goal", { status: "paused", waiting_for: "exam result", resume_on: "2026-10-20" }),
        node("step", "task"),
        node("due", "goal", { status: "paused", resume_on: "2026-10-01" }),
        node("free", "task"),
      ],
      edges: [child("step", "waiting")],
      today: TODAY,
    });
    expect(c.hold("waiting")).toBe("self");
    expect(c.hold("step")).toBe("ancestor");
    expect(c.hold("due")).toBe("check_back");
    expect(c.hold("free")).toBe("none");
    expect(holdFactor("self")).toBeLessThan(holdFactor("ancestor"));
    expect(holdFactor("none")).toBe(1);
  });
});

describe("rankingReason", () => {
  const c = createRankingContext({
    nodes: [
      node("Pass Stats", "goal", { target_date: "2026-10-04", stakes: 1 }),
      node("Past paper 1", "task"),
      node("Pass Psych", "goal", { status: "paused", waiting_for: "exam result", resume_on: "2026-10-20" }),
      node("Psych notes", "task"),
      node("Old form", "task", { target_date: "2026-09-20" }),
      node("Idle", "task"),
    ],
    edges: [child("Past paper 1", "Pass Stats"), child("Psych notes", "Pass Psych")],
    today: TODAY,
    steerEvents: [{ event_type: "boost_node", entity_id: "Idle", created_at: "2026-10-01T12:00:00Z" }],
    nowMs: NOW,
  });

  it("names the deadline, the work left and the stakes", () => {
    expect(rankingReason(c, "Pass Stats")).toBe("Due in 3 days — about 1 session left · High stakes");
    expect(rankingReason(c, "Past paper 1")).toBe(
      '"Pass Stats" due in 3 days — about 1 session left · High stakes',
    );
  });

  it("explains holds instead of scores", () => {
    expect(rankingReason(c, "Pass Psych")).toBe("Waiting for exam result — check back Oct 20");
    expect(rankingReason(c, "Psych notes")).toBe('On hold with "Pass Psych"');
  });

  it("asks about stale overdue dates and names steering", () => {
    expect(rankingReason(c, "Old form")).toBe("Overdue by 11 days — done, moved or dropped?");
    expect(rankingReason(c, "Idle")).toBe("You asked to focus on this");
  });
});
