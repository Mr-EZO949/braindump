import { describe, expect, it } from "vitest";

import { createFakeSupabase } from "@/lib/test/fake-supabase";
import { commitDayPlan, loadDayTasks, loadPlanMadeIds, replanCardRows, replanToday, undoPlanReplacement } from "./plan-replace";
import { PLAN_REPLACE_ENTITY, replacementMarks, supersededTasks } from "./replan";

const DAY = "2026-10-05"; // a Monday
const U = "user-1";
const W = "ws-1";

function row(id: string, title: string, start: string, minutes: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    user_id: U,
    workspace_id: W,
    title,
    node_id: `n-${id}`,
    scheduled_date: DAY,
    start_time: `${start}:00`,
    duration_minutes: minutes,
    done: false,
    created_at: "2026-10-05T06:00:00Z",
    ...extra,
  };
}

function node(id: string, title: string, node_type: string, target_date: string | null = null) {
  return { id: `n-${id}`, user_id: U, workspace_id: W, title, node_type, target_date, status: "active" };
}

function setup() {
  return createFakeSupabase({
    plan_tasks: [
      row("gym", "Gym", "07:00", 60),
      row("essay", "Essay draft", "09:00", 90),
      row("reading", "Reading", "08:00", 30, { done: true }),
      row("stats", "Stats problem set", "16:00", 60),
      row("call", "Call mom", "18:00", 30, { node_id: null }),
    ],
    nodes: [
      node("gym", "Gym", "habit"),
      node("essay", "Essay draft", "task", "2026-10-07"),
      node("reading", "Reading", "task"),
      node("stats", "Stats problem set", "task"),
    ],
    feedback_events: [],
    plan_sessions: [{ id: "s-new", user_id: U, workspace_id: W, status: "accepted" }],
    commitments: [
      {
        id: "c1",
        user_id: U,
        title: "Stats lecture",
        node_id: null,
        days: [1, 2, 3, 4, 5],
        start_time: "14:00:00",
        end_time: "15:30:00",
        starts_on: null,
        ends_on: null,
      },
    ],
  });
}

describe("one plan per day", () => {
  it("a new plan replaces the old one's unfinished tasks; Undo brings it back exactly", async () => {
    const fake = setup();
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    const before = await loadDayTasks(scope, DAY);
    const superseded = supersededTasks(before, DAY, null);
    expect(superseded.map((t) => t.id).sort()).toEqual(["essay", "gym", "stats"]);

    const result = await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      sessionId: "s-new",
      superseded,
      tasks: [{ title: "Italian", node_id: "n-italian", start_time: "13:00", duration_minutes: 120 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replaced).toBe(3);
    const after = fake.tables.plan_tasks.map((t) => t.title).sort();
    // Ticked and hand-typed tasks stay; the old plan's unfinished ones are gone.
    expect(after).toEqual(["Call mom", "Italian", "Reading"]);
    const record = fake.tables.feedback_events[0];
    expect(record.entity_type).toBe(PLAN_REPLACE_ENTITY);
    expect(record.event_type).toBe("edit_plan");

    const undo = await undoPlanReplacement(scope, result.replacementId!);
    expect(undo).toEqual({ ok: true, date: DAY });
    const restored = [...fake.tables.plan_tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(restored.map((t) => [t.id, t.done])).toEqual([
      ["call", false],
      ["essay", false],
      ["gym", false],
      ["reading", true],
      ["stats", false],
    ]);
    // The new plan is dropped: its session no longer counts as accepted.
    expect(fake.tables.plan_sessions[0].status).toBe("rejected");
    // A second Undo is a no-op.
    expect(await undoPlanReplacement(scope, result.replacementId!)).toEqual({ ok: true, date: DAY, already: true });
  });

  it("the first plan of a day has nothing to undo, but its tasks are recorded as the plan's", async () => {
    const fake = createFakeSupabase({ plan_tasks: [], feedback_events: [] });
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    const result = await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      superseded: [],
      tasks: [{ title: "Essay", node_id: "n-essay", start_time: "09:00", duration_minutes: 60 }],
    });
    expect(result).toMatchObject({ ok: true, replacementId: null, replaced: 0 });
    expect(fake.tables.feedback_events).toHaveLength(1);
    expect(fake.tables.feedback_events[0].metadata).toMatchObject({ record_only: true, date: DAY });
  });

  it("owner 10-06: a rebuilt plan replaces the old plan's node-less blocks too — no doubled 'Update CV'", async () => {
    const fake = createFakeSupabase({
      plan_tasks: [row("mom", "Call mom", "18:00", 30, { node_id: null })],
      feedback_events: [],
    });
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    const first = await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      superseded: supersededTasks(await loadDayTasks(scope, DAY), DAY, null, await loadPlanMadeIds(scope, DAY)),
      tasks: [
        { title: "Update CV", node_id: null, start_time: "13:30", duration_minutes: 15 },
        { title: "Build engine MVP", node_id: "n-engine", start_time: "14:00", duration_minutes: 75 },
      ],
    });
    expect(first.ok).toBe(true);
    fake.tables.feedback_events[0].created_at = "2026-10-05T10:00:00Z";

    const superseded = supersededTasks(await loadDayTasks(scope, DAY), DAY, null, await loadPlanMadeIds(scope, DAY));
    expect(superseded.map((t) => t.title).sort()).toEqual(["Build engine MVP", "Update CV"]);
    const second = await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      superseded,
      tasks: [{ title: "update CV", node_id: null, start_time: "22:10", duration_minutes: 30 }],
    });
    expect(second).toMatchObject({ ok: true, replaced: 2 });
    // The hand-typed task stays; the CV is on the day once.
    expect(fake.tables.plan_tasks.map((t) => t.title).sort()).toEqual(["Call mom", "update CV"]);

    // Undo of the second plan isn't blocked by the first plan's record.
    if (!second.ok) return;
    fake.tables.feedback_events[1].created_at = "2026-10-05T11:00:00Z";
    expect(await undoPlanReplacement(scope, second.replacementId!)).toMatchObject({ ok: true });
    expect(fake.tables.plan_tasks.map((t) => t.title).sort()).toEqual(["Build engine MVP", "Call mom", "Update CV"]);
  });

  it("undoing an older plan while a newer one replaced it is refused", async () => {
    const fake = setup();
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    const first = await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      superseded: supersededTasks(await loadDayTasks(scope, DAY), DAY, null),
      tasks: [{ title: "Italian", node_id: "n-italian", start_time: "13:00", duration_minutes: 60 }],
    });
    // Records must differ in time for the "later" check.
    fake.tables.feedback_events[0].created_at = "2026-10-05T10:00:00Z";
    const second = await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      superseded: supersededTasks(await loadDayTasks(scope, DAY), DAY, null),
      tasks: [{ title: "Math", node_id: "n-math", start_time: "13:00", duration_minutes: 60 }],
    });
    fake.tables.feedback_events[1].created_at = "2026-10-05T11:00:00Z";
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const refused = await undoPlanReplacement(scope, first.replacementId!);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(await undoPlanReplacement(scope, second.replacementId!)).toMatchObject({ ok: true });
    expect(fake.tables.plan_tasks.map((t) => t.title)).toContain("Italian");
  });
});

describe("fixed-time items (owner 10-06: mealprep 12:30–14:00)", () => {
  it("'Replan from now' leaves a fixed item where it is and plans around it; a rebuilt plan still replaces it", async () => {
    const fake = createFakeSupabase({ plan_tasks: [], nodes: [node("cv", "Update CV", "task")], feedback_events: [], commitments: [] });
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    await commitDayPlan(scope, {
      date: DAY,
      kind: "plan",
      superseded: [],
      tasks: [
        { title: "Mealprep", node_id: null, start_time: "12:30", duration_minutes: 90, fixed: true },
        { title: "Update CV", node_id: "n-cv", start_time: "11:00", duration_minutes: 45 },
      ],
    });
    // 12:20 → the CV moves on from now, around the mealprep.
    const outcome = await replanToday(scope, { today: DAY, nowMinute: 12 * 60 + 20 });
    expect(outcome.ok).toBe(true);
    const byTitle = (title: string) => fake.tables.plan_tasks.find((t) => t.title === title);
    expect(byTitle("Mealprep")).toMatchObject({ start_time: "12:30", duration_minutes: 90 });
    expect(byTitle("Update CV")).toMatchObject({ start_time: "14:00" });

    const superseded = supersededTasks(await loadDayTasks(scope, DAY), DAY, null, await loadPlanMadeIds(scope, DAY));
    expect(superseded.map((t) => t.title).sort()).toEqual(["Mealprep", "Update CV"]);
  });
});

describe("replanToday — 'bro i went off schedule and missed my workout'", () => {
  it("carries the unfinished plan from now, around the lecture; the missed workout is off and not done", async () => {
    const fake = setup();
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    const outcome = await replanToday(scope, { today: DAY, nowMinute: 13 * 60 + 50, missed: ["n-gym"] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const tasks = fake.tables.plan_tasks;
    const byTitle = (title: string) => tasks.find((t) => t.title === title);
    // 13:50 → starts 14:00, but the lecture runs 14:00–15:30: the essay goes after it.
    expect(byTitle("Essay draft")).toMatchObject({ start_time: "15:30", duration_minutes: 90, done: false });
    // Stats was at 16:00 — now runs after the essay.
    expect(byTitle("Stats problem set")).toMatchObject({ start_time: "17:00" });
    expect(byTitle("Gym")).toBeUndefined();
    expect(byTitle("Reading")).toMatchObject({ done: true, start_time: "08:00:00" });
    expect(byTitle("Call mom")).toBeDefined();
    // Nothing was marked done, no habit logged.
    expect(fake.tables.habit_completions ?? []).toEqual([]);

    // The record: the habit missed today, the past essay block a skip.
    const marks = replacementMarks(fake.tables.feedback_events as never, DAY);
    expect([...marks.missedToday]).toEqual(["n-gym"]);
    expect(marks.skipped.map((s) => s.node_id)).toEqual(["n-essay"]);

    const rows = replanCardRows(outcome);
    expect(rows.map((r) => [r.title, r.action, r.detail])).toEqual([
      ["Essay draft", "moved", "15:30–17:00 (was 09:00)"],
      ["Stats problem set", "moved", "17:00–18:00 (was 16:00)"],
      ["Gym", "missed", "Missed today — not marked done"],
    ]);

    // Undo → the earlier plan, exactly.
    const undo = await undoPlanReplacement(scope, outcome.replacementId!);
    expect(undo.ok).toBe(true);
    expect(byTitleIn(fake.tables.plan_tasks, "Gym")).toMatchObject({ id: "gym", start_time: "07:00:00", done: false });
    expect(byTitleIn(fake.tables.plan_tasks, "Essay draft")).toMatchObject({ id: "essay", start_time: "09:00:00" });
    expect(fake.tables.plan_tasks).toHaveLength(5);
    expect(replacementMarks(fake.tables.feedback_events as never, DAY).missedToday.size).toBe(0);
  });

  it("a habit missed that wasn't on the plan is still recorded as missed", async () => {
    const fake = setup();
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    fake.tables.nodes.push(node("run", "Morning run", "habit"));
    const outcome = await replanToday(scope, { today: DAY, nowMinute: 10 * 60, missed: ["morning run"] });
    expect(outcome.ok).toBe(true);
    expect([...replacementMarks(fake.tables.feedback_events as never, DAY).missedToday]).toEqual(["n-run"]);
  });

  it("no plan today → says so, writes nothing", async () => {
    const fake = createFakeSupabase({ plan_tasks: [], nodes: [], feedback_events: [] });
    const scope = { supabase: fake.client, userId: U, workspaceId: W };
    expect(await replanToday(scope, { today: DAY, nowMinute: 600 })).toMatchObject({ ok: false, reason: "no_plan" });
    expect(fake.tables.feedback_events).toEqual([]);
  });
});

function byTitleIn(rows: Array<Record<string, unknown>>, title: string) {
  return rows.find((t) => t.title === title);
}
