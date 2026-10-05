// One message, every intent (#22) — a live check that a chat message with
// several things in it does all of them, through the REAL route.
//
//   CHAT_TRACE=1 ALLOWED_EMAILS=<EVAL_EMAIL> npm run dev -- -p 3042
//   npx tsx --env-file=.env.local scripts/eval-chat-intents.ts [case-id …] [--repeat N]
//   npx tsx --env-file=.env.local scripts/eval-chat-intents.ts --list | --cleanup
//
// Each case gets a fresh synthetic graph for a throwaway user (EVAL_EMAIL,
// default e2e.intents@braindump.test — the dev server's ALLOWED_EMAILS must let
// it in), one message POSTed to /api/assistant/chat with a real login, and
// checks on the database: what the user STATED is applied, or waits on the
// card when the policy says so (a move, a rename, a plan) — never missing;
// what the user only ASKED about is not applied. Costs ≈ $0.005–0.015 a case
// (Haiku, measured from ai_runs). Never point it at a real account.

/* eslint-disable no-console */

import { mkdirSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { chromium, type APIRequestContext } from "playwright";

import { embedNewNodes } from "../src/lib/graph/node-intake";
import { MULTI_INTENT_CASES, type IntentCheck, type MultiIntentCase } from "../src/lib/ai/eval/chat-intents";

const APP = process.env.APP_URL || "http://localhost:3042";
const EMAIL = process.env.EVAL_EMAIL || "e2e.intents@braindump.test";
const PW = "e2e-intents-pw-123";
const OUT = process.env.OUT_DIR || "/tmp/chat-intents";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUser(): Promise<string | null> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  return data.users.find((u) => u.email === EMAIL)?.id ?? null;
}

async function ensureUser(): Promise<string> {
  const existing = await findUser();
  if (existing) return existing;
  const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PW, email_confirm: true });
  if (error) throw error;
  return data.user!.id;
}

// The synthetic graph every case starts from (the e2e driver's, plus a dated goal).
const SEED: Array<[title: string, type: string, parent: string | null]> = [
  ["Life", "area", null],
  ["Money Projects", "project", "Life"],
  ["Test & Market BrainDump", "big_task", "Money Projects"],
  ["BrainDump Future Fixes & Features", "task", "Test & Market BrainDump"],
  ["Clothes Reselling", "project", "Money Projects"],
  ["University", "area", "Life"],
  ["Statistics", "class", "University"],
  ["Pass Statistics Midterm", "goal", "Statistics"],
  ["Machine Learning", "class", "University"],
  ["Income & Career", "area", "Life"],
  ["Get Internship by November", "goal", "Income & Career"],
  ["Italian Crash Course", "big_task", "Get Internship by November"],
  ["Update CV", "task", "Get Internship by November"],
  ["Personal Development", "area", "Life"],
  ["Health", "area", "Life"],
  ["Go to the gym", "habit", "Health"],
];

async function seed(userId: string): Promise<{ wsId: string; ids: Map<string, string> }> {
  // The last case's background work (judgment, rescore) may still be writing:
  // retry the delete until the old workspace is gone.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: stale } = await admin.from("workspaces").select("id").eq("user_id", userId);
    if (!stale?.length) break;
    for (const w of stale) {
      const { error } = await admin.from("workspaces").delete().eq("id", w.id);
      if (error) console.log(`(workspace delete: ${error.message} — retrying)`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await admin.from("pending_chat_runs").delete().eq("user_id", userId);
  await admin.from("habit_completions").delete().eq("user_id", userId);
  const { data: ws, error } = await admin.from("workspaces").insert({ user_id: userId, name: "General" }).select("id").single();
  if (error) throw error;
  const wsId = ws!.id as string;
  const ids = new Map<string, string>();
  const created: Array<{ id: string; title: string; summary: string | null; node_type: string }> = [];
  for (const [title, type, parent] of SEED) {
    const { data, error: nodeErr } = await admin
      .from("nodes")
      .insert({
        user_id: userId,
        workspace_id: wsId,
        title,
        node_type: type,
        importance: "medium",
        importance_index: 50,
        status: "active",
        ...(type === "habit" ? { habit_target_per_week: 7 } : {}),
      })
      .select("id")
      .single();
    if (nodeErr) throw nodeErr;
    ids.set(title, data!.id as string);
    created.push({ id: data!.id as string, title, summary: null, node_type: type });
    if (parent) {
      await admin.from("edges").insert({
        user_id: userId,
        workspace_id: wsId,
        source_node_id: data!.id,
        target_node_id: ids.get(parent),
        edge_type: "belongs_to",
        status: "active",
      });
    }
  }
  await admin
    .from("workspaces")
    .update({ bootstrap_root_node_id: ids.get("Life"), bootstrap_completed_at: new Date().toISOString() })
    .eq("id", wsId);
  await embedNewNodes({ supabase: admin, userId, workspaceId: wsId }, created);
  return { wsId, ids };
}

const MARKER = /<<BRAINDUMP_(PAUSE|APPLIED|TURN|UNDO)>>([\s\S]*?)<<\/BRAINDUMP_\1>>/g;

interface TurnOutcome {
  reply: string;
  markers: Array<{ kind: string; body: unknown }>;
  // Everything still waiting for the user: the paused call and the calls deferred behind it.
  waiting: unknown[];
  // Calls set aside behind the card, not run.
  deferred: unknown[];
}

async function sendTurn(request: APIRequestContext, wsId: string, message: string, userId: string): Promise<TurnOutcome> {
  const res = await request.post(`${APP}/api/assistant/chat`, {
    data: { message, workspace_id: wsId, mode: "explain", history: [] },
    timeout: 180_000,
  });
  const body = await res.text();
  if (!res.ok()) throw new Error(`chat ${res.status()}: ${body.slice(0, 200)}`);
  const markers: TurnOutcome["markers"] = [];
  for (const m of body.matchAll(MARKER)) {
    let parsed: unknown = m[2];
    try {
      parsed = JSON.parse(m[2]);
    } catch {
      // keep raw
    }
    markers.push({ kind: m[1].toLowerCase(), body: parsed });
  }
  const waiting: unknown[] = [];
  const deferred: unknown[] = [];
  const { data: runs } = await admin
    .from("pending_chat_runs")
    .select("pending_tool_name, pending_tool_input, deferred_tool_uses")
    .eq("user_id", userId)
    .eq("workspace_id", wsId);
  for (const run of runs ?? []) {
    waiting.push({ name: run.pending_tool_name, input: run.pending_tool_input });
    // Calls deferred behind the card that haven't run are NOT on it: the
    // resume route turns them down ("one action per turn") — they count as missing.
    for (const d of (run.deferred_tool_uses as Array<{ name: string; input: unknown; result?: unknown }> | null) ?? []) {
      if (!d.result) deferred.push({ name: d.name, input: d.input });
    }
  }
  return { reply: body.replace(MARKER, "").trim(), markers, waiting, deferred };
}

async function judge(
  check: IntentCheck,
  ctx: { wsId: string; ids: Map<string, string>; userId: string; outcome: TurnOutcome },
): Promise<{ ok: boolean; how: string }> {
  const id = check.title ? ctx.ids.get(check.title) : undefined;
  const waitingJSON = JSON.stringify(ctx.outcome.waiting);
  const onCard = (needle: string | undefined, kind?: string) =>
    !!needle && waitingJSON.includes(needle) && (!kind || waitingJSON.includes(kind));

  switch (check.kind) {
    case "habit_done": {
      const { data } = await admin.from("habit_completions").select("node_id").eq("node_id", id!);
      return data?.length ? { ok: true, how: "logged" } : onCard(id, "complete") ? { ok: true, how: "on card" } : { ok: false, how: "missing" };
    }
    case "status": {
      const { data } = await admin.from("nodes").select("status").eq("id", id!).single();
      if (data?.status === check.value) return { ok: true, how: `status ${String(data?.status)}` };
      return onCard(id) ? { ok: true, how: "on card" } : { ok: false, how: `status ${data?.status}` };
    }
    case "steer": {
      const event = check.value === "focus" ? "boost_node" : "demote_node";
      const { data } = await admin.from("feedback_events").select("id").eq("entity_id", id!).eq("event_type", event);
      const applied = (data?.length ?? 0) > 0;
      if (check.advice) return applied ? { ok: false, how: `${event} applied (advice)` } : { ok: true, how: onCard(id) ? "suggested" : "not applied" };
      return applied ? { ok: true, how: event } : onCard(id) ? { ok: false, how: "waits (stated, should apply)" } : { ok: false, how: "missing" };
    }
    case "drop_advice": {
      const { data } = await admin.from("nodes").select("status").eq("id", id!).single();
      return data?.status === "active" ? { ok: true, how: onCard(id) ? "suggested" : "untouched" } : { ok: false, how: `status ${data?.status}` };
    }
    case "field": {
      const { data } = await admin.from("nodes").select("*").eq("id", id!).single();
      const value = (data as Record<string, unknown> | null)?.[check.field!];
      return value === check.value ? { ok: true, how: `${check.field}=${String(value)}` } : onCard(id) ? { ok: true, how: "on card" } : { ok: false, how: `${check.field}=${String(value)}` };
    }
    case "created": {
      const { data } = await admin.from("nodes").select("id, title").eq("workspace_id", ctx.wsId);
      const hit = (data ?? []).find((n) => check.match!.test(String(n.title)) && !SEED.some(([t]) => t === n.title));
      if (hit) return { ok: true, how: `added "${hit.title}"` };
      return check.match!.test(waitingJSON) ? { ok: true, how: "on card" } : { ok: false, how: "missing" };
    }
    case "waits": {
      return onCard(id, check.value as string) ? { ok: true, how: `${check.value} on card` } : { ok: false, how: "missing" };
    }
    case "tool_waits": {
      return waitingJSON.includes(`"name":"${check.value}"`) ? { ok: true, how: `${check.value} on card` } : { ok: false, how: "missing" };
    }
    case "commitment": {
      const { data } = await admin.from("commitments").select("title, days").eq("workspace_id", ctx.wsId);
      const hit = (data ?? []).find((c) => check.match!.test(String(c.title)));
      if (hit) return { ok: true, how: `saved "${hit.title}" ${JSON.stringify(hit.days)}` };
      return check.match!.test(waitingJSON) ? { ok: true, how: "on card" } : { ok: false, how: "missing" };
    }
  }
}

async function runCase(c: MultiIntentCase, request: APIRequestContext, userId: string) {
  const { wsId, ids } = await seed(userId);
  const t0 = Date.now();
  const outcome = await sendTurn(request, wsId, c.message, userId);
  const ms = Date.now() - t0;
  const results = [];
  for (const check of c.checks) results.push({ label: check.label, ...(await judge(check, { wsId, ids, userId, outcome })) });
  const passed = results.every((r) => r.ok);
  console.log(`${passed ? "PASS" : "FAIL"} ${c.id} (${ms} ms)`);
  for (const r of results) console.log(`   ${r.ok ? "✓" : "✗"} ${r.label} — ${r.how}`);
  console.log(`   reply: ${outcome.reply.replace(/\s+/g, " ").slice(0, 220)}`);
  return { id: c.id, message: c.message, passed, results, ms, reply: outcome.reply, markers: outcome.markers, waiting: outcome.waiting, deferred: outcome.deferred };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const c of MULTI_INTENT_CASES) console.log(`${c.id}: ${c.message}`);
    return;
  }
  if (args.includes("--cleanup")) {
    const userId = await findUser();
    if (userId) await admin.auth.admin.deleteUser(userId);
    console.log("cleaned up", EMAIL);
    return;
  }
  const repeatAt = args.indexOf("--repeat");
  const repeat = repeatAt >= 0 ? Number(args[repeatAt + 1]) || 1 : 1;
  const wanted = args.filter((a, i) => !a.startsWith("--") && i !== repeatAt + 1);
  const cases = wanted.length ? MULTI_INTENT_CASES.filter((c) => wanted.includes(c.id)) : MULTI_INTENT_CASES;

  const userId = await ensureUser();
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
  await page.fill("input[type=email]", EMAIL);
  await page.fill("input[type=password]", PW);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/app", { timeout: 60_000 });
  // Leave the app: open, it makes a default workspace when it finds none —
  // racing the seed. The session cookies stay in the context.
  await page.goto("about:blank");

  const report = [];
  try {
    for (let r = 0; r < repeat; r++) for (const c of cases) report.push(await runCase(c, context.request, userId));
  } finally {
    await browser.close();
  }

  const { data: runs } = await admin.from("ai_runs").select("estimated_cost").eq("user_id", userId).gte("created_at", startedAt);
  const cost = (runs ?? []).reduce((sum, r) => sum + (Number(r.estimated_cost) || 0), 0);
  const checks = report.flatMap((r) => r.results);
  console.log(
    `\n${report.filter((r) => r.passed).length}/${report.length} messages fully done · ` +
      `${checks.filter((r) => r.ok).length}/${checks.length} intents · $${cost.toFixed(4)} (${runs?.length ?? 0} runs)`,
  );
  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/chat-intents-${startedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ startedAt, cost, report }, null, 2));
  console.log("saved", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
