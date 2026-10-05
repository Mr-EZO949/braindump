// The eval's own checks, offline: canned model output (parsed by the real
// validator) through the runner and the checks, so a live run's numbers mean
// what they say. No network.

import { describe, expect, it } from "vitest";

import type { AIRun, ExtractionInput, ExtractionOutput } from "@/types/ai";

import { validateExtractionOutput } from "../validation";
import { builderVariant, checkBuilder, runBuilderFixture } from "./builder";
import {
  BUILDER_FIXTURES,
  EVAL_TODAY,
  SYNTHETIC_GRAPH,
  SYNTHETIC_IDS as S,
  type BuilderFixture,
} from "./fixtures";
import { runEval, type EvalProvider } from "./run";

const fixture = (id: string): BuilderFixture => {
  const found = BUILDER_FIXTURES.find((f) => f.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};

const parse = (raw: object): ExtractionOutput =>
  validateExtractionOutput(JSON.parse(JSON.stringify(raw)), {
    workspace_id: "eval",
    user_id: "eval",
    prompt_version: "test",
    today: EVAL_TODAY,
  });

const run = (cost: number, run_type: AIRun["run_type"] = "extract"): Omit<AIRun, "id" | "created_at"> => ({
  run_type,
  provider: "claude",
  model_name: "test",
  prompt_version: "test",
  input_hash: null,
  output_hash: null,
  input_tokens: 100,
  output_tokens: 10,
  latency_ms: 1,
  estimated_cost: cost,
  status: "success",
  error_text: null,
});

// A provider that answers extractNodes from a queue of canned outputs and
// records what it was asked.
function cannedBuilder(outputs: object[]) {
  const calls: ExtractionInput[] = [];
  const provider: Pick<EvalProvider, "extractNodes"> = {
    extractNodes: async (input) => {
      calls.push(input);
      const next = outputs.shift();
      if (!next) throw new Error("no canned output left");
      return { output: parse(next), run: run(0.01) };
    },
  };
  return { provider, calls };
}

const failed = (items: ReturnType<typeof checkBuilder>) => items.filter((i) => !i.passed).map((i) => `${i.check}: ${i.label}`);

describe("fixtures", () => {
  it("each builder fixture takes the prompt it says (≤700 chars → light)", () => {
    for (const f of BUILDER_FIXTURES) expect([f.id, builderVariant(f.input)]).toEqual([f.id, f.prompt]);
  });

  it("names an existing node by its exact title wherever the subject must exist", () => {
    const titles = new Set(SYNTHETIC_GRAPH.map((n) => n.title.toLowerCase()));
    for (const f of BUILDER_FIXTURES) {
      const subjects = [
        ...(f.expect.completes ?? []),
        ...(f.expect.moves ?? []).map((m) => m.node),
        ...(f.expect.renames ?? []).map((r) => r.node),
        ...[...(f.expect.waits ?? []), ...(f.expect.applies ?? [])]
          .filter((op) => op.kind === "move" || op.kind === "update" || op.kind === "complete")
          .map((op) => op.node),
      ];
      for (const name of subjects) expect([f.id, titles.has(name.toLowerCase())]).toEqual([f.id, true]);
    }
  });
});

describe("builder checks", () => {
  it("an ideal split passes every check, and the whole reorganization waits", async () => {
    const { provider, calls } = cannedBuilder([
      {
        proposed_nodes: [
          { local_ref: "n1", proposed_title: "BrainDump", proposed_node_type: "project", existing_parent_node_id: S.moneyProjects, extraction_confidence: 0.9 },
          { local_ref: "n2", proposed_title: "Market BrainDump", proposed_node_type: "big_task", primary_parent_local_ref: "n1", extraction_confidence: 0.9 },
        ],
        changes: [
          { kind: "update", node_id: S.testMarket, title: "Test BrainDump" },
          { kind: "move", node_id: S.testMarket, new_parent: "n1" },
        ],
      },
    ]);
    const f = fixture("light-split");
    const outcome = await runBuilderFixture(f, provider);
    expect(calls).toHaveLength(1);
    expect(calls[0].variant).toBe("light");
    expect(calls[0].today).toBe(EVAL_TODAY);
    expect(calls[0].existing_nodes?.find((n) => n.id === S.testMarket)?.parent_title).toBe("Money Projects");
    expect(outcome.now).toEqual([]);
    expect(failed(checkBuilder(f, outcome))).toEqual([]);
  });

  it("catches the known bad split: the node retyped into the project, nothing created", async () => {
    const { provider } = cannedBuilder([
      { proposed_nodes: [], changes: [{ kind: "update", node_id: S.testMarket, title: "BrainDump", node_type: "project" }] },
    ]);
    const f = fixture("light-split");
    const fails = failed(checkBuilder(f, await runBuilderFixture(f, provider)));
    expect(fails).toEqual(
      expect.arrayContaining([
        'nodes: new "BrainDump" as project',
        'edits: move "Test & Market BrainDump" under "BrainDump"',
        'edits: rename "Test & Market BrainDump" to …test…',
      ]),
    );
  });

  it("reads completions, extra completions and copies of existing nodes", async () => {
    const f = fixture("light-completions");
    const good = cannedBuilder([{ proposed_nodes: [], complete_existing_node_ids: [S.gym, S.problemSet4] }]);
    expect(failed(checkBuilder(f, await runBuilderFixture(f, good.provider)))).toEqual([]);

    const bad = cannedBuilder([
      {
        proposed_nodes: [{ local_ref: "n1", proposed_title: "Renew Parking Pass", proposed_node_type: "task", extraction_confidence: 0.9 }],
        complete_existing_node_ids: [S.gym, S.statsMidterm],
      },
    ]);
    expect(failed(checkBuilder(f, await runBuilderFixture(f, bad.provider)))).toEqual([
      'completions: done: "Problem Set 4"',
      "completions: nothing else marked done",
      "no_extra: no copy of an existing node",
      'no_extra: no new node about "parking"',
      "no_extra: ≤0 new nodes",
      'policy: applies now: complete "Problem Set 4"',
    ]);
  });

  it("dates come from the user's words; a parent that can't hold the child fails nesting", async () => {
    const f = fixture("light-steps");
    const { provider } = cannedBuilder([
      {
        proposed_nodes: [
          // "friday" beats the model's wrong arithmetic (validation.ts).
          { local_ref: "n1", proposed_title: "Pick a Dataset", proposed_node_type: "task", existing_parent_node_id: S.mlProject, target_date: "2026-10-13", date_words: "friday", extraction_confidence: 0.9 },
          { local_ref: "n2", proposed_title: "Write the Proposal", proposed_node_type: "project", existing_parent_node_id: S.mlProject, date_words: "oct 20", extraction_confidence: 0.9 },
        ],
      },
    ]);
    expect(failed(checkBuilder(f, await runBuilderFixture(f, provider)))).toEqual([
      'nodes: new "proposal" as task|big_task',
      "nesting: every parent can hold its child",
    ]);
  });

  it("a long dump: the quoted request runs through the edit pass and its move waits", async () => {
    const f = fixture("full-mixed");
    const { provider, calls } = cannedBuilder([
      {
        edit_requests: ["oh and clothes reselling isn't a money project anymore, it's just me selling my old stuff — move it under life admin."],
        proposed_nodes: [
          { local_ref: "n1", proposed_title: "Portfolio Site", proposed_node_type: "project", existing_parent_node_id: S.career, extraction_confidence: 0.9, soft_links: [{ target_local_ref: S.internship, edge_type: "supports" }] },
          { local_ref: "n2", proposed_title: "Pick a Portfolio Template", proposed_node_type: "task", primary_parent_local_ref: "n1", extraction_confidence: 0.9 },
          { local_ref: "n3", proposed_title: "Write the About Page", proposed_node_type: "task", primary_parent_local_ref: "n1", extraction_confidence: 0.9 },
          { local_ref: "n4", proposed_title: "Add ML Project as a Case Study", proposed_node_type: "task", primary_parent_local_ref: "n1", extraction_confidence: 0.9 },
          { local_ref: "n5", proposed_title: "Pass This Winter's Exams", proposed_node_type: "goal", existing_parent_node_id: S.university, extraction_confidence: 0.8 },
          { local_ref: "n6", proposed_title: "Pass Probability", proposed_node_type: "goal", primary_parent_local_ref: "n5", extraction_confidence: 0.9 },
          { local_ref: "n7", proposed_title: "Pass Fuzzy Systems", proposed_node_type: "goal", primary_parent_local_ref: "n5", extraction_confidence: 0.9 },
          { local_ref: "n8", proposed_title: "Pass Deep Learning", proposed_node_type: "goal", primary_parent_local_ref: "n5", extraction_confidence: 0.9 },
          { local_ref: "n9", proposed_title: "Call the Bank About the Card Fee", proposed_node_type: "task", existing_parent_node_id: S.lifeAdmin, extraction_confidence: 0.9 },
        ],
        complete_existing_node_ids: [S.gym],
      },
      { proposed_nodes: [], changes: [{ kind: "move", node_id: S.clothes, new_parent: S.lifeAdmin }] },
    ]);
    const outcome = await runBuilderFixture(f, provider);
    expect(calls.map((c) => c.variant)).toEqual(["full", "light"]);
    expect(calls[1].raw_text).toContain("clothes reselling");
    expect(outcome.editPass).toBe("ran");
    expect(outcome.runs).toHaveLength(2);
    expect(failed(checkBuilder(f, outcome))).toEqual([]);
  });

  it("a long dump that quotes nothing passes 'quotes nothing'; one that plans an edit itself fails it", async () => {
    const f = fixture("full-scratch");
    const { provider } = cannedBuilder([{ edit_requests: ["rename stats to statistics"], proposed_nodes: [] }, { proposed_nodes: [] }]);
    const items = checkBuilder(f, await runBuilderFixture(f, provider));
    expect(items.find((i) => i.check === "edit_requests")).toMatchObject({ label: "quotes nothing", passed: false });
  });
});

describe("runEval", () => {
  const provider: EvalProvider = {
    extractNodes: async () => ({ output: parse({ proposed_nodes: [], complete_existing_node_ids: [S.gym, S.problemSet4] }), run: run(0.012) }),
    inferEdge: async (input) => ({
      output: {
        prompt_version: "test",
        results: input.candidates.map((c) => ({
          candidate_id: c.id,
          related: c.id === "c-ml",
          edge_type: c.id === "c-ml" ? ("supports" as const) : null,
          from: "source" as const,
          confidence: 0.9,
          explanation: "",
        })),
      },
      run: run(0.003, "infer_edge"),
    }),
    checkMerge: async () => ({ output: { same_entity: true, confidence: 0.9, reason: "", prompt_version: "test" }, run: run(0.001, "merge_check") }),
    buildPlan: async () => ({
      output: {
        prompt_version: "test",
        blocks: [
          { node_id: "p-dataset", title: "Pick a Dataset", start_offset: 0, duration_minutes: 60, reason: null, block_type: "focus", completion_status: "pending" },
          { node_id: null, title: "Break", start_offset: 60, duration_minutes: 10, reason: null, block_type: "break", completion_status: "pending" },
          { node_id: null, title: "Buffer", start_offset: 70, duration_minutes: 10, reason: null, block_type: "buffer", completion_status: "pending" },
        ],
      },
      run: run(0.004, "plan"),
    }),
  };

  it("adds up the cost, reports a pass rate per check, and stops at the budget", async () => {
    const report = await runEval({
      provider,
      only: ["light-completions", "edge-skill", "merge-react", "merge-part-of", "plan-busy"],
    });
    expect(report.calls).toBe(5);
    expect(report.cost_usd).toBeCloseTo(0.012 + 0.003 + 0.001 * 2 + 0.004, 6);
    expect(report.suites).toEqual([
      { suite: "builder", passed: 1, total: 1 },
      { suite: "edges", passed: 0, total: 1 },
      { suite: "merge", passed: 1, total: 2 },
      { suite: "planner", passed: 1, total: 1 },
    ]);
    expect(report.checks.find((c) => c.suite === "edges" && c.check === "related")).toMatchObject({ passed: 3, total: 4 });
    expect(report.checks.find((c) => c.suite === "merge")).toMatchObject({ check: "same_entity", passed: 1, total: 2 });

    const capped = await runEval({ provider, suites: ["builder"], maxCostUSD: 0.02 });
    expect(capped.fixtures).toHaveLength(1);
    expect(capped.skipped.length).toBe(BUILDER_FIXTURES.length - 1);
  });

  it("replays a saved report's model answers with the same verdicts, at no cost", async () => {
    const only = ["light-completions", "edge-skill", "merge-part-of", "plan-busy"];
    const saved = JSON.parse(JSON.stringify(await runEval({ provider, only })));
    const replayed = await runEval({ replay: saved, only: [...only, "light-split"] });
    expect(replayed.cost_usd).toBe(0);
    expect(replayed.calls).toBe(0);
    expect(replayed.skipped).toEqual(["builder/light-split"]);
    expect(replayed.fixtures.map((f) => [f.id, f.passed, f.items.length])).toEqual(
      saved.fixtures.map((f: { id: string; passed: boolean; items: unknown[] }) => [f.id, f.passed, f.items.length]),
    );
  });
});
