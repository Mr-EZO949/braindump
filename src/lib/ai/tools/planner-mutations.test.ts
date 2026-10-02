// plan_day plans only the session's free time: today's saved commitments plus
// the busy time the user named in chat (owner, 2026-09-30: "schedule 2:30 to
// 11pm, I have lectures 2:30–6:30" — the plan filled the lectures). The plan
// model is mocked; this checks what it is told and what the user is told.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Commitment } from "@/lib/planner/commitments";

let commitments: Commitment[] = [];
const planCalls: Array<{ busy: { free_minutes: number; lines: string[] } | null }> = [];

vi.mock("../planner", () => ({
  buildPlannerCandidates: vi.fn(async () => ({
    candidates: [{ id: "n1", title: "ML project", summary: null, body: null, node_type: "task", planning_signals: {} }],
    commitments,
  })),
}));
vi.mock("../index", () => ({
  aiProvider: () => ({
    buildPlan: vi.fn(async (input: { busy: { free_minutes: number; lines: string[] } | null }) => {
      planCalls.push({ busy: input.busy });
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

import { PLANNER_MUTATION_TOOLS } from "./planner-mutations";

const PLAN_DAY = PLANNER_MUTATION_TOOLS.find((t) => t.schema.name === "plan_day")!;
const WED = "2026-10-07";

function ctx() {
  const { client } = createFakeSupabase({ plan_sessions: [], plan_blocks: [] });
  return { supabase: client, userId: "u1", workspaceId: "w1", selectedNodeId: null, today: WED };
}

beforeEach(() => {
  commitments = [];
  planCalls.length = 0;
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
