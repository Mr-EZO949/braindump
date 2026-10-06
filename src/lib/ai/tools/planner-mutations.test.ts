// plan_day plans only the session's free time: today's saved commitments plus
// the busy time the user named in chat (owner, 2026-09-30: "schedule 2:30 to
// 11pm, I have lectures 2:30–6:30" — the plan filled the lectures). The plan
// model is mocked; this checks what it is told and what the user is told.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Commitment } from "@/lib/planner/commitments";

let commitments: Commitment[] = [];
type PlanCall = {
  busy: { free_minutes: number; lines: string[] } | null;
  time_blocks?: unknown[];
  requests?: unknown[];
  session_minutes?: number | null;
  session_start_minute?: number | null;
  workspace_context?: string;
};
const planCalls: PlanCall[] = [];
let planError: Error | null = null;

const candidateCalls: Array<{ include?: string | null }> = [];
const timeBlocks = [{ id: "it", title: "Italian Crash Course", node_type: "big_task", open_steps: 3, start_with: ["Greetings"], step_ids: ["g"] }];
const requests = [{ text: "3h of Italian", minutes: 180, node_id: "it", title: "Italian Crash Course", node_type: "big_task", related: [] }];
let dueSoon: Array<{ id: string; title: string; days_left: number; node_ids: string[] }> = [];
vi.mock("../planner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../planner")>()),
  buildPlannerCandidates: vi.fn(async (params: { include?: string | null }) => {
    candidateCalls.push(params);
    return {
      candidates: [
        { id: "n1", title: "ML project", summary: null, body: null, node_type: "task", planning_signals: {} },
        { id: "cv", title: "Update CV", summary: null, body: null, node_type: "task", planning_signals: {} },
      ],
      commitments,
      time_blocks: params.include ? timeBlocks : [],
      requests: params.include ? requests : [],
      due_soon: dueSoon,
      set_aside: [],
    };
  }),
}));
vi.mock("../index", () => ({
  aiProvider: () => ({
    buildPlan: vi.fn(async (input: PlanCall) => {
      planCalls.push(input);
      if (planError) throw planError;
      return {
        output: { blocks: [{ node_id: "n1", title: "ML project", start_offset: 0, duration_minutes: 90, block_type: "focus" }] },
        run: { provider: "claude", model_name: "m", input_tokens: 1, output_tokens: 1, latency_ms: 1, estimated_cost: 0 },
      };
    }),
  }),
}));
vi.mock("../telemetry", () => ({ persistAIRun: vi.fn(async () => "run-1") }));
// 12:10 in the user's zone → a "now" session starts at 12:30.
vi.mock("@/lib/time/request-date", () => ({ getRequestTimeZone: vi.fn(async () => "UTC") }));

import { createFakeSupabase } from "@/lib/test/fake-supabase";

import { MalformedAIResponseError, PLAN_CUT_OFF_MESSAGE } from "../errors";
import { PLANNER_MUTATION_TOOLS } from "./planner-mutations";

const PLAN_DAY = PLANNER_MUTATION_TOOLS.find((t) => t.schema.name === "plan_day")!;
const WED = "2026-10-07";

function ctx(planTasks: Record<string, unknown>[] = []) {
  const { client } = createFakeSupabase({ plan_sessions: [], plan_blocks: [], plan_tasks: planTasks });
  return { supabase: client, userId: "u1", workspaceId: "w1", selectedNodeId: null, today: WED };
}

beforeEach(() => {
  commitments = [];
  dueSoon = [];
  planCalls.length = 0;
  candidateCalls.length = 0;
  planError = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${WED}T12:10:00Z`));
});

describe("plan_day — busy time", () => {
  it("plans around a lecture named in chat, from the start time the user said", async () => {
    const result = (await PLAN_DAY.handler(
      {
        window: "custom",
        custom_minutes: 510,
        start_time: "14:30",
        busy: [{ title: "Lectures", start: "14:30", end: "18:30" }],
      },
      ctx(),
    )) as { accepted: boolean; message: string };

    expect(planCalls[0].busy?.free_minutes).toBe(270);
    expect(planCalls[0].busy?.lines[0]).toContain("Session starts 14:30");
    expect(planCalls[0].busy?.lines[0]).toContain("Lectures 14:30–18:30");
    expect(result.accepted).toBe(true);
    expect(result.message).toContain("around Lectures 14:30–18:30");
  });

  it("a short window starting now still sees today's saved commitments", async () => {
    commitments = [
      {
        id: "c1",
        title: "Stats",
        node_id: null,
        days: [1, 2, 3, 4, 5],
        start_time: "13:00:00",
        end_time: "14:00:00",
        starts_on: null,
        ends_on: null,
      },
    ];
    await PLAN_DAY.handler({ window: "2h" }, ctx());
    // now 12:10 → session 12:30–14:30; Stats 13:00–14:00 leaves 60 free minutes.
    expect(planCalls[0].busy?.free_minutes).toBe(60);
    expect(planCalls[0].busy?.lines[0]).toContain("Session starts 12:30");
  });

  it("nothing busy → no note, and bad busy rows are ignored", async () => {
    await PLAN_DAY.handler({ window: "1h", busy: [{ start: "25:00", end: "26:00" }, "x"] }, ctx());
    expect(planCalls[0].busy).toBeNull();
  });
});

describe("plan_day — the whole day (owner 10-03: ~15 h from when I'm awake)", () => {
  it("\"plan my day from 8am\" plans 08:00–23:00", async () => {
    const result = (await PLAN_DAY.handler({ window: "day", start_time: "08:00" }, ctx())) as {
      message: string;
    };
    expect(planCalls[0].session_minutes).toBe(900);
    expect(planCalls[0].session_start_minute).toBe(8 * 60);
    expect(result.message).toContain("day plan for 08:00–23:00");
  });

  it("\"plan my day\" runs from now to 23:00, around a class", async () => {
    commitments = [
      {
        id: "c1",
        title: "Stats",
        node_id: null,
        days: [3],
        start_time: "14:00:00",
        end_time: "16:00:00",
        starts_on: null,
        ends_on: null,
      },
    ];
    const result = (await PLAN_DAY.handler({ window: "day" }, ctx())) as { message: string };
    // now 12:10 → 12:30–23:00 = 630 min, Stats takes 120 of them.
    expect(planCalls[0].session_minutes).toBe(630);
    expect(planCalls[0].busy?.free_minutes).toBe(510);
    expect(result.message).toContain("12:30–23:00");
    expect(result.message).toContain("around Stats 14:00–16:00");
  });

  it("a custom window can run 18 hours", async () => {
    await PLAN_DAY.handler({ window: "custom", custom_minutes: 2000, start_time: "05:00" }, ctx());
    expect(planCalls[0].session_minutes).toBe(18 * 60);
  });

  it("a plan cut off at the output cap says so", async () => {
    planError = new MalformedAIResponseError({
      message: "Plan answer cut off at max_tokens",
      rawOutput: "{\"blocks\": [",
      runType: "plan",
      provider: "claude",
      modelName: "m",
      promptVersion: "plan-v7",
      truncated: true,
    });
    const result = (await PLAN_DAY.handler({ window: "day" }, ctx())) as { accepted: boolean; error: string };
    expect(result.accepted).toBe(false);
    expect(result.error).toBe(PLAN_CUT_OFF_MESSAGE);
  });
});

describe("plan_day — what the user asks to fit in (plan-v8)", () => {
  it("passes their words to the ranking and the time blocks + requests to the plan", async () => {
    await PLAN_DAY.handler({ window: "day", start_time: "08:00", include: "3h of Italian" }, ctx());
    expect(candidateCalls[0].include).toBe("3h of Italian");
    expect(planCalls[0].time_blocks).toEqual(timeBlocks);
    expect(planCalls[0].requests).toEqual(requests);
  });

  it("without it, nothing changes", async () => {
    await PLAN_DAY.handler({ window: "day", start_time: "08:00" }, ctx());
    expect(candidateCalls[0].include).toBeNull();
    expect(planCalls[0].requests).toEqual([]);
  });
});

describe("plan_day — owner 10-06 (sick day, mealprep, until 11pm, plan wednesday)", () => {
  const lecture = {
    id: "ir",
    title: "Information Retrieval lecture",
    node_id: null,
    days: [3], // Wednesdays (WED is the test's today)
    start_time: "15:30:00",
    end_time: "18:30:00",
    starts_on: null,
    ends_on: null,
  };

  it("end_time sets the length; a timed item in include is fixed time; a busy repeat of a saved lecture counts once; the note reaches the plan", async () => {
    commitments = [lecture];
    const result = (await PLAN_DAY.handler(
      {
        window: "custom",
        custom_minutes: 570, // what Haiku wrote for 12:30 → 23:00
        start_time: "12:30",
        end_time: "23:00",
        include: "1.5h mealprep from 12:30, clean room fully",
        busy: [{ title: "Information Retrieval lecture", start: "15:30", end: "18:30" }],
        note: "sick, not much deep work",
      },
      ctx(),
    )) as { message: string };
    expect(planCalls[0].session_minutes).toBe(630);
    // 630 − mealprep 90 − lecture 180.
    expect(planCalls[0].busy?.free_minutes).toBe(360);
    expect(planCalls[0].busy?.lines[0]).toContain("Mealprep 12:30–14:00");
    expect(planCalls[0].busy?.lines[0].match(/Information Retrieval/g)).toHaveLength(1);
    expect(planCalls[0].workspace_context).toContain("The user about today: sick, not much deep work");
    expect(result.message).toContain("12:30–23:00");
  });

  it("\"plan wednesday\" on a Tuesday plans Wednesday from 08:00 with Wednesday's weekly times", async () => {
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    commitments = [{ ...lecture, days: [2] }]; // Tuesdays only
    const { client } = createFakeSupabase({ plan_sessions: [], plan_blocks: [] });
    const result = (await PLAN_DAY.handler(
      { window: "day", day: "wednesday" },
      { supabase: client, userId: "u1", workspaceId: "w1", selectedNodeId: null, today: "2026-10-06" },
    )) as { message: string; plan_date: string };
    expect(result.plan_date).toBe("2026-10-07");
    expect(planCalls[0].session_start_minute).toBe(8 * 60);
    expect(planCalls[0].session_minutes).toBe(900);
    expect(planCalls[0].busy).toBeNull();
    expect(result.message).toContain("2026-10-07 08:00–23:00");
  });
});

describe("plan_day — due work left out, part of a day", () => {
  type Result = { message: string; left_out_due?: string };

  it("names work due soon that isn't in the plan, so the reply can offer to build around it", async () => {
    dueSoon = [{ id: "exam", title: "Stats exam", days_left: 1, node_ids: ["exam", "ch3"] }];
    const result = (await PLAN_DAY.handler({ window: "2h" }, ctx())) as Result;
    expect(result.left_out_due).toBe('"Stats exam" (due tomorrow)');
    // Ends on a question: "yes" then reaches the model with tools and re-plans.
    expect(result.message).toMatch(/"Stats exam" is due tomorrow and isn't in it — want me to build around it\?$/);
  });

  it("says nothing when a block covers it", async () => {
    dueSoon = [{ id: "ml", title: "ML deadline", days_left: 0, node_ids: ["ml", "n1"] }];
    const result = (await PLAN_DAY.handler({ window: "2h" }, ctx())) as Result;
    expect(result.left_out_due).toBeUndefined();
    expect(result.message).not.toContain("build around");
  });

  it("a plan for 14:00–17:00 doesn't plan again what sits at 20:00, and counts it as covered", async () => {
    dueSoon = [{ id: "cv", title: "Update CV", days_left: 0, node_ids: ["cv"] }];
    const evening = { id: "t1", user_id: "u1", workspace_id: "w1", title: "Update CV", node_id: "cv", scheduled_date: WED, start_time: "20:00:00", duration_minutes: 45, done: false };
    const result = (await PLAN_DAY.handler({ window: "custom", start_time: "14:00", end_time: "17:00" }, ctx([evening]))) as Result;
    const sent = (planCalls[0] as unknown as { candidate_nodes: { id: string }[] }).candidate_nodes.map((c) => c.id);
    expect(sent).toEqual(["n1"]);
    expect(result.left_out_due).toBeUndefined();
  });
});
