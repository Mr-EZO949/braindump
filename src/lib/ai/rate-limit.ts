// Rate-limit utility for AI routes.
// Counts recent rows in ai_runs (or raw_entries for extraction) per user
// within a rolling hourly window. Uses the existing tables — no new infra.
//
// Intentional trade-off: count query runs before the request is logged, so
// highly concurrent bursts can slip through. This is acceptable for a single-
// user productivity app where the goal is stopping runaway scripts, not
// enforcing hard real-time caps.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

// Counts completed + retrying + success ai_runs of a given type in the last hour.
export async function checkAIRunRateLimit(params: {
  supabase: SupabaseClient;
  userId: string;
  runType: string;
  maxPerHour: number;
}): Promise<RateLimitResult> {
  const { supabase, userId, runType, maxPerHour } = params;
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { count } = await supabase
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("run_type", runType)
    .gte("created_at", windowStart);

  const used = count ?? 0;
  return {
    allowed: used < maxPerHour,
    remaining: Math.max(0, maxPerHour - used),
    resetAt,
  };
}

// Counts raw_entries (brain dumps) in the last hour — used for extraction.
export async function checkEntryRateLimit(params: {
  supabase: SupabaseClient;
  userId: string;
  maxPerHour: number;
}): Promise<RateLimitResult> {
  const { supabase, userId, maxPerHour } = params;
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { count } = await supabase
    .from("raw_entries")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", windowStart);

  const used = count ?? 0;
  return {
    allowed: used < maxPerHour,
    remaining: Math.max(0, maxPerHour - used),
    resetAt,
  };
}

// Returns a 429 Response with Retry-After header. Import NextResponse at call site.
export function rateLimitResponse(result: RateLimitResult): ReturnType<typeof NextResponse.json> {
  const { NextResponse } = require("next/server") as typeof import("next/server");
  return NextResponse.json(
    { error: "Rate limit exceeded. Try again later.", reset_at: result.resetAt },
    {
      status: 429,
      headers: {
        "Retry-After": "3600",
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": result.resetAt,
      },
    },
  );
}
