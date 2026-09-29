// End-to-end ranking scenario (docs/ranking.md): the real importance scorer
// and the real Focus builder run against an in-memory table set, through the
// same Supabase query chains they use in production. Deterministic, no network.
//
// The story: a student with a high-stakes Stats final in 5 days, Psychology
// later, a masters application, an undated errand, a habit and a note. Then:
// "did the Stats exam, waiting for results — Psychology got moved to Friday",
// then "focus on the masters application", then the check-back day.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPlannerCandidates } from "./planner";
import { computeWorkspaceScores } from "./scoring";

type Row = Record<string, unknown>;

// ─── Minimal Supabase query-builder fake ──────────────────────────────────
// Supports the filters the ranking code uses (eq/neq/in/not/or/gte/lt/limit);
// nested-column filters ("plan_sessions.status") are ignored. Writes are
// recorded, not applied.
function fakeSupabase(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];

  function query(table: string) {
    const preds: Array<(row: Row) => boolean> = [];
    let limit: number | null = null;
    let write: string | null = null;
    const nested = (col: string) => col.includes(".");
    const run = () => {
      if (write) return { data: null, error: null, count: 0 };
      let rows = (tables[table] ?? []).filter((row) => preds.every((p) => p(row)));
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: rows, error: null, count: rows.length };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      eq: (col: string, val: unknown) => {
        if (!nested(col)) preds.push((r) => r[col] === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        if (!nested(col)) preds.push((r) => r[col] !== val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        if (!nested(col)) preds.push((r) => vals.includes(r[col]));
        return builder;
      },
      gte: (col: string, val: string) => {
        if (!nested(col)) preds.push((r) => typeof r[col] === "string" && (r[col] as string) >= val);
        return builder;
      },
      lt: (col: string, val: string) => {
        if (!nested(col)) preds.push((r) => typeof r[col] === "string" && (r[col] as string) < val);
        return builder;
      },
      not: (col: string, op: string, val: unknown) => {
        if (op === "is") preds.push((r) => r[col] != null);
        if (op === "in" && typeof val === "string") {
          const list = val.replace(/[()"]/g, "").split(",");
          preds.push((r) => !list.includes(String(r[col])));
        }
        return builder;
      },
      or: (expr: string) => {
        const terms = expr.split(",").map((t) => t.split("."));
        preds.push((r) =>
          terms.some(([col, op, val]) => (op === "is" ? r[col] == null : String(r[col]) === val)),
        );
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    for (const op of ["update", "insert", "upsert", "delete"]) {
      builder[op] = (payload: unknown) => {
        write = op;
        writes.push({ table, op, payload });
        return builder;
      };
    }
    return builder;
  }

  return { client: { from: query }, writes };
}

// ─── Scenario data ────────────────────────────────────────────────────────
const USER = "u1";
const WS = "w1";
const CREATED = "2026-09-20T09:00:00.000Z";

function n(id: string, title: string, node_type: string, extra: Row = {}): Row {
  return {
    id,
    title,
    node_type,
    status: "active",
    created_at: CREATED,
    user_id: USER,
    workspace_id: WS,
    summary: null,
    body: null,
    manual_weight: null,
    target_date: null,
    stakes: null,
    waiting_for: null,
    resume_on: null,
    reading_order: null,
    habit_target_per_week: null,
    current_importance_score: null,
    ...extra,
  };
}

function under(child: string, parent: string): Row {
  return {
    id: `e-${child}`,
    user_id: USER,
    workspace_id: WS,
    source_node_id: child,
    target_node_id: parent,
    edge_type: "belongs_to",
    status: "active",
  };
}

function baseTables(): Record<string, Row[]> {
  return {
    nodes: [
      n("uni", "University", "area"),
      n("stats", "Pass the Stats final", "goal", { target_date: "2026-10-06", stakes: 1 }),
      n("pp1", "Past paper 1", "task", { reading_order: 1 }),
      n("pp2", "Past paper 2", "task", { reading_order: 2 }),
      n("reg", "Review regression", "task", { reading_order: 3 }),
      n("sheet", "Make the formula sheet", "task", { reading_order: 4 }),
      n("psych", "Pass Psychology", "goal", { target_date: "2026-10-20" }),
      n("ch", "Read chapters 5–7", "big_task"),
      n("cards", "Make flashcards", "task"),
      n("masters", "Masters application", "goal", { target_date: "2027-03-31" }),
      n("sop", "Draft the statement of purpose", "big_task"),
      n("refs", "Ask two professors for references", "task"),
      n("landlord", "Email the landlord", "task"),
      n("gym", "Gym", "habit", { habit_target_per_week: 3 }),
      n("ta", "Noah is my TA", "note"),
    ],
    edges: [
      under("stats", "uni"),
      under("psych", "uni"),
      under("ta", "uni"),
      under("pp1", "stats"),
      under("pp2", "stats"),
      under("reg", "stats"),
      under("sheet", "stats"),
      under("ch", "psych"),
      under("cards", "psych"),
      under("sop", "masters"),
      under("refs", "masters"),
    ],
    feedback_events: [],
    ai_node_judgments: [],
    lifecycle_events: [],
    habit_completions: [],
    chat_sessions: [],
    plan_tasks: [],
    plan_blocks: [],
    cascade_results: [],
    node_scores: [],
  };
}

function setToday(day: string) {
  vi.setSystemTime(new Date(`${day}T09:00:00.000Z`));
}

// Score, write the scores back onto the node rows (as production does), then
// build Focus — the order matters: Focus reads the stored importance.
async function rank(tables: Record<string, Row[]>, today: string) {
  const { client } = fakeSupabase(tables);
  const { nodeUpdates } = await computeWorkspaceScores({
    workspaceId: WS,
    userId: USER,
    supabase: client as never,
    today,
  });
  const score = new Map(nodeUpdates.map((u) => [u.id, u]));
  for (const row of tables.nodes) {
    const u = score.get(row.id as string);
    if (u) {
      row.current_importance_score = u.current_importance_score;
      row.importance_reason = u.importance_reason;
    }
  }
  const focus = await buildPlannerCandidates({
    workspaceId: WS,
    userId: USER,
    supabase: client,
    clientToday: today,
    clientTzOffsetMinutes: 0,
  });
  return {
    importance: (id: string) => score.get(id)?.current_importance_score ?? 0,
    reason: (id: string) => score.get(id)?.importance_reason ?? null,
    focus: focus.candidates,
    focusIds: focus.candidates.map((c) => c.id),
  };
}

function patch(tables: Record<string, Row[]>, id: string, fields: Row) {
  const row = tables.nodes.find((r) => r.id === id)!;
  Object.assign(row, fields);
}

describe("ranking v2 scenario — exams, a hold, a focus, a check-back", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Oct 1: the high-stakes exam in 5 days leads — its next step first, one step per deadline", async () => {
    setToday("2026-10-01");
    const tables = baseTables();
    const r = await rank(tables, "2026-10-01");

    expect(r.focusIds[0]).toBe("pp1");
    expect(r.focus[0].planning_signals[0]).toBe('"Pass the Stats final" due in 5 days · ~4 sessions left');
    // Later Stats steps don't crowd the hero's alternatives; they follow right after.
    const head = r.focusIds.slice(0, 3);
    expect(head.filter((id) => ["pp1", "pp2", "reg", "sheet"].includes(id))).toEqual(["pp1"]);
    expect(head).toContain("gym"); // the habit due this week is a real alternative
    expect(r.focusIds.indexOf("pp2")).toBe(3);
    // Goals and notes aren't Focus items; the area and the exam goal (containers) neither.
    expect(r.focusIds).not.toContain("stats");
    expect(r.focusIds).not.toContain("ta");

    // Size: the exam goal outgrows the undated errand and the far-off goals.
    expect(r.importance("stats")).toBeGreaterThan(r.importance("psych"));
    expect(r.importance("stats")).toBeGreaterThan(r.importance("masters"));
    expect(r.importance("pp1")).toBeGreaterThan(r.importance("landlord"));
    expect(r.importance("pp1")).toBeGreaterThan(r.importance("cards"));
    expect(r.reason("stats")).toBe("Due in 5 days — about 4 sessions left · High stakes");
  });

  it("Oct 7: 'did the exam, waiting for results; Psychology moved to Friday' → Stats shrinks and leaves Focus, Psychology leads", async () => {
    setToday("2026-10-01");
    const tables = baseTables();
    const before = await rank(tables, "2026-10-01");

    setToday("2026-10-07");
    patch(tables, "stats", { status: "paused", waiting_for: "exam result", resume_on: "2026-10-15" });
    patch(tables, "psych", { target_date: "2026-10-10" });
    const after = await rank(tables, "2026-10-07");

    for (const id of ["stats", "pp1", "pp2", "reg", "sheet"]) {
      expect(after.focusIds).not.toContain(id);
    }
    expect(["ch", "cards"]).toContain(after.focusIds[0]);
    expect(after.importance("stats")).toBeLessThan(before.importance("stats") * 0.5);
    expect(after.importance("pp1")).toBeLessThan(before.importance("pp1"));
    expect(after.importance("psych")).toBeGreaterThan(before.importance("psych"));
    expect(after.importance("psych")).toBeGreaterThan(after.importance("stats"));
    expect(after.reason("stats")).toBe("Waiting for exam result — check back Oct 15");
    expect(after.reason("pp1")).toBe('On hold with "Pass the Stats final"');
  });

  it("'focus on the masters application' lifts its steps above the undated errand, below the looming exam", async () => {
    setToday("2026-10-07");
    const tables = baseTables();
    patch(tables, "stats", { status: "paused", waiting_for: "exam result", resume_on: "2026-10-15" });
    patch(tables, "psych", { target_date: "2026-10-10" });
    const before = await rank(tables, "2026-10-07");
    tables.feedback_events.push({
      user_id: USER,
      workspace_id: WS,
      entity_type: "node",
      entity_id: "masters",
      event_type: "boost_node",
      created_at: "2026-10-07T08:00:00.000Z",
      metadata: { source: "chat" },
    });
    const after = await rank(tables, "2026-10-07");

    const pos = (id: string) => after.focusIds.indexOf(id);
    const mastersStep = Math.min(pos("sop"), pos("refs"));
    expect(mastersStep).toBeLessThan(pos("landlord"));
    expect(after.importance("masters")).toBeGreaterThan(before.importance("masters"));
    // The Psychology exam in 3 days still comes first.
    expect(["ch", "cards"]).toContain(after.focusIds[0]);
    expect(after.focus.find((c) => c.id === "refs")?.planning_signals).toContain("You asked to focus on this");
  });

  it("Oct 15: the check-back day brings the waiting exam back as one quick decision", async () => {
    setToday("2026-10-15");
    const tables = baseTables();
    patch(tables, "stats", { status: "paused", waiting_for: "exam result", resume_on: "2026-10-15" });
    const r = await rank(tables, "2026-10-15");

    expect(r.focusIds.slice(0, 3)).toContain("stats");
    expect(r.focus.find((c) => c.id === "stats")?.planning_signals[0]).toBe(
      "Check back: waiting for exam result",
    );
    // Its old prep steps stay parked.
    expect(r.focusIds).not.toContain("pp1");
    expect(r.reason("stats")).toBe("Waiting for exam result — time to check back");
  });

  it("a stale overdue date fades and asks instead of shouting", async () => {
    setToday("2026-10-20");
    const tables = baseTables();
    patch(tables, "landlord", { target_date: "2026-10-05" });
    const r = await rank(tables, "2026-10-20");
    const landlord = r.focus.find((c) => c.id === "landlord");
    expect(landlord?.planning_signals[0]).toBe("Overdue by 15 days — done, moved or dropped?");
  });
});
