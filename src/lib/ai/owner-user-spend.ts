import type { SupabaseClient } from "@supabase/supabase-js";

import { outputCostUSD } from "./usage";

// One account's AI spend, broken down the way the owner asks about it (owner
// 2026-10-06): what each kind of request costs, on which model, input vs
// output, how much came from the prompt cache, per day, and the calls
// themselves. Reads that user's ai_runs rows with the service-role client —
// callers MUST gate on isOwnerEmail() first (see owner-cost.ts).

export interface SpendRunRow {
  run_type: string;
  provider: string;
  model_name: string;
  prompt_version: string;
  estimated_cost: number | string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  latency_ms: number | null;
  status: string | null;
  error_text: string | null;
  created_at: string;
}

export interface SpendGroup {
  key: string;
  label: string;
  model: string;
  runs: number;
  cost: number;
  input_cost: number;
  output_cost: number;
  avg_cost: number;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  // Share of input tokens read from the cache, over runs that report it.
  cache_read_share: number | null;
}

export interface SpendDay {
  day: string;
  runs: number;
  cost: number;
  top: Array<{ label: string; cost: number }>;
}

export interface SpendCall {
  created_at: string;
  label: string;
  model: string;
  prompt_version: string;
  cost: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  latency_ms: number | null;
  status: string;
  error_text: string | null;
}

export interface UserSpendSummary {
  runs: number;
  failed: number;
  cost: number;
  input_cost: number;
  output_cost: number;
  active_days: number;
  per_active_day: number | null;
  projected_30d: number | null;
  cache_read_tokens: number;
  cache_write_tokens: number;
  // Input tokens of the runs that report cache numbers (the share's base).
  cache_reported_input_tokens: number;
  by_operation: SpendGroup[];
  by_model: SpendGroup[];
  by_day: SpendDay[];
  most_expensive: SpendCall[];
  // Embeddings left out: one per node, ~free, they'd fill the list.
  recent: SpendCall[];
}

// What a request is, in words, from its prompt family (the version and the
// mode suffixes dropped). Unknown families show as themselves.
const OPERATION_LABELS: Record<string, string> = {
  extract: "Long dump — graph builder",
  "extract-light": "Short dump / chat build — graph builder",
  assistant: "Chat",
  "assistant-qa": "Chat — plain question (Gemini)",
  "infer-edge": "Connections",
  plan: "Day plan",
  steps: "Steps / roadmap",
  judgment: "Judgment (node significance)",
  "dump-priorities": "Dump — priorities & commitments",
  "dump-reply": "Dump — reply",
  "classify-dump": "Is it a dump?",
  "suggest-areas": "Area suggestions",
  "merge-check": "Duplicate check",
  "weekly-reflection": "Weekly reflection",
  embed: "Embeddings",
  "embed-batch": "Embeddings",
  rerank: "Rerank (Cohere)",
};

export function promptFamily(promptVersion: string): string {
  return promptVersion.split(":")[0].replace(/[-_]v\d+$/, "");
}

export function operationLabel(run: Pick<SpendRunRow, "prompt_version">): string {
  const family = promptFamily(run.prompt_version);
  const base = OPERATION_LABELS[family] ?? family;
  // Pressing Accept / a choice on a chat card is its own (smaller) call.
  if (family === "assistant" && /:resume-/.test(run.prompt_version)) return `${base} — after Accept / choice`;
  return base;
}

function num(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function localDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone });
}

type Acc = {
  label: string;
  model: string;
  runs: number;
  cost: number;
  output_cost: number;
  inTok: number;
  inTokRuns: number;
  outTok: number;
  outTokRuns: number;
  cacheRead: number;
  cacheBase: number;
};

function toGroup(key: string, a: Acc): SpendGroup {
  return {
    key,
    label: a.label,
    model: a.model,
    runs: a.runs,
    cost: a.cost,
    input_cost: Math.max(a.cost - a.output_cost, 0),
    output_cost: a.output_cost,
    avg_cost: a.runs ? a.cost / a.runs : 0,
    avg_input_tokens: a.inTokRuns ? Math.round(a.inTok / a.inTokRuns) : null,
    avg_output_tokens: a.outTokRuns ? Math.round(a.outTok / a.outTokRuns) : null,
    cache_read_share: a.cacheBase > 0 ? a.cacheRead / a.cacheBase : null,
  };
}

export function summarizeUserSpend(rows: SpendRunRow[], opts: { timeZone?: string } = {}): UserSpendSummary {
  const timeZone = opts.timeZone ?? "Europe/Rome";
  const ops = new Map<string, Acc>();
  const models = new Map<string, Acc>();
  const days = new Map<string, { runs: number; cost: number; ops: Map<string, number> }>();
  const calls: SpendCall[] = [];
  let failed = 0;
  let cost = 0;
  let outputCost = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheBase = 0;

  const add = (map: Map<string, Acc>, key: string, label: string, run: SpendRunRow, c: number, out: number) => {
    const a =
      map.get(key) ??
      { label, model: run.model_name, runs: 0, cost: 0, output_cost: 0, inTok: 0, inTokRuns: 0, outTok: 0, outTokRuns: 0, cacheRead: 0, cacheBase: 0 };
    a.runs += 1;
    a.cost += c;
    a.output_cost += out;
    if (run.input_tokens != null) {
      a.inTok += run.input_tokens;
      a.inTokRuns += 1;
    }
    if (run.output_tokens != null) {
      a.outTok += run.output_tokens;
      a.outTokRuns += 1;
    }
    if (run.cache_read_tokens != null && run.input_tokens) {
      a.cacheRead += run.cache_read_tokens;
      a.cacheBase += run.input_tokens;
    }
    map.set(key, a);
  };

  for (const run of rows) {
    const c = num(run.estimated_cost);
    const out = Math.min(outputCostUSD(run.provider, run.model_name, run.output_tokens), c);
    const label = operationLabel(run);
    cost += c;
    outputCost += out;
    if (run.status && run.status !== "success") failed += 1;
    if (run.cache_read_tokens != null && run.input_tokens) {
      cacheRead += run.cache_read_tokens;
      cacheBase += run.input_tokens;
    }
    cacheWrite += run.cache_write_tokens ?? 0;

    add(ops, `${label}|${run.model_name}`, label, run, c, out);
    add(models, run.model_name, run.model_name, run, c, out);

    const day = localDay(run.created_at, timeZone);
    const d = days.get(day) ?? { runs: 0, cost: 0, ops: new Map<string, number>() };
    d.runs += 1;
    d.cost += c;
    d.ops.set(label, (d.ops.get(label) ?? 0) + c);
    days.set(day, d);

    calls.push({
      created_at: run.created_at,
      label,
      model: run.model_name,
      prompt_version: run.prompt_version,
      cost: c,
      input_tokens: run.input_tokens,
      output_tokens: run.output_tokens,
      cache_read_tokens: run.cache_read_tokens ?? null,
      cache_write_tokens: run.cache_write_tokens ?? null,
      latency_ms: run.latency_ms,
      status: run.status ?? "success",
      error_text: run.error_text,
    });
  }

  const byCost = (a: { cost: number }, b: { cost: number }) => b.cost - a.cost;
  const activeDays = days.size;
  return {
    runs: rows.length,
    failed,
    cost,
    input_cost: Math.max(cost - outputCost, 0),
    output_cost: outputCost,
    active_days: activeDays,
    per_active_day: activeDays ? cost / activeDays : null,
    projected_30d: activeDays ? (cost / activeDays) * 30 : null,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cache_reported_input_tokens: cacheBase,
    by_operation: [...ops].map(([key, a]) => toGroup(key, a)).sort(byCost),
    by_model: [...models].map(([key, a]) => toGroup(key, a)).sort(byCost),
    by_day: [...days]
      .map(([day, d]) => ({
        day,
        runs: d.runs,
        cost: d.cost,
        top: [...d.ops].map(([label, c]) => ({ label, cost: c })).sort(byCost).slice(0, 3),
      }))
      .sort((a, b) => (a.day < b.day ? 1 : -1)),
    most_expensive: [...calls].sort(byCost).slice(0, 10),
    recent: calls
      .filter((c) => !c.model.includes("embedding"))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 50),
  };
}

const RUN_COLUMNS =
  "run_type, provider, model_name, prompt_version, estimated_cost, input_tokens, output_tokens, latency_ms, status, error_text, created_at";

// Every run of one user since `sinceIso` (all time when null), paged past the
// API's 1,000-row cap. Asks for the cache columns, and again without them
// while migration 20261006000000 isn't applied.
export async function fetchUserRuns(
  admin: SupabaseClient,
  userId: string,
  sinceIso: string | null,
): Promise<SpendRunRow[]> {
  const load = async (columns: string) => {
    const rows: SpendRunRow[] = [];
    for (let from = 0; from < 500_000; from += 1000) {
      let query = admin.from("ai_runs").select(columns).eq("user_id", userId);
      if (sinceIso) query = query.gte("created_at", sinceIso);
      const { data, error } = await query.order("created_at", { ascending: true }).range(from, from + 999);
      if (error) throw error;
      const batch = (data ?? []) as unknown as SpendRunRow[];
      rows.push(...batch);
      if (batch.length < 1000) break;
    }
    return rows;
  };
  try {
    return await load(`${RUN_COLUMNS}, cache_read_tokens, cache_write_tokens`);
  } catch {
    return load(RUN_COLUMNS);
  }
}
