// POST /api/eval/run
// Dev-only eval harness — runs extraction, edge inference, assistant, and planner
// against fixtures and returns a pass/fail report with prompt versions.
// Use before and after prompt changes as a regression check.
// Blocked in production (NODE_ENV check).
// Query params:
//   ?suite=all (default) | extraction | edges | assistant | planner

import { NextRequest, NextResponse } from "next/server";
import { aiProvider } from "@/lib/ai";
import { ClaudeProvider } from "@/lib/ai/claude";
import { AI_MODELS } from "@/lib/ai/config";
import {
  BRAIN_DUMP_FIXTURES,
  EDGE_FIXTURES,
  ASSISTANT_FIXTURES,
  PLANNER_FIXTURES,
  MERGE_FIXTURES,
} from "@/lib/ai/eval/fixtures";
import { PROMPT_VERSIONS } from "@/lib/ai/prompts";
import { emitAIRunStructuredLog } from "@/lib/ai/telemetry";

// ---------------------------------------------------------------------------
// Release gates — minimum pass rates per suite before a prompt/model change
// can be considered safe to ship. Checked at the end of every eval run.
// ---------------------------------------------------------------------------
const RELEASE_GATES = {
  extraction: 0.65,
  edges: 0.70,
  assistant: 0.75,
  planner: 0.75,
  merge: 0.70,
  overall: 0.70,
} as const;

type ExtractionResult = {
  fixture_id: string;
  input: string;
  passed: boolean;
  missing_nodes: string[];
  missing_links: string[];
  extracted_titles: string[];
  extracted_relations: string[];
  error?: string;
};

type EdgeResult = {
  fixture_id: string;
  passed: boolean;
  expected_related: boolean;
  actual_related: boolean;
  expected_edge_type?: string;
  actual_edge_type: string | null;
  confidence: number;
  explanation?: string;
  error?: string;
};

type AssistantResult = {
  fixture_id: string;
  mode: string;
  passed: boolean;
  missing_terms: string[];
  forbidden_terms: string[];
  answer_preview: string;
  error?: string;
};

type PlannerResult = {
  fixture_id: string;
  passed: boolean;
  block_count: number;
  missing_titles: string[];
  has_break: boolean;
  has_buffer: boolean;
  fits_window?: boolean;
  window_minutes?: number;
  total_minutes_planned: number;
  block_titles: string[];
  error?: string;
};

type MergeResult = {
  fixture_id: string;
  passed: boolean;
  expected_same_entity: boolean;
  actual_same_entity: boolean;
  confidence: number;
  reason: string;
  error?: string;
};

type GateResult = {
  suite: string;
  pass_rate: number;
  threshold: number;
  gate_passed: boolean;
};

type Suite = "all" | "extraction" | "edges" | "assistant" | "planner" | "merge";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  const suite = (req.nextUrl.searchParams.get("suite") ?? "all") as Suite;

  // Model comparison: ?model=haiku uses Claude Haiku instead of Sonnet.
  // Run the eval twice (once per model) and compare results manually.
  // Example: POST /api/eval/run?model=haiku
  const modelParam = req.nextUrl.searchParams.get("model");
  const modelName =
    modelParam === "haiku"
      ? "claude-haiku-4-5-20251001"
      : modelParam === "sonnet"
        ? AI_MODELS.CLAUDE_SONNET
        : null; // null = use default registered provider

  // Build a provider scoped to the requested model (or fall back to the shared default).
  const provider = modelName
    ? (() => {
        const claudeKey = process.env.ANTHROPIC_API_KEY;
        if (!claudeKey) throw new Error("ANTHROPIC_API_KEY not set");
        const claude = new ClaudeProvider(claudeKey, modelName);
        // Wrap to satisfy AIProvider interface (embedding/rerank fall back to defaults)
        const base = aiProvider();
        return {
          extractNodes: (i: Parameters<typeof claude.extractNodes>[0]) => claude.extractNodes(i),
          inferEdge: (i: Parameters<typeof claude.inferEdge>[0]) => claude.inferEdge(i),
          answerAssistant: (i: Parameters<typeof claude.answerAssistant>[0]) => claude.answerAssistant(i),
          buildPlan: (i: Parameters<typeof claude.buildPlan>[0]) => claude.buildPlan(i),
          checkMerge: (i: Parameters<typeof claude.checkMerge>[0]) => claude.checkMerge(i),
          generateEmbedding: base.generateEmbedding.bind(base),
          rerankCandidates: base.rerankCandidates.bind(base),
        };
      })()
    : aiProvider();

  const report: {
    model: string;
    prompt_versions: typeof PROMPT_VERSIONS;
    extraction: ExtractionResult[];
    edges: EdgeResult[];
    assistant: AssistantResult[];
    planner: PlannerResult[];
    merge: MergeResult[];
    summary: { total: number; passed: number; failed: number; pass_rate: string };
    release_gates: GateResult[];
    gates_passed: boolean;
  } = {
    model: modelName ?? AI_MODELS.CLAUDE_SONNET,
    prompt_versions: PROMPT_VERSIONS,
    extraction: [],
    edges: [],
    assistant: [],
    planner: [],
    merge: [],
    summary: { total: 0, passed: 0, failed: 0, pass_rate: "0%" },
    release_gates: [],
    gates_passed: false,
  };

  // ---------------------------------------------------------------------------
  // Extraction eval
  // ---------------------------------------------------------------------------
  if (suite === "all" || suite === "extraction") {
    for (const fixture of BRAIN_DUMP_FIXTURES) {
      try {
        const result = await provider.extractNodes({
          raw_text: fixture.input,
          workspace_id: "eval",
          user_id: "eval",
        });
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            ...result.run,
            status: "success",
            error_text: null,
          },
        });
        const extractedNodes = result.output.proposed_nodes;

        const missingNodes = fixture.expected_nodes
          .filter(
            (exp) =>
              !extractedNodes.some(
                (node) =>
                  node.proposed_title.toLowerCase().includes(exp.title_contains.toLowerCase()) &&
                  node.proposed_node_type === exp.node_type,
              ),
          )
          .map((exp) => `${exp.title_contains} (${exp.node_type})`);

        const nodeByLocalRef = new Map(
          extractedNodes.map((node) => [node.local_ref ?? "", node]),
        );

        const extractedRelations = extractedNodes.flatMap((node) => {
          const relations: string[] = [];

          if (node.primary_parent_local_ref) {
            const parent = nodeByLocalRef.get(node.primary_parent_local_ref);
            if (parent) {
              relations.push(`${node.proposed_title} -belongs_to-> ${parent.proposed_title}`);
            }
          }

          for (const dependencyRef of node.depends_on_local_refs) {
            const dependency = nodeByLocalRef.get(dependencyRef);
            if (dependency) {
              relations.push(`${dependency.proposed_title} -required_for-> ${node.proposed_title}`);
            }
          }

          for (const softLink of node.soft_links) {
            const target = nodeByLocalRef.get(softLink.target_local_ref);
            if (target) {
              relations.push(`${node.proposed_title} -${softLink.edge_type}-> ${target.proposed_title}`);
            }
          }

          return relations;
        });

        const missingLinks = (fixture.expected_links ?? [])
          .filter((expectedLink) => {
            const sourceNeedle = expectedLink.source_title_contains.toLowerCase();
            const targetNeedle = expectedLink.target_title_contains.toLowerCase();

            return !extractedRelations.some((relation) => {
              const lower = relation.toLowerCase();
              const matchesTitles = lower.includes(sourceNeedle) && lower.includes(targetNeedle);
              if (!matchesTitles) return false;

              if (!expectedLink.edge_types || expectedLink.edge_types.length === 0) return true;

              return expectedLink.edge_types.some((edgeType) =>
                lower.includes(`-${edgeType.toLowerCase()}->`),
              );
            });
          })
          .map((expectedLink) => {
            const edgeLabel = expectedLink.edge_types?.join(" | ") ?? "any";
            return `${expectedLink.source_title_contains} -${edgeLabel}-> ${expectedLink.target_title_contains}`;
          });

        const passed = missingNodes.length === 0 && missingLinks.length === 0;
        report.extraction.push({
          fixture_id: fixture.id,
          input: fixture.input.slice(0, 80),
          passed,
          missing_nodes: missingNodes,
          missing_links: missingLinks,
          extracted_titles: extractedNodes.map((n) => n.proposed_title),
          extracted_relations: extractedRelations,
        });
      } catch (error) {
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            run_type: "extract",
            provider: "claude",
            model_name: AI_MODELS.CLAUDE_SONNET,
            prompt_version: PROMPT_VERSIONS.extract,
            status: "failed",
            error_text: error instanceof Error ? error.message : "Unknown extraction error",
          },
        });
        report.extraction.push({
          fixture_id: fixture.id,
          input: fixture.input.slice(0, 80),
          passed: false,
          missing_nodes: ["[extraction error]"],
          missing_links: [],
          extracted_titles: [],
          extracted_relations: [],
          error: error instanceof Error ? error.message : "Unknown extraction error",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Edge inference eval
  // ---------------------------------------------------------------------------
  if (suite === "all" || suite === "edges") {
    for (const fixture of EDGE_FIXTURES) {
      try {
        const result = await provider.inferEdge({
          source_node: {
            id: "eval-src",
            title: fixture.source_title,
            summary: fixture.source_summary,
          },
          candidates: [
            {
              id: "eval-tgt",
              title: fixture.target_title,
              summary: fixture.target_summary,
            },
          ],
        });
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            ...result.run,
            status: "success",
            error_text: null,
          },
        });

        const entry = result.output.results.find((r) => r.candidate_id === "eval-tgt")
          ?? { related: false, edge_type: null, confidence: 0, explanation: "" };
        const relatedMatch = entry.related === fixture.expected_related;
        const typeMatch =
          !fixture.expected_edge_type || !entry.related || entry.edge_type === fixture.expected_edge_type;
        const passed = relatedMatch && typeMatch;

        report.edges.push({
          fixture_id: fixture.id,
          passed,
          expected_related: fixture.expected_related,
          actual_related: entry.related,
          expected_edge_type: fixture.expected_edge_type,
          actual_edge_type: entry.edge_type ?? null,
          confidence: entry.confidence,
          explanation: entry.explanation,
        });
      } catch (error) {
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            run_type: "infer_edge",
            provider: "claude",
            model_name: AI_MODELS.CLAUDE_SONNET,
            prompt_version: PROMPT_VERSIONS.infer_edge,
            status: "failed",
            error_text: error instanceof Error ? error.message : "Unknown edge inference error",
          },
        });
        report.edges.push({
          fixture_id: fixture.id,
          passed: false,
          expected_related: fixture.expected_related,
          actual_related: false,
          actual_edge_type: null,
          confidence: 0,
          error: error instanceof Error ? error.message : "Unknown edge inference error",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Assistant eval
  // ---------------------------------------------------------------------------
  if (suite === "all" || suite === "assistant") {
    for (const fixture of ASSISTANT_FIXTURES) {
      try {
        const result = await provider.answerAssistant({
          message: fixture.message,
          context: fixture.context,
          scope: fixture.scope,
          mode: fixture.mode,
        });
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            ...result.run,
            prompt_version: `${PROMPT_VERSIONS.assistant}:${fixture.mode}`,
            status: "success",
            error_text: null,
          },
        });

        const answer = result.output.answer.toLowerCase();

        const missingTerms = fixture.answer_must_contain.filter(
          (term) => !answer.includes(term.toLowerCase()),
        );

        const forbiddenTerms = (fixture.answer_must_not_contain ?? []).filter((term) =>
          answer.includes(term.toLowerCase()),
        );

        const passed = missingTerms.length === 0 && forbiddenTerms.length === 0;

        report.assistant.push({
          fixture_id: fixture.id,
          mode: fixture.mode,
          passed,
          missing_terms: missingTerms,
          forbidden_terms: forbiddenTerms,
          answer_preview: result.output.answer.slice(0, 200),
        });
      } catch (error) {
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            run_type: "assistant",
            provider: "claude",
            model_name: AI_MODELS.CLAUDE_SONNET,
            prompt_version: `${PROMPT_VERSIONS.assistant}:${fixture.mode}`,
            status: "failed",
            error_text: error instanceof Error ? error.message : "Unknown assistant error",
          },
        });
        report.assistant.push({
          fixture_id: fixture.id,
          mode: fixture.mode,
          passed: false,
          missing_terms: ["[error]"],
          forbidden_terms: [],
          answer_preview: "",
          error: error instanceof Error ? error.message : "Unknown assistant error",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Planner eval
  // ---------------------------------------------------------------------------
  if (suite === "all" || suite === "planner") {
    for (const fixture of PLANNER_FIXTURES) {
      try {
        const result = await provider.buildPlan({
          planning_window: fixture.planning_window,
          candidate_nodes: fixture.candidate_nodes,
        });
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            ...result.run,
            status: "success",
            error_text: null,
          },
        });

        const blocks = result.output.blocks;
        const blockTitles = blocks.map((b) => b.title.toLowerCase());
        const blockTypes = blocks.map((b) => b.block_type);
        const totalMinutes = blocks.reduce((sum, b) => sum + b.duration_minutes, 0);

        const missingTitles = fixture.expected_block_titles.filter(
          (needle) => !blockTitles.some((title) => title.includes(needle.toLowerCase())),
        );

        const hasBreak = blockTypes.includes("break");
        const hasBuffer = blockTypes.includes("buffer");

        // The plan should fit its window: the LAST block must end by the window
        // (validatePlanOutput already clamps each block; this catches a plan that
        // overflows in aggregate). Measure the schedule SPAN — max end offset —
        // not the duration sum, so a trailing in-window buffer doesn't misfire.
        const windowCap = fixture.total_minutes;
        const span = blocks.reduce((m, b) => Math.max(m, b.start_offset + b.duration_minutes), 0);
        const fitsWindow = span <= windowCap;

        const checks = [
          blocks.length >= fixture.min_blocks,
          missingTitles.length === 0,
          !fixture.expect_break || hasBreak,
          !fixture.expect_buffer || hasBuffer,
          fitsWindow,
        ];

        const passed = checks.every(Boolean);

        report.planner.push({
          fixture_id: fixture.id,
          passed,
          block_count: blocks.length,
          missing_titles: missingTitles,
          has_break: hasBreak,
          has_buffer: hasBuffer,
          fits_window: fitsWindow,
          window_minutes: windowCap,
          total_minutes_planned: totalMinutes,
          block_titles: blocks.map((b) => `${b.title} (${b.block_type}, ${b.duration_minutes}m)`),
        });
      } catch (error) {
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            run_type: "plan",
            provider: "claude",
            model_name: AI_MODELS.CLAUDE_SONNET,
            prompt_version: PROMPT_VERSIONS.plan,
            status: "failed",
            error_text: error instanceof Error ? error.message : "Unknown planner error",
          },
        });
        report.planner.push({
          fixture_id: fixture.id,
          passed: false,
          block_count: 0,
          missing_titles: ["[error]"],
          has_break: false,
          has_buffer: false,
          total_minutes_planned: 0,
          block_titles: [],
          error: error instanceof Error ? error.message : "Unknown planner error",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Merge suggestion eval
  // ---------------------------------------------------------------------------
  if (suite === "all" || suite === "merge") {
    for (const fixture of MERGE_FIXTURES) {
      try {
        const result = await provider.checkMerge({
          new_node: {
            title: fixture.node_a_title,
            summary: fixture.node_a_summary,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            node_type: fixture.node_a_type as any,
          },
          existing_node: {
            title: fixture.node_b_title,
            summary: fixture.node_b_summary,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            node_type: fixture.node_b_type as any,
          },
          similarity: fixture.similarity,
        });
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            ...result.run,
            status: "success",
            error_text: null,
          },
        });

        const output = result.output;
        const passed = output.same_entity === fixture.expected_same_entity;

        report.merge.push({
          fixture_id: fixture.id,
          passed,
          expected_same_entity: fixture.expected_same_entity,
          actual_same_entity: output.same_entity,
          confidence: output.confidence,
          reason: output.reason,
        });
      } catch (error) {
        emitAIRunStructuredLog({
          source: "eval",
          userId: null,
          workspaceId: "eval",
          run: {
            run_type: "merge_check",
            provider: "claude",
            model_name: modelName ?? AI_MODELS.CLAUDE_SONNET,
            prompt_version: PROMPT_VERSIONS.merge_check,
            status: "failed",
            error_text: error instanceof Error ? error.message : "Unknown merge check error",
          },
        });
        report.merge.push({
          fixture_id: fixture.id,
          passed: false,
          expected_same_entity: fixture.expected_same_entity,
          actual_same_entity: false,
          confidence: 0,
          reason: "",
          error: error instanceof Error ? error.message : "Unknown merge check error",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const allResults = [
    ...report.extraction.map((r) => r.passed),
    ...report.edges.map((r) => r.passed),
    ...report.assistant.map((r) => r.passed),
    ...report.planner.map((r) => r.passed),
    ...report.merge.map((r) => r.passed),
  ];
  report.summary.total = allResults.length;
  report.summary.passed = allResults.filter(Boolean).length;
  report.summary.failed = allResults.filter((p) => !p).length;
  report.summary.pass_rate =
    allResults.length > 0
      ? `${Math.round((report.summary.passed / allResults.length) * 100)}%`
      : "0%";

  // ---------------------------------------------------------------------------
  // Release gates — evaluate minimum pass-rate thresholds per suite
  // ---------------------------------------------------------------------------
  function suiteRate(results: { passed: boolean }[]): number {
    if (results.length === 0) return 1; // empty suite: skip gate (vacuously passes)
    return results.filter((r) => r.passed).length / results.length;
  }

  const suiteRates: Record<keyof typeof RELEASE_GATES, number> = {
    extraction: suiteRate(report.extraction),
    edges: suiteRate(report.edges),
    assistant: suiteRate(report.assistant),
    planner: suiteRate(report.planner),
    merge: suiteRate(report.merge),
    overall: report.summary.total > 0 ? report.summary.passed / report.summary.total : 1,
  };

  report.release_gates = (Object.keys(RELEASE_GATES) as (keyof typeof RELEASE_GATES)[]).map(
    (key) => ({
      suite: key,
      pass_rate: Math.round(suiteRates[key] * 100) / 100,
      threshold: RELEASE_GATES[key],
      gate_passed: suiteRates[key] >= RELEASE_GATES[key],
    }),
  );
  report.gates_passed = report.release_gates.every((g) => g.gate_passed);

  return NextResponse.json(report);
}
