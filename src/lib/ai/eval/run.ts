// The eval runner — the fixtures in ./fixtures.ts through the real prompts,
// checked, with a pass rate per check and the measured cost. Shared by
// scripts/eval-run.ts (the usual way to run it) and POST /api/eval/run (dev).
//
// Nothing is written: no ai_runs rows, no graph. Each model call is logged as
// a structured [ai/run] line with its real price, and the report adds them up.
// A budget cap stops the run before a fixture that would cross it.

import { buildLinkStructure, selectEdgeProposals } from "@/lib/ai/edge-selection";
import { sessionBusyNote } from "@/lib/planner/commitments";

import { aiProvider } from "../index";
import { PROMPT_VERSIONS } from "../prompts";
import { EXTRACT_LIGHT_PROMPT_VERSION } from "../prompts/extract-light";
import type { AIProvider } from "../provider";
import { emitAIRunStructuredLog } from "../telemetry";

import {
  BUILDER_CHECKS,
  builderVariant,
  checkBuilder,
  runBuilderFixture,
  runFromError,
  type CheckItem,
  type ModelRun,
} from "./builder";
import {
  BUILDER_FIXTURES,
  EDGE_FIXTURES,
  EVAL_TODAY,
  MERGE_FIXTURES,
  PLANNER_FIXTURES,
  type BuilderFixture,
  type EdgeFixture,
  type MergeFixture,
  type PlannerFixture,
} from "./fixtures";

export const EVAL_SUITES = ["builder", "edges", "merge", "planner"] as const;
export type EvalSuite = (typeof EVAL_SUITES)[number];

export type EvalProvider = Pick<AIProvider, "extractNodes" | "inferEdge" | "checkMerge" | "buildPlan">;

// What a fixture usually costs (USD, measured 2026-09-30 → 10-04) — the budget
// cap uses it to stop BEFORE a fixture that would cross it.
const ROUGH_COST: Record<EvalSuite | "builder_full", number> = {
  builder: 0.015, // extract-light, Sonnet
  builder_full: 0.075, // extract-v26 (+ the edit pass when it quotes a request)
  edges: 0.005, // infer-edge, Haiku, one batch
  merge: 0.002, // merge-check, Haiku
  planner: 0.01, // plan, Haiku (≤3h)
};

export const DEFAULT_MAX_COST_USD = 0.25;

export interface FixtureResult {
  suite: EvalSuite;
  id: string;
  passed: boolean;
  items: CheckItem[];
  cost_usd: number;
  error?: string;
  // What the model produced, short, for reading a failure.
  outcome?: unknown;
  // Every provider answer, in order — lets `replay` re-check a saved run for free.
  model_outputs?: RecordedCall[];
}

export interface RecordedCall {
  method: keyof EvalProvider;
  output: unknown;
}

export interface CheckSummary {
  suite: EvalSuite;
  check: string;
  // Expectations met / checked.
  passed: number;
  total: number;
  // Fixtures where every expectation of this check was met / fixtures with it.
  fixtures_passed: number;
  fixtures_total: number;
}

export interface EvalReport {
  prompt_versions: Record<string, string>;
  today: string;
  cost_usd: number;
  calls: number;
  suites: Array<{ suite: EvalSuite; passed: number; total: number }>;
  checks: CheckSummary[];
  fixtures: FixtureResult[];
  // Fixtures not run because the budget cap would have been crossed.
  skipped: string[];
}

export interface EvalOptions {
  suites?: readonly EvalSuite[];
  // Only these fixture ids (any suite).
  only?: readonly string[];
  maxCostUSD?: number;
  provider?: EvalProvider;
  // Re-check the model outputs a saved report recorded, with today's checks:
  // no model call, no cost. For when a check (not the model) was wrong.
  replay?: EvalReport;
  onProgress?: (line: string) => void;
}

export function selectFixtures(options: Pick<EvalOptions, "suites" | "only"> = {}) {
  const suites = new Set(options.suites ?? EVAL_SUITES);
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const pick = <T extends { id: string }>(suite: EvalSuite, list: T[]) =>
    suites.has(suite) ? list.filter((f) => !only || only.has(f.id)) : [];
  return {
    builder: pick("builder", BUILDER_FIXTURES),
    edges: pick("edges", EDGE_FIXTURES),
    merge: pick("merge", MERGE_FIXTURES),
    planner: pick("planner", PLANNER_FIXTURES),
  };
}

export async function runEval(options: EvalOptions = {}): Promise<EvalReport> {
  const replay = options.replay ?? null;
  const provider = replay ? null : (options.provider ?? aiProvider());
  const maxCost = options.maxCostUSD ?? DEFAULT_MAX_COST_USD;
  const progress = options.onProgress ?? (() => undefined);
  const fixtures = selectFixtures(options);

  let spent = 0;
  let calls = 0;
  const results: FixtureResult[] = [];
  const skipped: string[] = [];

  const record = (runs: ModelRun[]) => {
    if (replay) return 0;
    let cost = 0;
    for (const run of runs) {
      calls += 1;
      cost += run.estimated_cost ?? 0;
      emitAIRunStructuredLog({ source: "eval", workspaceId: "eval", run: { ...run, status: run.status ?? "success" } });
    }
    spent += cost;
    return cost;
  };

  // One fixture: its model call(s), its checks, its cost — or why it failed.
  const runOne = async (
    suite: EvalSuite,
    id: string,
    roughCost: number,
    body: (provider: EvalProvider) => Promise<{ items: CheckItem[]; runs: ModelRun[]; outcome?: unknown }>,
  ) => {
    const calls: RecordedCall[] = [];
    const fixtureProvider = replay ? replayProvider(replay, suite, id) : provider && recordingProvider(provider, calls);
    if (!fixtureProvider) {
      skipped.push(`${suite}/${id}`);
      progress(`skip ${suite}/${id} — not in the saved report`);
      return;
    }
    if (!replay && spent + roughCost > maxCost) {
      skipped.push(`${suite}/${id}`);
      progress(`skip ${suite}/${id} — budget ($${spent.toFixed(4)} spent of $${maxCost})`);
      return;
    }
    const model_outputs = replay ? replay.fixtures.find((f) => f.suite === suite && f.id === id)?.model_outputs : calls;
    try {
      const { items, runs, outcome } = await body(fixtureProvider);
      const cost = record(runs);
      const passed = items.every((item) => item.passed);
      results.push({ suite, id, passed, items, cost_usd: round(cost), outcome, model_outputs });
      const failed = items.filter((item) => !item.passed).length;
      progress(`${passed ? "pass" : "FAIL"} ${suite}/${id} — ${items.length - failed}/${items.length} · $${cost.toFixed(4)}`);
    } catch (err) {
      const paid = runFromError(err);
      const cost = record(paid ? [paid] : []);
      const message = err instanceof Error ? err.message : String(err);
      results.push({ suite, id, passed: false, items: [], cost_usd: round(cost), error: message, model_outputs });
      progress(`ERROR ${suite}/${id} — ${message}`);
    }
  };

  for (const fixture of fixtures.builder) {
    const rough = builderVariant(fixture.input) === "full" ? ROUGH_COST.builder_full : ROUGH_COST.builder;
    await runOne("builder", fixture.id, rough, (p) => evalBuilder(fixture, p));
  }
  for (const fixture of fixtures.edges) {
    await runOne("edges", fixture.id, ROUGH_COST.edges, (p) => evalEdges(fixture, p));
  }
  for (const fixture of fixtures.merge) {
    await runOne("merge", fixture.id, ROUGH_COST.merge, (p) => evalMerge(fixture, p));
  }
  for (const fixture of fixtures.planner) {
    await runOne("planner", fixture.id, ROUGH_COST.planner, (p) => evalPlanner(fixture, p));
  }

  return {
    prompt_versions: { ...PROMPT_VERSIONS, extract_light: EXTRACT_LIGHT_PROMPT_VERSION },
    today: EVAL_TODAY,
    cost_usd: round(spent),
    calls,
    suites: summarizeSuites(results),
    checks: summarizeChecks(results),
    fixtures: results,
    skipped,
  };
}

// The real provider, with every answer kept for the report.
function recordingProvider(provider: EvalProvider, calls: RecordedCall[]): EvalProvider {
  const keep = <T extends { output: unknown }>(method: keyof EvalProvider, result: T): T => {
    calls.push({ method, output: result.output });
    return result;
  };
  return {
    extractNodes: async (input) => keep("extractNodes", await provider.extractNodes(input)),
    inferEdge: async (input) => keep("inferEdge", await provider.inferEdge(input)),
    checkMerge: async (input) => keep("checkMerge", await provider.checkMerge(input)),
    buildPlan: async (input) => keep("buildPlan", await provider.buildPlan(input)),
  };
}

// The answers a saved report recorded for one fixture, in order, at no cost.
function replayProvider(report: EvalReport, suite: EvalSuite, id: string): EvalProvider | null {
  const saved = report.fixtures.find((f) => f.suite === suite && f.id === id);
  if (!saved?.model_outputs) return null;
  const queue = [...saved.model_outputs];
  const next = <T>(method: keyof EvalProvider): T => {
    const call = queue.shift();
    if (!call || call.method !== method) throw new Error(`replay: no saved ${method} answer`);
    return call.output as T;
  };
  const free = (run_type: ModelRun["run_type"]): ModelRun => ({
    run_type,
    provider: "replay",
    model_name: "replay",
    prompt_version: "replay",
    input_hash: null,
    output_hash: null,
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    estimated_cost: 0,
    status: "success",
    error_text: null,
  });
  return {
    extractNodes: async () => ({ output: next("extractNodes"), run: free("extract") }),
    inferEdge: async () => ({ output: next("inferEdge"), run: free("infer_edge") }),
    checkMerge: async () => ({ output: next("checkMerge"), run: free("merge_check") }),
    buildPlan: async () => ({ output: next("buildPlan"), run: free("plan") }),
  };
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

export function summarizeSuites(results: FixtureResult[]): EvalReport["suites"] {
  return EVAL_SUITES.flatMap((suite) => {
    const mine = results.filter((r) => r.suite === suite);
    return mine.length > 0 ? [{ suite, passed: mine.filter((r) => r.passed).length, total: mine.length }] : [];
  });
}

// Pass rate per check, in a stable order (the builder's checks first, in the
// order they are documented). A fixture that errored counts as failing every
// check its suite has.
export function summarizeChecks(results: FixtureResult[]): CheckSummary[] {
  const order: string[] = [...BUILDER_CHECKS, "related", "type_direction", "same_entity", "scheduled", "blocked", "structure", "busy"];
  const rows = new Map<string, CheckSummary>();
  const row = (suite: EvalSuite, check: string) => {
    const key = `${suite}/${check}`;
    if (!rows.has(key)) rows.set(key, { suite, check, passed: 0, total: 0, fixtures_passed: 0, fixtures_total: 0 });
    return rows.get(key)!;
  };
  for (const result of results) {
    const byCheck = new Map<string, CheckItem[]>();
    for (const item of result.items) byCheck.set(item.check, [...(byCheck.get(item.check) ?? []), item]);
    if (result.error) {
      const r = row(result.suite, "error");
      r.total += 1;
      r.fixtures_total += 1;
      continue;
    }
    for (const [check, items] of byCheck) {
      const r = row(result.suite, check);
      r.passed += items.filter((i) => i.passed).length;
      r.total += items.length;
      r.fixtures_total += 1;
      if (items.every((i) => i.passed)) r.fixtures_passed += 1;
    }
  }
  const rank = (check: string) => (order.includes(check) ? order.indexOf(check) : order.length);
  return [...rows.values()].sort(
    (a, b) => EVAL_SUITES.indexOf(a.suite) - EVAL_SUITES.indexOf(b.suite) || rank(a.check) - rank(b.check),
  );
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

async function evalBuilder(fixture: BuilderFixture, provider: EvalProvider) {
  const outcome = await runBuilderFixture(fixture, provider);
  const items = checkBuilder(fixture, outcome);
  const label = (op: (typeof outcome.ops)[number]) => JSON.stringify(op);
  return {
    items,
    runs: outcome.runs,
    outcome: {
      variant: outcome.variant,
      edit_requests: outcome.editRequests,
      edit_pass: outcome.editPass,
      questions: outcome.questions,
      broken: outcome.broken,
      applies_now: outcome.now.map(label),
      waits: outcome.ask.map(label),
    },
  };
}

const EVAL_SOURCE_ID = "eval-source";

async function evalEdges(fixture: EdgeFixture, provider: EvalProvider) {
  const result = await provider.inferEdge({
    source_node: {
      id: EVAL_SOURCE_ID,
      title: fixture.source.title,
      summary: fixture.source.summary,
      node_type: fixture.source.node_type,
      has_parent: fixture.source.has_parent,
    },
    candidates: fixture.candidates.map(({ id, title, summary, node_type }) => ({ id, title, summary, node_type })),
  });
  // What connection.ts would propose from these verdicts.
  const selected = selectEdgeProposals({
    sourceId: EVAL_SOURCE_ID,
    sourceType: fixture.source.node_type,
    sourceHasParent: fixture.source.has_parent,
    results: result.output.results,
    candidateTypeById: new Map(fixture.candidates.map((c) => [c.id, c.node_type])),
    titleById: new Map([[EVAL_SOURCE_ID, fixture.source.title], ...fixture.candidates.map((c) => [c.id, c.title] as [string, string])]),
    structure: fixture.graph
      ? buildLinkStructure({
          edges: fixture.graph.map((e) => ({
            source_node_id: e.source === "source" ? EVAL_SOURCE_ID : e.source,
            target_node_id: e.target === "source" ? EVAL_SOURCE_ID : e.target,
            edge_type: e.edge_type,
          })),
          nodeTypes: new Map<string, string | null>(Object.entries(fixture.graph_types ?? {})),
        })
      : undefined,
  });

  const items: CheckItem[] = [];
  for (const candidate of fixture.candidates) {
    const proposal = selected.find((p) => p.source_node_id === candidate.id || p.target_node_id === candidate.id);
    const verdict = result.output.results.find((r) => r.candidate_id === candidate.id);
    const said = verdict
      ? `model: ${verdict.related ? `${verdict.edge_type} from ${verdict.from} (${verdict.confidence})` : "unrelated"}; proposed: ${
          proposal ? `${proposal.source_node_id === EVAL_SOURCE_ID ? "source" : "candidate"} -${proposal.edge_type}->` : "nothing"
        }`
      : "no verdict returned";
    const want = candidate.expect;
    items.push({
      check: "related",
      label: `"${candidate.title}" ${want ? "linked" : "not linked"}`,
      passed: want ? !!proposal : !proposal,
      ...(want ? (proposal ? {} : { detail: said }) : proposal ? { detail: said } : {}),
    });
    if (want) {
      const fromSource = proposal?.source_node_id === EVAL_SOURCE_ID;
      const ok = !!proposal && want.types.includes(proposal.edge_type) && fromSource === (want.from === "source");
      items.push({
        check: "type_direction",
        label: `"${candidate.title}": ${want.types.join("|")} from ${want.from}`,
        passed: ok,
        ...(ok ? {} : { detail: said }),
      });
    }
  }
  return {
    items,
    runs: [result.run],
    outcome: selected.map((p) => `${p.source_node_id} -${p.edge_type} (${p.confidence})-> ${p.target_node_id}`),
  };
}

async function evalMerge(fixture: MergeFixture, provider: EvalProvider) {
  const result = await provider.checkMerge({
    new_node: { title: fixture.node_a_title, summary: fixture.node_a_summary, node_type: fixture.node_a_type },
    existing_node: { title: fixture.node_b_title, summary: fixture.node_b_summary, node_type: fixture.node_b_type },
    similarity: fixture.similarity,
  });
  const out = result.output;
  const passed = out.same_entity === fixture.expected_same_entity;
  return {
    items: [
      {
        check: "same_entity",
        label: `"${fixture.node_a_title}" vs "${fixture.node_b_title}": ${fixture.expected_same_entity ? "same" : "different"}`,
        passed,
        ...(passed ? {} : { detail: `said ${out.same_entity ? "same" : "different"} (${out.confidence}): ${out.reason}` }),
      },
    ],
    runs: [result.run],
  };
}

async function evalPlanner(fixture: PlannerFixture, provider: EvalProvider) {
  const busy = fixture.busy
    ? sessionBusyNote(fixture.busy, fixture.session_start_minute, fixture.session_minutes)
    : null;
  const result = await provider.buildPlan({
    planning_window: fixture.planning_window,
    custom_minutes: fixture.planning_window === "custom" ? fixture.session_minutes : null,
    session_minutes: fixture.session_minutes,
    session_start_minute: fixture.session_start_minute,
    candidate_nodes: fixture.candidates,
    busy,
  });
  const blocks = result.output.blocks;
  const shown = blocks.map((b) => `${b.title} (${b.block_type}, ${b.duration_minutes}m${b.node_id ? `, ${b.node_id}` : ""})`);
  const plan = shown.join("; ");
  const items: CheckItem[] = [];
  const add = (check: string, label: string, passed: boolean) =>
    items.push({ check, label, passed, ...(passed ? {} : { detail: plan }) });

  for (const id of fixture.expect.scheduled) {
    const title = fixture.candidates.find((c) => c.id === id)?.title ?? id;
    add("scheduled", `"${title}" gets a block`, blocks.some((b) => b.node_id === id));
  }
  for (const id of fixture.expect.not_scheduled ?? []) {
    const title = fixture.candidates.find((c) => c.id === id)?.title ?? id;
    add("blocked", `no focus block for blocked "${title}"`, !blocks.some((b) => b.node_id === id && b.block_type === "focus"));
  }
  const candidateIds = new Set(fixture.candidates.map((c) => c.id));
  if (fixture.expect.expect_break) add("structure", "has a break", blocks.some((b) => b.block_type === "break"));
  add("structure", "ends with a buffer", blocks.at(-1)?.block_type === "buffer");
  add(
    "structure",
    "breaks and buffers carry no node",
    blocks.every((b) => (b.block_type !== "break" && b.block_type !== "buffer") || b.node_id === null),
  );
  add("structure", "only real node ids", blocks.every((b) => b.node_id === null || candidateIds.has(b.node_id)));
  if (busy) {
    const planned = blocks.reduce((sum, b) => sum + b.duration_minutes, 0);
    add("busy", `fits the ${busy.free_minutes} free minutes`, planned <= busy.free_minutes);
    const busyTitles = (fixture.busy ?? []).map((b) => b.title.toLowerCase());
    add("busy", "no block for the busy time", !blocks.some((b) => busyTitles.some((t) => b.title.toLowerCase().includes(t))));
  }
  return { items, runs: [result.run], outcome: shown };
}
