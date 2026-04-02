// POST /api/eval/run
// Dev-only eval harness — runs extraction, edge inference, assistant, and planner
// against fixtures and returns a pass/fail report with prompt versions.
// Use before and after prompt changes as a regression check.
// Blocked in production (NODE_ENV check).
// Query params:
//   ?suite=all (default) | extraction | edges | assistant | planner

import { NextRequest, NextResponse } from "next/server";
import { aiProvider } from "@/lib/ai";
import {
  BRAIN_DUMP_FIXTURES,
  EDGE_FIXTURES,
  ASSISTANT_FIXTURES,
  PLANNER_FIXTURES,
} from "@/lib/ai/eval/fixtures";
import { PROMPT_VERSIONS } from "@/lib/ai/prompts";

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
  total_minutes_planned: number;
  block_titles: string[];
  error?: string;
};

type Suite = "all" | "extraction" | "edges" | "assistant" | "planner";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  const suite = (req.nextUrl.searchParams.get("suite") ?? "all") as Suite;

  const report: {
    prompt_versions: typeof PROMPT_VERSIONS;
    extraction: ExtractionResult[];
    edges: EdgeResult[];
    assistant: AssistantResult[];
    planner: PlannerResult[];
    summary: { total: number; passed: number; failed: number; pass_rate: string };
  } = {
    prompt_versions: PROMPT_VERSIONS,
    extraction: [],
    edges: [],
    assistant: [],
    planner: [],
    summary: { total: 0, passed: 0, failed: 0, pass_rate: "0%" },
  };

  const provider = aiProvider();

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
          target_node: {
            id: "eval-tgt",
            title: fixture.target_title,
            summary: fixture.target_summary,
          },
        });

        const output = result.output;
        const relatedMatch = output.related === fixture.expected_related;
        const typeMatch =
          !fixture.expected_edge_type || !output.related || output.edge_type === fixture.expected_edge_type;
        const passed = relatedMatch && typeMatch;

        report.edges.push({
          fixture_id: fixture.id,
          passed,
          expected_related: fixture.expected_related,
          actual_related: output.related,
          expected_edge_type: fixture.expected_edge_type,
          actual_edge_type: output.edge_type ?? null,
          confidence: output.confidence,
          explanation: output.explanation,
        });
      } catch (error) {
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

        const blocks = result.output.blocks;
        const blockTitles = blocks.map((b) => b.title.toLowerCase());
        const blockTypes = blocks.map((b) => b.block_type);
        const totalMinutes = blocks.reduce((sum, b) => sum + b.duration_minutes, 0);

        const missingTitles = fixture.expected_block_titles.filter(
          (needle) => !blockTitles.some((title) => title.includes(needle.toLowerCase())),
        );

        const hasBreak = blockTypes.includes("break");
        const hasBuffer = blockTypes.includes("buffer");

        const checks = [
          blocks.length >= fixture.min_blocks,
          missingTitles.length === 0,
          !fixture.expect_break || hasBreak,
          !fixture.expect_buffer || hasBuffer,
        ];

        const passed = checks.every(Boolean);

        report.planner.push({
          fixture_id: fixture.id,
          passed,
          block_count: blocks.length,
          missing_titles: missingTitles,
          has_break: hasBreak,
          has_buffer: hasBuffer,
          total_minutes_planned: totalMinutes,
          block_titles: blocks.map((b) => `${b.title} (${b.block_type}, ${b.duration_minutes}m)`),
        });
      } catch (error) {
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
  // Summary
  // ---------------------------------------------------------------------------
  const allResults = [
    ...report.extraction.map((r) => r.passed),
    ...report.edges.map((r) => r.passed),
    ...report.assistant.map((r) => r.passed),
    ...report.planner.map((r) => r.passed),
  ];
  report.summary.total = allResults.length;
  report.summary.passed = allResults.filter(Boolean).length;
  report.summary.failed = allResults.filter((p) => !p).length;
  report.summary.pass_rate =
    allResults.length > 0
      ? `${Math.round((report.summary.passed / allResults.length) * 100)}%`
      : "0%";

  return NextResponse.json(report);
}
