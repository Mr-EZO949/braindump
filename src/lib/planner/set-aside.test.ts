import { describe, expect, it } from "vitest";

import { createRankingContext } from "@/lib/graph/priority-signals";

import { buildSetAside, describeSetAside, plannedIds, setAsideFor, type SetAsideNode } from "./set-aside";

const TODAY = "2026-10-06";

type Seed = Partial<SetAsideNode> & { id: string; target_date?: string | null; stakes?: number | null };

function setup(seeds: Seed[], edges: Array<[string, string]> = [], extra: Partial<Parameters<typeof buildSetAside>[0]> = {}) {
  const nodes = seeds.map((seed) => ({
    title: seed.id,
    node_type: "task",
    status: "active",
    current_importance_score: 50,
    waiting_for: null,
    resume_on: null,
    habit_target_per_week: null,
    created_at: "2026-09-01T00:00:00Z",
    ...seed,
  }));
  const ctx = createRankingContext({
    nodes,
    edges: edges.map(([child, parent]) => ({ source_node_id: child, target_node_id: parent, edge_type: "belongs_to" })),
    today: TODAY,
  });
  return buildSetAside({
    nodes,
    ctx,
    skip: () => false,
    clusterOf: (id) => ctx.parentOf.get(id) ?? id,
    workedOn: () => null,
    waitsOn: () => [],
    habitDoneThisWeek: () => 0,
    ...extra,
  });
}

describe("buildSetAside", () => {
  it("names a hold with its check-back day, once — not what's parked under it", () => {
    const items = setup(
      [
        { id: "stats", title: "Pass Stats final", node_type: "goal", status: "paused", waiting_for: "exam result", resume_on: "2026-10-20" },
        { id: "review", status: "active" },
      ],
      [["review", "stats"]],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "stats", kind: "waiting", reason: "Waiting for exam result — nothing to do until Oct 20" });
    expect(items[0].node_ids).toEqual(["stats", "review"]);
  });

  it("a far deadline with low pressure is plenty of time, named by its owner", () => {
    const items = setup(
      [
        { id: "italian", title: "Italian B1 exam", node_type: "goal", target_date: "2026-12-15" },
        { id: "vocab" },
        { id: "grammar" },
      ],
      [
        ["vocab", "italian"],
        ["grammar", "italian"],
      ],
    );
    const later = items.filter((item) => item.kind === "later");
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ id: "italian", reason: "Not due until Dec 15 — plenty of time" });
  });

  it("a deadline close by gets no line", () => {
    const items = setup([{ id: "cv", target_date: "2026-10-08" }]);
    expect(items).toEqual([]);
  });

  it("yesterday's project rests today; today's says you already put time in", () => {
    const items = setup(
      [{ id: "app", title: "BrainDump", node_type: "project" }, { id: "landing" }, { id: "gym", node_type: "task" }],
      [["landing", "app"]],
      { workedOn: (key) => (key === "app" ? "yesterday" : key === "gym" ? "today" : null) },
    );
    expect(items.find((item) => item.id === "app")?.reason).toBe("You worked on it yesterday — fine to rest it today");
    expect(items.find((item) => item.id === "gym")?.reason).toBe("You already put time into it today");
  });

  it("the user's own 'it can wait' names where they said it", () => {
    const nodes: Seed[] = [{ id: "side", title: "Side project", node_type: "project" }, { id: "logo" }];
    const base = nodes.map((seed) => ({
      title: seed.id,
      node_type: "task",
      status: "active",
      current_importance_score: 40,
      waiting_for: null,
      resume_on: null,
      habit_target_per_week: null,
      created_at: "2026-09-01T00:00:00Z",
      ...seed,
    }));
    const ctx = createRankingContext({
      nodes: base,
      edges: [{ source_node_id: "logo", target_node_id: "side", edge_type: "belongs_to" }],
      today: TODAY,
      steerEvents: [{ event_type: "demote_node", entity_id: "side", created_at: "2026-10-05T10:00:00Z" }],
      nowMs: Date.parse("2026-10-06T10:00:00Z"),
    });
    const items = buildSetAside({
      nodes: base,
      ctx,
      skip: () => false,
      clusterOf: (id) => id,
      workedOn: () => null,
      waitsOn: () => [],
      habitDoneThisWeek: () => 0,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "side", kind: "can_wait", reason: "You said it can wait" });
  });

  it("blocked work and a habit already met this week", () => {
    const items = setup(
      [{ id: "deploy" }, { id: "run", title: "Run", node_type: "habit", habit_target_per_week: 3 }],
      [],
      { waitsOn: (id) => (id === "deploy" ? ["Fix login"] : []), habitDoneThisWeek: () => 3 },
    );
    expect(items.map((item) => item.reason)).toEqual(['Can\'t start until "Fix login" is done', "Done 3/3 this week already"]);
  });

  it("a node with no clear reason gets no line", () => {
    expect(setup([{ id: "plain" }])).toEqual([]);
  });
});

describe("setAsideFor", () => {
  const item = (id: string, kind: Parameters<typeof setAsideFor>[0][number]["kind"], importance: number, node_ids = [id]) => ({
    id,
    title: id,
    reason: `${id} reason`,
    kind,
    node_ids,
    importance,
  });

  it("drops a line that names or contains a pick", () => {
    const lines = setAsideFor([item("italian", "later", 60, ["italian", "vocab"]), item("cv", "waiting", 30)], ["vocab"], 3);
    expect(lines.map((line) => line.id)).toEqual(["cv"]);
  });

  it("relief order, at most two of a kind", () => {
    const lines = setAsideFor(
      [item("a", "worked", 90), item("b", "waiting", 10), item("c", "waiting", 20), item("d", "waiting", 30)],
      [],
      3,
    );
    expect(lines.map((line) => line.id)).toEqual(["d", "c", "a"]);
  });
});

describe("describeSetAside / plannedIds", () => {
  it("one line for a chat plan message", () => {
    expect(
      describeSetAside([
        { id: "1", title: "Italian", reason: "Not due until Dec 15 — plenty of time", kind: "later" },
        { id: "2", title: "Side project", reason: "You said it can wait", kind: "can_wait" },
      ]),
    ).toBe('"Italian" (not due until Dec 15) and "Side project" (you said it can wait)');
    expect(describeSetAside([])).toBeNull();
  });

  it("a block on a bigger thing covers its steps", () => {
    expect(plannedIds([{ node_id: "p" }, { node_id: null }], [{ id: "p", step_ids: ["s1", "s2"] }])).toEqual(["p", "s1", "s2"]);
  });
});
