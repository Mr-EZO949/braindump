import { describe, expect, it } from "vitest";

import { buildPlanPromptParts } from "./plan";

const base = {
  planning_window: "day",
  total_minutes: 900,
  candidate_nodes: [{ id: "cv", title: "Update CV", summary: null, node_type: "task" }],
  session_span: "08:00–23:00",
};

describe("plan prompt (plan-v8)", () => {
  it("a plan with no time blocks or requests lists its items exactly as before", () => {
    const { variableBlock } = buildPlanPromptParts(base);
    expect(variableBlock).toBe(
      `Session:\nPlanning window: day (900 minutes total, session 08:00–23:00)\n\nAvailable work items:\n- [task] "Update CV" (id: cv)`,
    );
  });

  it("lists time blocks with where to start, and what the user asked for", () => {
    const { variableBlock } = buildPlanPromptParts({
      ...base,
      time_blocks: [
        {
          id: "it",
          title: "Italian Crash Course",
          node_type: "big_task",
          open_steps: 3,
          start_with: ["Learn greetings", "Numbers"],
          planning_signals: ["You asked for 3h"],
        },
        { id: "ml", title: "Machine Learning", node_type: "class", open_steps: 0, start_with: [] },
      ],
      requests: [
        { text: "3h of Italian", minutes: 180, node_id: "it", title: "Italian Crash Course", node_type: "big_task" },
        { text: "2h of math", minutes: 120, node_id: null, title: null, node_type: null },
      ],
    });
    expect(variableBlock).toContain(
      `- [big_task] "Italian Crash Course" — 3 open steps; start with "Learn greetings", then "Numbers". Signals: You asked for 3h. (id: it)`,
    );
    expect(variableBlock).toContain(`- [class] "Machine Learning" — no open steps. (id: ml)`);
    expect(variableBlock).toContain(`- "3h of Italian" → 180 min on [big_task] "Italian Crash Course" (id: it)`);
    expect(variableBlock).toContain(`- "2h of math" → 120 min; no item matched by name`);
  });
});
