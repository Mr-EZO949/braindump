// The eval, from the command line — no dev server, no database, nothing
// written. Synthetic fixtures in src/lib/ai/eval/fixtures.ts through the real
// prompts; prints the pass rate per check, every failure, and the cost.
//
//   npx tsx --env-file=.env.local scripts/eval-run.ts                 # everything (~$0.2)
//   npx tsx --env-file=.env.local scripts/eval-run.ts --suite builder --only light-split
//   npx tsx --env-file=.env.local scripts/eval-run.ts --estimate      # builder input tokens, free
//   npx tsx scripts/eval-run.ts --replay report.json                  # re-check a saved run, free
//
// Flags: --suite builder,edges,merge,planner · --only <fixture ids> ·
// --max-cost <USD, default 0.25> · --out <report.json> · --estimate ·
// --replay <report.json> (today's checks on the model answers a saved report
// recorded — for when a check, not the model, was wrong)

import { readFileSync, writeFileSync } from "fs";

import Anthropic from "@anthropic-ai/sdk";

import { AI_COST_PER_1M_TOKENS, AI_MODELS } from "../src/lib/ai/config";
import { builderVariant, type CheckItem } from "../src/lib/ai/eval/builder";
import { EVAL_TODAY, SYNTHETIC_GRAPH } from "../src/lib/ai/eval/fixtures";
import {
  DEFAULT_MAX_COST_USD,
  EVAL_SUITES,
  runEval,
  selectFixtures,
  type EvalReport,
  type EvalSuite,
} from "../src/lib/ai/eval/run";
import { buildExtractionPromptParts } from "../src/lib/ai/prompts/extract";
import { buildLightExtractionPromptParts } from "../src/lib/ai/prompts/extract-light";

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : "";
}
const listFlag = (name: string) => (flag(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const suites = (() => {
  const asked = listFlag("suite");
  if (asked.length === 0 || asked.includes("all")) return [...EVAL_SUITES];
  const bad = asked.filter((s) => !(EVAL_SUITES as readonly string[]).includes(s));
  if (bad.length > 0) throw new Error(`unknown suite: ${bad.join(", ")} (use ${EVAL_SUITES.join(", ")})`);
  return asked as EvalSuite[];
})();
const only = listFlag("only");
const maxCost = Number(flag("max-cost") ?? DEFAULT_MAX_COST_USD) || DEFAULT_MAX_COST_USD;

// Input tokens of each builder call, counted for free (messages.countTokens),
// with a typical output length → a cost estimate before spending anything.
async function estimate() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const titleById = new Map(SYNTHETIC_GRAPH.map((n) => [n.id, n.title]));
  const OUT = { light: 400, full: 3000 }; // typical output tokens, on the high side (ai_runs, 2026-09-30 → 10-03)
  let total = 0;
  for (const fixture of selectFixtures({ suites: ["builder"], only }).builder) {
    const variant = builderVariant(fixture.input);
    const params = {
      raw_text: fixture.input,
      workspace_id: "eval",
      user_id: "eval",
      today: EVAL_TODAY,
      existing_nodes:
        fixture.graph === "synthetic"
          ? SYNTHETIC_GRAPH.map((n) => ({
              id: n.id,
              title: n.title,
              summary: n.summary ?? null,
              node_type: n.node_type,
              parent_title: n.parent ? (titleById.get(n.parent) ?? null) : null,
            }))
          : [],
    };
    const { rubricBlock, variableBlock } =
      variant === "light" ? buildLightExtractionPromptParts(params) : buildExtractionPromptParts(params);
    const counted = await client.messages.countTokens({
      model: AI_MODELS.CLAUDE_SONNET,
      system: "You always respond with valid JSON only.",
      messages: [{ role: "user", content: `${rubricBlock}\n\n${variableBlock}` }],
    });
    const editPass = fixture.expect.edit_requests ? 1 : 0;
    const usd =
      ((counted.input_tokens + editPass * 4000) * AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_INPUT +
        (OUT[variant] + editPass * 400) * AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_OUTPUT) /
      1e6;
    total += usd;
    console.log(`${fixture.id.padEnd(20)} ${variant.padEnd(5)} ${String(counted.input_tokens).padStart(6)} in${editPass ? " + edit pass" : ""} ≈ $${usd.toFixed(4)}`);
  }
  const fixtures = selectFixtures({ suites, only });
  const rest = fixtures.edges.length * 0.005 + fixtures.merge.length * 0.002 + fixtures.planner.length * 0.01;
  console.log(`builder ≈ $${total.toFixed(3)} · edges/merge/planner ≈ $${rest.toFixed(3)} · total ≈ $${(total + rest).toFixed(3)}`);
}

function printReport(report: EvalReport, replay: boolean) {
  console.log("\n=== Prompt versions ===");
  console.log(Object.entries(report.prompt_versions).map(([k, v]) => `${k}: ${v}`).join(" · "));

  console.log("\n=== Pass rate per check (expectations met · fixtures fully passing) ===");
  for (const row of report.checks) {
    const pct = row.total > 0 ? Math.round((row.passed / row.total) * 100) : 0;
    console.log(
      `${`${row.suite}/${row.check}`.padEnd(24)} ${`${row.passed}/${row.total}`.padStart(7)} ${`${pct}%`.padStart(5)}   fixtures ${row.fixtures_passed}/${row.fixtures_total}`,
    );
  }

  console.log("\n=== Fixtures ===");
  for (const suite of report.suites) console.log(`${suite.suite.padEnd(8)} ${suite.passed}/${suite.total} fixtures pass`);

  const failures = report.fixtures.filter((f) => !f.passed);
  if (failures.length > 0) {
    console.log("\n=== Failures ===");
    for (const f of failures) {
      console.log(`\n${f.suite}/${f.id} ($${f.cost_usd.toFixed(4)})${f.error ? ` — ERROR: ${f.error}` : ""}`);
      for (const item of f.items.filter((i: CheckItem) => !i.passed)) {
        console.log(`  ✗ [${item.check}] ${item.label}${item.detail ? `\n      ${item.detail}` : ""}`);
      }
    }
  }
  if (report.skipped.length > 0) console.log(`\nSkipped (budget): ${report.skipped.join(", ")}`);
  console.log(
    replay
      ? `\nReplayed the saved model answers — no model calls, $0.`
      : `\nCost: $${report.cost_usd.toFixed(4)} over ${report.calls} model calls (cap $${maxCost})`,
  );
}

async function main() {
  if (process.argv.includes("--estimate")) {
    await estimate();
    return;
  }
  const replayPath = flag("replay");
  const replay = replayPath ? (JSON.parse(readFileSync(replayPath, "utf8")) as EvalReport) : undefined;
  const report = await runEval({
    suites,
    only,
    maxCostUSD: maxCost,
    replay,
    onProgress: (line) => console.error(line),
  });
  printReport(report, !!replay);
  const out = flag("out");
  if (out) {
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`Report: ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
