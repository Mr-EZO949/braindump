// Cost + accuracy audit for every AI operation the app runs.
// Fires real API calls against both providers, captures usage metadata,
// validates output structure, and reports per-operation cost.
//
// Run: npx tsx scripts/cost-audit.ts
//
// Skips phases whose provider is rate-limited (Gemini free tier).

import { readFileSync } from "fs";
import path from "path";

// Hand-load .env.local — we bypass Next.js
const envPath = path.resolve(process.cwd(), ".env.local");
const envText = readFileSync(envPath, "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { buildExtractionPromptParts } from "../src/lib/ai/prompts/extract";
import { buildEdgeInferencePromptParts } from "../src/lib/ai/prompts/infer-edge";
import { buildMergeCheckPromptParts } from "../src/lib/ai/prompts/merge-check";
import { buildPlanPromptParts } from "../src/lib/ai/prompts/plan";
import { buildAssistantSystemPrompt, buildAssistantUserPromptParts } from "../src/lib/ai/prompts/assistant";
import { AI_MODELS, AI_COST_PER_1M_TOKENS, AI_TEMPERATURE } from "../src/lib/ai/config";
import { getToolSchemas } from "../src/lib/ai/tools";

// ---------------------------------------------------------------------------
// Price tables (mirrors config.ts)
// Cache pricing: write = 1.25x input, read = 0.10x input
// ---------------------------------------------------------------------------

const PRICE = {
  sonnet: {
    inMPer: AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_INPUT,
    outMPer: AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_OUTPUT,
  },
  haiku: {
    inMPer: AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_INPUT,
    outMPer: AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_OUTPUT,
  },
  geminiPro: {
    inMPer: AI_COST_PER_1M_TOKENS.GEMINI_PRO_INPUT,
    outMPer: AI_COST_PER_1M_TOKENS.GEMINI_PRO_OUTPUT,
  },
};

type ClaudeUsage = Anthropic.Messages.Usage & {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

function claudeCost(
  u: ClaudeUsage,
  tier: "sonnet" | "haiku",
): { total: number; breakdown: string } {
  const p = PRICE[tier];
  const fresh = (u.input_tokens ?? 0) * p.inMPer;
  const cw = (u.cache_creation_input_tokens ?? 0) * p.inMPer * 1.25;
  const cr = (u.cache_read_input_tokens ?? 0) * p.inMPer * 0.1;
  const out = (u.output_tokens ?? 0) * p.outMPer;
  const total = (fresh + cw + cr + out) / 1_000_000;
  const breakdown =
    `fresh=$${(fresh / 1_000_000).toFixed(5)} ` +
    `cw=$${(cw / 1_000_000).toFixed(5)} ` +
    `cr=$${(cr / 1_000_000).toFixed(5)} ` +
    `out=$${(out / 1_000_000).toFixed(5)}`;
  return { total, breakdown };
}

type GeminiUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
};

function geminiCost(u: GeminiUsage): number {
  const p = PRICE.geminiPro;
  const prompt = u.promptTokenCount ?? 0;
  const cached = u.cachedContentTokenCount ?? 0;
  const freshIn = Math.max(0, prompt - cached);
  const cost =
    (freshIn * p.inMPer + cached * p.inMPer * 0.25 + (u.candidatesTokenCount ?? 0) * p.outMPer) /
    1_000_000;
  return cost;
}

function fmt(n: number | null | undefined) {
  return n == null ? "-" : n.toString();
}

function money(n: number): string {
  return `$${n.toFixed(6)}`;
}

// ---------------------------------------------------------------------------
// Realistic fixtures
// ---------------------------------------------------------------------------

const BIG_DUMP = `I've been thinking about the honors thesis proposal for a while now. The regression analysis chapter is mostly drafted but I still need to finalize the results section — the bootstrap confidence intervals don't look right. Advisor review is Wednesday at 3pm.

Also Stats 302 problem set 6 is due Thursday. The hypothesis testing section (problems 4 and 5) is where I'm stuck; the MLE derivation from lecture last week is the bit I need to re-read.

IRB form for the survey study has to be submitted by Monday. I need the consent form template from Sarah, and the final question list reviewed by Prof. Chen. After that we can start recruiting next semester.

Grad school essays — Berkeley and MIT are my top two. Berkeley wants 1000 words on research motivation; MIT wants something shorter but more personal. Deadline for both is December 15.

ML project: dataset cleaning script is 80% done, three flaky tests in the pipeline I need to fix before the demo. The dropout model training run needs a rerun with the new hyperparameters.

Gym routine slipped — 2 weeks since I've been. Restarting with 3x/week, probably Tuesday/Thursday/Saturday mornings.

Rent due on the 1st. Parking pass renewal in 2 weeks. Mom's birthday gift — I was thinking the book she mentioned plus a handwritten card.

BrainDump product ideas: better onboarding flow with a guided first dump, daily nudges based on recency + priority, auto-cluster proposals for large dumps.

BrainDump marketing tasks: launch post on HN next Friday, reply to 5 beta testers for testimonials, update landing page screenshots with the new graph palette.

Login bug on the signup page — the password reset email goes out but the reset link 404s. Tracked it down to the token not being URL-encoded.`;

const SMALL_DUMP = "Buy milk and finish the report.";

// ---------------------------------------------------------------------------
// Accuracy helpers
// ---------------------------------------------------------------------------

function isValidJSON(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function parseJSON<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

type PhaseResult = {
  phase: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number;
  notes: string[];
  accuracy: string[];
};

const results: PhaseResult[] = [];

function record(p: PhaseResult) {
  results.push(p);
}

// ---------------------------------------------------------------------------
// Phase 1: Claude extract (large dump, 2 calls → cache should hit on call 2)
// ---------------------------------------------------------------------------

async function claudeExtractLarge(client: Anthropic): Promise<PhaseResult> {
  const phase = "claude-extract-large";
  console.log(`\n=== ${phase} (big dump, ${BIG_DUMP.length} chars) ===`);

  const { rubricBlock, variableBlock } = buildExtractionPromptParts({
    raw_text: BIG_DUMP,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  });

  const messages: MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: rubricBlock, cache_control: { type: "ephemeral" } },
        { type: "text", text: variableBlock },
      ],
    },
  ];

  let inT = 0, outT = 0, cw = 0, cr = 0, cost = 0;
  const notes: string[] = [];
  const accuracy: string[] = [];

  for (const label of ["call1", "call2"] as const) {
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 4096,
      temperature: AI_TEMPERATURE.EXTRACTION,
      system: "You always respond with valid JSON only.",
      messages,
    });
    const u = r.usage as ClaudeUsage;
    inT += u.input_tokens ?? 0;
    outT += u.output_tokens ?? 0;
    cw += u.cache_creation_input_tokens ?? 0;
    cr += u.cache_read_input_tokens ?? 0;
    const { total, breakdown } = claudeCost(u, "sonnet");
    cost += total;
    console.log(
      `  [${label}] in=${u.input_tokens} out=${u.output_tokens} ` +
        `cw=${fmt(u.cache_creation_input_tokens)} cr=${fmt(u.cache_read_input_tokens)} ` +
        `$=${money(total)} (${breakdown})`,
    );

    if (label === "call1") {
      const text = r.content[0].type === "text" ? r.content[0].text : "";
      const parsed = parseJSON<{
        proposed_nodes?: Array<{
          proposed_title: string;
          proposed_node_type: string;
          extraction_confidence: number;
          primary_parent_local_ref: string | null;
          existing_parent_node_id: string | null;
          local_ref: string;
        }>;
        clarifying_questions?: string[];
      }>(text);
      if (!parsed) accuracy.push("ERROR: extract JSON parse failed");
      else {
        const n = parsed.proposed_nodes?.length ?? 0;
        accuracy.push(`${n} nodes extracted`);
        const titles = (parsed.proposed_nodes ?? []).map((p) => p.proposed_title.toLowerCase()).join(" | ");
        for (const expected of ["thesis", "stats 302", "irb", "gym", "rent", "login bug"]) {
          accuracy.push(`  ${expected} mentioned: ${titles.includes(expected) ? "YES" : "no"}`);
        }
        const avgConf =
          (parsed.proposed_nodes ?? []).reduce((s, p) => s + p.extraction_confidence, 0) / Math.max(1, n);
        accuracy.push(`  avg confidence: ${avgConf.toFixed(2)}`);

        // Print every node so manual eyeball is possible
        accuracy.push("  --- full node list ---");
        for (const node of parsed.proposed_nodes ?? []) {
          const parent = node.primary_parent_local_ref ?? "—";
          accuracy.push(
            `  [${node.local_ref}] ${node.proposed_title} (${node.proposed_node_type}, conf=${node.extraction_confidence.toFixed(2)}, parent=${parent})`,
          );
        }
        if ((parsed.clarifying_questions?.length ?? 0) > 0) {
          accuracy.push("  --- clarifying questions ---");
          for (const q of parsed.clarifying_questions!) accuracy.push(`  ? ${q}`);
        }
      }
    }
  }

  notes.push(
    cr > 0
      ? `cache hit: ${cr} tokens read on 2nd call`
      : "WARN: expected cache read on 2nd call but got 0",
  );

  return {
    phase,
    calls: 2,
    inputTokens: inT,
    outputTokens: outT,
    cacheCreate: cw,
    cacheRead: cr,
    cost,
    notes,
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Claude extract (small dump, size gate OFF, 1 call)
// ---------------------------------------------------------------------------

async function claudeExtractSmall(client: Anthropic): Promise<PhaseResult> {
  const phase = "claude-extract-small";
  console.log(`\n=== ${phase} (small dump, gate off) ===`);

  const { rubricBlock, variableBlock } = buildExtractionPromptParts({
    raw_text: SMALL_DUMP,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  });

  const r = await client.messages.create({
    model: AI_MODELS.CLAUDE_SONNET,
    max_tokens: 1024,
    temperature: AI_TEMPERATURE.EXTRACTION,
    system: "You always respond with valid JSON only.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: rubricBlock }, // NO cache_control — gated off
          { type: "text", text: variableBlock },
        ],
      },
    ],
  });
  const u = r.usage as ClaudeUsage;
  const { total, breakdown } = claudeCost(u, "sonnet");
  console.log(
    `  [small] in=${u.input_tokens} out=${u.output_tokens} ` +
      `cw=${fmt(u.cache_creation_input_tokens)} cr=${fmt(u.cache_read_input_tokens)} ` +
      `$=${money(total)} (${breakdown})`,
  );

  const accuracy: string[] = [];
  const text = r.content[0].type === "text" ? r.content[0].text : "";
  accuracy.push(`valid JSON: ${isValidJSON(text)}`);

  return {
    phase,
    calls: 1,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cost: total,
    notes: ["no cache_control sent (size-gated off)"],
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Claude inferEdge (3 calls, same rules → cache miss expected <1024)
// ---------------------------------------------------------------------------

async function claudeInferEdge(client: Anthropic): Promise<PhaseResult> {
  const phase = "claude-infer-edge";
  console.log(`\n=== ${phase} (3 calls w/ same rules block) ===`);

  const sharedRubric = buildEdgeInferencePromptParts({
    source_title: "dummy", source_summary: null, candidates: [{ id: "x", title: "y", summary: null }],
  }).stablePrefix;
  console.log(`  stable prefix ~chars: ${sharedRubric.length}, min-cache-prefix-tokens: 1024 for Sonnet`);

  const calls = [
    {
      source_title: "Finish Thesis Proposal",
      source_summary: "Draft honors-program proposal with regression chapter finalized",
      candidates: [
        { id: "c1", title: "Get Into Honors Program", summary: "Submit application May 1" },
        { id: "c2", title: "Stats 302", summary: "Statistics course" },
        { id: "c3", title: "Gym Routine", summary: "3x per week" },
        { id: "c4", title: "Review Regression Models", summary: "Lecture notes review" },
        { id: "c5", title: "Mom's Birthday Gift", summary: "Book + card" },
      ],
    },
    {
      source_title: "Submit IRB Form",
      source_summary: "Survey study IRB by Monday",
      candidates: [
        { id: "c1", title: "Survey Study", summary: "Research study on student habits" },
        { id: "c2", title: "Grad School Essays", summary: "Berkeley, MIT apps" },
        { id: "c3", title: "Fix Login Bug", summary: "Signup page reset link" },
        { id: "c4", title: "Consent Form Template", summary: "From Sarah" },
        { id: "c5", title: "Prof Chen Review", summary: "Question list review" },
      ],
    },
    {
      source_title: "Dataset Cleaning Script",
      source_summary: "80% done, needs fixes for flaky tests",
      candidates: [
        { id: "c1", title: "ML Project", summary: "End-of-semester project" },
        { id: "c2", title: "Dropout Model Training", summary: "Rerun with new hyperparams" },
        { id: "c3", title: "Rent", summary: "Due 1st of month" },
        { id: "c4", title: "Fix Flaky Tests", summary: "Three tests in pipeline" },
        { id: "c5", title: "Gym Routine", summary: "3x per week" },
      ],
    },
  ];

  let inT = 0, outT = 0, cw = 0, cr = 0, cost = 0;
  const accuracy: string[] = [];

  for (let i = 0; i < calls.length; i++) {
    const { stablePrefix, variableBlock } = buildEdgeInferencePromptParts(calls[i]);
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 1024,
      temperature: AI_TEMPERATURE.EDGE_INFERENCE,
      system: "You always respond with valid JSON only.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: stablePrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: variableBlock },
          ],
        },
      ],
    });
    const u = r.usage as ClaudeUsage;
    inT += u.input_tokens ?? 0;
    outT += u.output_tokens ?? 0;
    cw += u.cache_creation_input_tokens ?? 0;
    cr += u.cache_read_input_tokens ?? 0;
    const { total } = claudeCost(u, "sonnet");
    cost += total;
    console.log(
      `  [call${i + 1}] in=${u.input_tokens} out=${u.output_tokens} ` +
        `cw=${fmt(u.cache_creation_input_tokens)} cr=${fmt(u.cache_read_input_tokens)} $=${money(total)}`,
    );

    const text = r.content[0].type === "text" ? r.content[0].text : "";
    const parsed = parseJSON<{
      results?: Array<{ candidate_id: string; related: boolean; edge_type: string | null; confidence: number; explanation: string }>;
    }>(text);
    if (!parsed?.results) accuracy.push(`call${i + 1}: ERROR invalid output`);
    else {
      const related = parsed.results.filter((x) => x.related).length;
      accuracy.push(`call${i + 1} "${calls[i].source_title}": ${related}/${parsed.results.length} related`);
      for (const res of parsed.results) {
        const cand = calls[i].candidates.find((c) => c.id === res.candidate_id);
        const verdict = res.related ? `${res.edge_type}@${res.confidence.toFixed(2)}` : "no";
        accuracy.push(`  → ${cand?.title ?? res.candidate_id}: ${verdict} — ${res.explanation}`);
      }
    }
  }

  return {
    phase,
    calls: calls.length,
    inputTokens: inT,
    outputTokens: outT,
    cacheCreate: cw,
    cacheRead: cr,
    cost,
    notes:
      cr > 0
        ? [`cache hit: ${cr} tokens`]
        : ["WARN: rules block < 1024 tokens → cache_control is no-op (expected finding)"],
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Claude checkMerge (3 pairs — dup, non-dup, borderline)
// ---------------------------------------------------------------------------

async function claudeCheckMerge(client: Anthropic): Promise<PhaseResult> {
  const phase = "claude-check-merge";
  console.log(`\n=== ${phase} (3 pairs) ===`);

  const pairs: Array<{
    label: string;
    expect: boolean;
    new_title: string;
    new_summary: string;
    new_type: string;
    existing_title: string;
    existing_summary: string;
    existing_type: string;
    similarity: number;
  }> = [
    {
      label: "obvious-dup",
      expect: true,
      new_title: "Learn React",
      new_summary: "Work through the React docs and build a todo app",
      new_type: "goal",
      existing_title: "React.js study plan",
      existing_summary: "Study React fundamentals and hooks",
      existing_type: "goal",
      similarity: 0.92,
    },
    {
      label: "obvious-nondup",
      expect: false,
      new_title: "Submit IRB Form",
      new_summary: "File the IRB form for the survey study",
      new_type: "task",
      existing_title: "Gym Routine",
      existing_summary: "3x per week strength + cardio",
      existing_type: "habit",
      similarity: 0.87,
    },
    {
      label: "borderline",
      expect: false,
      new_title: "Financial Independence",
      new_summary: "Reach 1M net worth",
      new_type: "goal",
      existing_title: "SaaS Revenue Goal",
      existing_summary: "$10k MRR by Q4",
      existing_type: "goal",
      similarity: 0.88,
    },
  ];

  let inT = 0, outT = 0, cost = 0;
  const accuracy: string[] = [];

  for (const pair of pairs) {
    const { rubricBlock, variableBlock } = buildMergeCheckPromptParts(pair);
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 256,
      temperature: AI_TEMPERATURE.MERGE_CHECK,
      system: "You always respond with valid JSON only.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: rubricBlock },
            { type: "text", text: variableBlock },
          ],
        },
      ],
    });
    const u = r.usage as ClaudeUsage;
    inT += u.input_tokens ?? 0;
    outT += u.output_tokens ?? 0;
    const { total } = claudeCost(u, "sonnet");
    cost += total;
    const text = r.content[0].type === "text" ? r.content[0].text : "";
    const parsed = parseJSON<{ same_entity: boolean; confidence: number }>(text);
    const correct = parsed?.same_entity === pair.expect;
    console.log(
      `  [${pair.label}] in=${u.input_tokens} out=${u.output_tokens} $=${money(total)} ` +
        `same=${parsed?.same_entity ?? "?"} expected=${pair.expect} ${correct ? "✓" : "✗"}`,
    );
    accuracy.push(`${pair.label}: ${correct ? "correct" : "WRONG"} (expected ${pair.expect}, got ${parsed?.same_entity})`);
  }

  return {
    phase,
    calls: pairs.length,
    inputTokens: inT,
    outputTokens: outT,
    cacheCreate: 0,
    cacheRead: 0,
    cost,
    notes: ["no caching (rubric ~300 tokens, below 1024 floor — intentional)"],
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Phase 5: Claude buildPlan (Haiku, 1 call)
// ---------------------------------------------------------------------------

async function claudeBuildPlan(client: Anthropic): Promise<PhaseResult> {
  const phase = "claude-build-plan";
  console.log(`\n=== ${phase} (Haiku, 1 call) ===`);

  const { rubricBlock, variableBlock } = buildPlanPromptParts({
    planning_window: "2h",
    total_minutes: 120,
    candidate_nodes: [
      { id: "n1", title: "Finish Thesis Regression Chapter", summary: "Bootstrap CIs look wrong, fix and finalize", node_type: "task" },
      { id: "n2", title: "Stats 302 Problem Set 6", summary: "Due Thursday; stuck on MLE hypothesis testing", node_type: "task" },
      { id: "n3", title: "IRB Form Survey Study", summary: "Submit by Monday", node_type: "task" },
      { id: "n4", title: "Fix Flaky Tests", summary: "Three in ML pipeline", node_type: "task" },
      { id: "n5", title: "Berkeley Essay", summary: "1000 words on research motivation", node_type: "task" },
    ],
  });

  const r = await client.messages.create({
    model: AI_MODELS.CLAUDE_HAIKU,
    max_tokens: 2048,
    temperature: AI_TEMPERATURE.PLANNER,
    system: "You always respond with valid JSON only.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: rubricBlock },
          { type: "text", text: variableBlock },
        ],
      },
    ],
  });
  const u = r.usage as ClaudeUsage;
  const { total } = claudeCost(u, "haiku");
  console.log(`  in=${u.input_tokens} out=${u.output_tokens} $=${money(total)}`);

  const text = r.content[0].type === "text" ? r.content[0].text : "";
  const parsed = parseJSON<{ blocks?: Array<{ duration_minutes: number; block_type: string }> }>(text);
  const accuracy: string[] = [];
  if (!parsed?.blocks) accuracy.push("ERROR: invalid plan");
  else {
    const totalMin = parsed.blocks.reduce((s, b) => s + b.duration_minutes, 0);
    accuracy.push(`${parsed.blocks.length} blocks totaling ${totalMin}min (target 120)`);
    const types = new Set(parsed.blocks.map((b) => b.block_type));
    accuracy.push(`block types: ${[...types].join(", ")}`);
  }

  return {
    phase,
    calls: 1,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cost: total,
    notes: ["uses Haiku (~1/3 Sonnet cost); no caching currently"],
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Phase 6: Claude chat pattern (3 turns, system+tools+context cached)
// ---------------------------------------------------------------------------

async function claudeChat(client: Anthropic): Promise<PhaseResult> {
  const phase = "claude-chat-3turns";
  console.log(`\n=== ${phase} (system + tools + context all cached) ===`);

  const systemPrompt = buildAssistantSystemPrompt("explain");
  const systemBlocks: TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  const baseTools = getToolSchemas();
  const tools = baseTools.map((t, i) =>
    i === baseTools.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
  );

  const mockContext = [
    "Active nodes:",
    "- Finish Thesis Proposal [task] — draft by Friday",
    "- Stats 302 [class] — problem set 6 due Thursday",
    "- IRB Form [task] — submit by Monday",
    "- ML Project [project] — dataset cleaning 80% done",
    "- Grad School Essays [project] — Berkeley + MIT due Dec 15",
    "",
    "Recent activity:",
    "- Completed 'Fix login bug' 2 hours ago",
    "- Added 'Gym Routine' yesterday",
  ].join("\n");

  const { contextBlock } = buildAssistantUserPromptParts({
    message: "placeholder",
    context: mockContext,
    scope: "workspace",
  });

  const turns = [
    "What's on my plate right now?",
    "Which of those is most urgent?",
    "How does the thesis work connect to Stats 302?",
  ];

  const messages: MessageParam[] = [];
  let inT = 0, outT = 0, cw = 0, cr = 0, cost = 0;
  const accuracy: string[] = [];

  for (let i = 0; i < turns.length; i++) {
    const userContent =
      i === 0
        ? [
            { type: "text" as const, text: contextBlock, cache_control: { type: "ephemeral" as const } },
            { type: "text" as const, text: `User question: ${turns[i]}` },
          ]
        : [{ type: "text" as const, text: `User question: ${turns[i]}` }];

    messages.push({ role: "user", content: userContent });

    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 1024,
      temperature: AI_TEMPERATURE.ASSISTANT,
      system: systemBlocks,
      tools,
      messages,
    });
    const u = r.usage as ClaudeUsage;
    inT += u.input_tokens ?? 0;
    outT += u.output_tokens ?? 0;
    cw += u.cache_creation_input_tokens ?? 0;
    cr += u.cache_read_input_tokens ?? 0;
    const { total } = claudeCost(u, "haiku");
    cost += total;
    console.log(
      `  [turn${i + 1}] in=${u.input_tokens} out=${u.output_tokens} ` +
        `cw=${fmt(u.cache_creation_input_tokens)} cr=${fmt(u.cache_read_input_tokens)} $=${money(total)}`,
    );

    const replyText = r.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    messages.push({ role: "assistant", content: r.content });
    accuracy.push(`turn${i + 1} Q: ${turns[i]}`);
    accuracy.push(`turn${i + 1} A: ${replyText.slice(0, 400).replace(/\s+/g, " ")}${replyText.length > 400 ? "…" : ""}`);
  }

  return {
    phase,
    calls: turns.length,
    inputTokens: inT,
    outputTokens: outT,
    cacheCreate: cw,
    cacheRead: cr,
    cost,
    notes:
      cr > 0
        ? [`strong cache reuse: ${cr} tokens across turns`]
        : ["WARN: chat caching not hitting — investigate"],
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Phase 7: Gemini extract (2 calls — implicit cache on call 2)
// ---------------------------------------------------------------------------

async function geminiExtract(): Promise<PhaseResult | null> {
  const phase = "gemini-extract";
  console.log(`\n=== ${phase} (implicit cache via systemInstruction) ===`);

  if (!process.env.GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const { rubricBlock, variableBlock } = buildExtractionPromptParts({
    raw_text: BIG_DUMP,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  });

  const model = genAI.getGenerativeModel({
    model: AI_MODELS.GEMINI_PRO,
    generationConfig: { temperature: AI_TEMPERATURE.EXTRACTION, responseMimeType: "application/json" },
    systemInstruction: rubricBlock,
  });

  let inT = 0, outT = 0, cached = 0, cost = 0;
  const accuracy: string[] = [];

  for (const label of ["call1", "call2"]) {
    try {
      const r = await model.generateContent(variableBlock);
      const u = (r.response.usageMetadata ?? {}) as GeminiUsage;
      inT += u.promptTokenCount ?? 0;
      outT += u.candidatesTokenCount ?? 0;
      cached += u.cachedContentTokenCount ?? 0;
      cost += geminiCost(u);
      console.log(
        `  [${label}] prompt=${u.promptTokenCount} out=${u.candidatesTokenCount} cached=${fmt(u.cachedContentTokenCount)} $=${money(geminiCost(u))}`,
      );
      const text = r.response.text();
      if (label === "call1") accuracy.push(`valid JSON: ${isValidJSON(text)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  [${label}] FAILED: ${msg.split("\n")[0]}`);
      return {
        phase,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreate: 0,
        cacheRead: 0,
        cost: 0,
        notes: [`SKIPPED: ${msg.split("\n")[0]}`],
        accuracy: [],
      };
    }
  }

  return {
    phase,
    calls: 2,
    inputTokens: inT,
    outputTokens: outT,
    cacheCreate: 0,
    cacheRead: cached,
    cost,
    notes: cached > 0 ? [`implicit cache hit: ${cached} tokens`] : ["no cache hit (may need longer prefix)"],
    accuracy,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  record(await claudeExtractLarge(client));
  record(await claudeExtractSmall(client));
  record(await claudeInferEdge(client));
  record(await claudeCheckMerge(client));
  record(await claudeBuildPlan(client));
  record(await claudeChat(client));
  const g = await geminiExtract();
  if (g) record(g);

  console.log("\n========================================");
  console.log("SUMMARY");
  console.log("========================================");
  let grand = 0;
  for (const r of results) {
    console.log(`\n${r.phase} (${r.calls} calls)`);
    console.log(`  tokens: in=${r.inputTokens} out=${r.outputTokens} cw=${r.cacheCreate} cr=${r.cacheRead}`);
    console.log(`  cost: ${money(r.cost)}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    for (const a of r.accuracy) console.log(`  acc: ${a}`);
    grand += r.cost;
  }
  console.log(`\n--- GRAND TOTAL: ${money(grand)} ---`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
