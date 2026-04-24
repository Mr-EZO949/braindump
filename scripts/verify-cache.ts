// Cache verification — fires real API calls and prints usage metadata.
// Run with: npx tsx scripts/verify-cache.ts
//
// Delete after verifying; this is not part of the test suite.

import { readFileSync } from "fs";
import path from "path";

const envPath = path.resolve(process.cwd(), ".env.local");
const envText = readFileSync(envPath, "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { buildExtractionPromptParts } from "../src/lib/ai/prompts/extract";
import { buildEdgeInferencePromptParts } from "../src/lib/ai/prompts/infer-edge";

function fmt(n: number | null | undefined) {
  return n == null ? "-" : n.toString();
}

async function testClaudeExtract() {
  console.log("\n=== Claude extract (large dump → size gate ON, cache_control set) ===");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const bigDump =
    "I've been thinking about the thesis proposal for the honors program, and I need to finalize the regression analysis chapter. " +
    "Also Stats 302 problem set due Thursday — the part about hypothesis testing is what I'm stuck on. " +
    "My survey study has an IRB form I need to submit by next Monday; the advisor review meeting is Wednesday at 3pm. " +
    "Separately I want to start the grad school application essays — Berkeley and MIT are my top choices. " +
    "The ML project needs the dataset cleaning script finished; I have three flaky tests in the pipeline I need to fix. " +
    "Gym routine is slipping — haven't been in 2 weeks. I want to restart with 3x/week. " +
    "Rent is due on the 1st, parking pass renewal in 2 weeks, mom's birthday gift. " +
    "Ideas for BrainDump: better onboarding flow, daily nudges based on recency, auto-cluster by semantic domain. " +
    "Marketing tasks for BrainDump: launch post on HN, Reddit /r/productivity, reach out to 5 beta users for testimonials, update landing page with new screenshots. " +
    "Working on the login bug on the signup page and the password-reset flow. Need to review the Stats 302 lecture notes on MLE before the exam.";

  console.log(`Dump chars: ${bigDump.length} (gate=2000)`);

  const { rubricBlock, variableBlock } = buildExtractionPromptParts({
    raw_text: bigDump,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: rubricBlock, cache_control: { type: "ephemeral" } },
        { type: "text", text: variableBlock },
      ],
    },
  ];

  const call = async (label: string) => {
    const r = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      temperature: 0.2,
      system: "You always respond with valid JSON only.",
      messages,
    });
    const u = r.usage as Anthropic.Messages.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    console.log(
      `[${label}] input=${fmt(u.input_tokens)} output=${fmt(u.output_tokens)} ` +
        `cache_create=${fmt(u.cache_creation_input_tokens)} ` +
        `cache_read=${fmt(u.cache_read_input_tokens)}`,
    );
  };

  await call("call1-write");
  await call("call2-read");
}

async function testClaudeExtractSmall() {
  console.log("\n=== Claude extract (small dump → size gate OFF, no cache_control) ===");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const smallDump = "Buy milk and finish the report.";
  console.log(`Dump chars: ${smallDump.length} (gate=2000)`);

  const { rubricBlock, variableBlock } = buildExtractionPromptParts({
    raw_text: smallDump,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: rubricBlock },
        { type: "text", text: variableBlock },
      ],
    },
  ];

  const r = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    temperature: 0.2,
    system: "You always respond with valid JSON only.",
    messages,
  });
  const u = r.usage as Anthropic.Messages.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  console.log(
    `[small] input=${fmt(u.input_tokens)} output=${fmt(u.output_tokens)} ` +
      `cache_create=${fmt(u.cache_creation_input_tokens)} ` +
      `cache_read=${fmt(u.cache_read_input_tokens)}`,
  );
}

async function testClaudeInferEdge() {
  console.log("\n=== Claude inferEdge (unconditional rubric cache) ===");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const { stablePrefix, variableBlock } = buildEdgeInferencePromptParts({
    source_title: "Finish Thesis Proposal",
    source_summary: "Draft the honors-program proposal by Friday",
    candidates: [
      { id: "c1", title: "Stats 302", summary: "Statistics course this semester" },
      { id: "c2", title: "Get Into Honors Program", summary: "Submit application by May 1" },
      { id: "c3", title: "Gym Routine", summary: "3x per week" },
    ],
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: stablePrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: variableBlock },
      ],
    },
  ];

  const call = async (label: string) => {
    const r = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      temperature: 0.2,
      system: "You always respond with valid JSON only.",
      messages,
    });
    const u = r.usage as Anthropic.Messages.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    console.log(
      `[${label}] input=${fmt(u.input_tokens)} output=${fmt(u.output_tokens)} ` +
        `cache_create=${fmt(u.cache_creation_input_tokens)} ` +
        `cache_read=${fmt(u.cache_read_input_tokens)}`,
    );
  };

  await call("call1-write");
  await call("call2-read");
}

async function testGeminiExtract() {
  console.log("\n=== Gemini extract (systemInstruction → implicit cache) ===");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  const { rubricBlock, variableBlock } = buildExtractionPromptParts({
    raw_text:
      "Fix the login bug on signup page. Submit IRB form for survey study by Monday. " +
      "Review Stats 302 lecture notes on MLE before exam. Gym routine 3x/week. " +
      "Rent due 1st. Grad school essays — Berkeley, MIT. Launch BrainDump post on HN.",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    user_id: "00000000-0000-0000-0000-000000000002",
  });

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
    systemInstruction: rubricBlock,
  });

  const call = async (label: string) => {
    const r = await model.generateContent(variableBlock);
    const u = r.response.usageMetadata as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    console.log(
      `[${label}] prompt=${fmt(u.promptTokenCount)} output=${fmt(u.candidatesTokenCount)} ` +
        `cached=${fmt(u.cachedContentTokenCount)}`,
    );
  };

  await call("call1");
  await call("call2");
}

async function main() {
  try {
    await testClaudeExtract();
    await testClaudeExtractSmall();
    await testClaudeInferEdge();
    await testGeminiExtract();
  } catch (e) {
    console.error("FAILED:", e);
    process.exit(1);
  }
}

main();
