import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

// Owner-only, cross-user cost overview. Reads EVERY account's ai_runs rows via
// the service-role admin client, so callers MUST gate on isOwnerEmail() before
// invoking this — see [[owner.ts]]. Aggregation happens in JS (no migration /
// RPC needed): fine for an invite-only user base of a handful of accounts.

export interface OwnerUserCost {
  user_id: string;
  email: string | null;
  total_cost_usd: number;
  month_cost_usd: number;
  run_count: number;
  month_run_count: number;
  active_days: number;
  per_active_day_usd: number | null;
  projected_30d_usd: number | null;
  failed_runs: number;
  top_model: string | null;
  last_run_at: string | null;
}

export interface OwnerCostOverview {
  generated_at: string;
  month_start: string;
  user_count: number;
  total_all_time_usd: number;
  total_month_usd: number;
  users: OwnerUserCost[];
}

type AIRunCostRow = {
  user_id: string | null;
  estimated_cost: number | string | null;
  model_name: string | null;
  status: string | null;
  created_at: string;
};

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Supabase caps a single select at 1000 rows; page through the whole table.
async function fetchAllCostRows(admin: SupabaseClient): Promise<AIRunCostRow[]> {
  const PAGE = 1000;
  const MAX_PAGES = 500; // safety valve: 500k rows before we bail
  const rows: AIRunCostRow[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE;
    const { data, error } = await admin
      .from("ai_runs")
      .select("user_id, estimated_cost, model_name, status, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      throw error;
    }

    const batch = (data ?? []) as AIRunCostRow[];
    rows.push(...batch);
    if (batch.length < PAGE) {
      break;
    }
  }

  return rows;
}

// Resolve user_id -> email through the auth admin API (same paging pattern the
// ai-spend.mjs script uses). Missing users just render as "unknown".
async function fetchEmailMap(admin: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) break;
    for (const user of data.users) {
      if (user.email) {
        map.set(user.id, user.email);
      }
    }
    if (data.users.length < 200) break;
  }
  return map;
}

type UserAccumulator = {
  total: number;
  month: number;
  runs: number;
  monthRuns: number;
  failed: number;
  days: Set<string>;
  modelCounts: Map<string, number>;
  lastRunAt: string | null;
};

export async function getOwnerCostOverview(): Promise<OwnerCostOverview> {
  const admin = getSupabaseAdminClient();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthStartIso = monthStart.toISOString();

  const empty: OwnerCostOverview = {
    generated_at: now.toISOString(),
    month_start: monthStartIso,
    user_count: 0,
    total_all_time_usd: 0,
    total_month_usd: 0,
    users: [],
  };

  if (!admin) {
    return empty;
  }

  const [rows, emailMap] = await Promise.all([
    fetchAllCostRows(admin),
    fetchEmailMap(admin),
  ]);

  const byUser = new Map<string, UserAccumulator>();

  for (const row of rows) {
    const userId = row.user_id;
    if (!userId) continue;

    const acc =
      byUser.get(userId) ??
      ({
        total: 0,
        month: 0,
        runs: 0,
        monthRuns: 0,
        failed: 0,
        days: new Set<string>(),
        modelCounts: new Map<string, number>(),
        lastRunAt: null,
      } satisfies UserAccumulator);

    const cost = toNumber(row.estimated_cost);
    const isThisMonth = row.created_at >= monthStartIso;

    acc.total += cost;
    acc.runs += 1;
    if (isThisMonth) {
      acc.month += cost;
      acc.monthRuns += 1;
    }
    if (row.status && row.status !== "success") {
      acc.failed += 1;
    }
    acc.days.add(row.created_at.slice(0, 10));
    if (row.model_name) {
      acc.modelCounts.set(row.model_name, (acc.modelCounts.get(row.model_name) ?? 0) + 1);
    }
    if (!acc.lastRunAt || row.created_at > acc.lastRunAt) {
      acc.lastRunAt = row.created_at;
    }

    byUser.set(userId, acc);
  }

  const users: OwnerUserCost[] = [...byUser.entries()].map(([userId, acc]) => {
    const activeDays = acc.days.size;
    const perDay = activeDays > 0 ? acc.total / activeDays : null;
    const topModel =
      [...acc.modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      user_id: userId,
      email: emailMap.get(userId) ?? null,
      total_cost_usd: roundTo(acc.total, 6),
      month_cost_usd: roundTo(acc.month, 6),
      run_count: acc.runs,
      month_run_count: acc.monthRuns,
      active_days: activeDays,
      per_active_day_usd: perDay == null ? null : roundTo(perDay, 6),
      projected_30d_usd: perDay == null ? null : roundTo(perDay * 30, 6),
      failed_runs: acc.failed,
      top_model: topModel,
      last_run_at: acc.lastRunAt,
    };
  });

  users.sort((a, b) => {
    if (b.month_cost_usd !== a.month_cost_usd) {
      return b.month_cost_usd - a.month_cost_usd;
    }
    return b.total_cost_usd - a.total_cost_usd;
  });

  return {
    generated_at: now.toISOString(),
    month_start: monthStartIso,
    user_count: users.length,
    total_all_time_usd: roundTo(
      users.reduce((sum, user) => sum + user.total_cost_usd, 0),
      6,
    ),
    total_month_usd: roundTo(
      users.reduce((sum, user) => sum + user.month_cost_usd, 0),
      6,
    ),
    users,
  };
}
