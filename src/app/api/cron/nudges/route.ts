// GET /api/cron/nudges
// Generates new nudges by running the three rule functions against every
// user's graph. Dedup'd against existing pending/seen/snoozed rows so we
// never spam the same situation twice.
//
// Triggered by Vercel Cron (vercel.json). Authorization: Bearer <CRON_SECRET>.

import { type NextRequest, NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { generateNudgeCandidates } from "@/lib/nudges/generator";
import { deliverPushForNudges } from "@/lib/nudges/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A dedup_key with one of these statuses suppresses a new insert. 'dismissed'
// and 'actioned' suppress forever — the user told us what to do with this
// situation. 'pending' suppresses because the user hasn't seen it yet. 'seen'
// and 'snoozed' suppress within their respective cooldowns (see below).
const SEEN_COOLDOWN_DAYS = 7;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    req.headers.get("authorization") !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 },
    );
  }

  const candidates = await generateNudgeCandidates(supabase);
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, candidates: 0 });
  }

  // Suppression check — pull existing rows that match any candidate's
  // (user_id, dedup_key) pair, then filter in-memory.
  const userIds = [...new Set(candidates.map((c) => c.user_id))];
  const dedupKeys = [...new Set(candidates.map((c) => c.dedup_key))];
  const { data: existing } = await supabase
    .from("nudges")
    .select("user_id, dedup_key, status, snoozed_until, updated_at")
    .in("user_id", userIds)
    .in("dedup_key", dedupKeys);

  const seenCutoff = new Date(
    Date.now() - SEEN_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const now = new Date().toISOString();
  const suppressed = new Set<string>();
  for (const row of (existing ?? []) as Array<{
    user_id: string;
    dedup_key: string;
    status: string;
    snoozed_until: string | null;
    updated_at: string;
  }>) {
    const key = `${row.user_id}|${row.dedup_key}`;
    if (
      row.status === "pending" ||
      row.status === "dismissed" ||
      row.status === "actioned"
    ) {
      suppressed.add(key);
    } else if (row.status === "snoozed") {
      if (row.snoozed_until && row.snoozed_until > now) suppressed.add(key);
    } else if (row.status === "seen") {
      if (row.updated_at > seenCutoff) suppressed.add(key);
    }
  }

  const toInsert = candidates.filter(
    (c) => !suppressed.has(`${c.user_id}|${c.dedup_key}`),
  );

  if (toInsert.length === 0) {
    return NextResponse.json({
      ok: true,
      inserted: 0,
      candidates: candidates.length,
      suppressed: suppressed.size,
    });
  }

  const { data: insertedRows, error: insertError, count } = await supabase
    .from("nudges")
    .insert(toInsert, { count: "exact" })
    .select("id, user_id, title, body, node_id");

  if (insertError) {
    console.error("[cron/nudges] insert failed:", insertError.message);
    return NextResponse.json(
      { error: insertError.message, inserted: 0 },
      { status: 500 },
    );
  }

  // Web push — best-effort. No VAPID → no-op silently.
  const pushResult = await deliverPushForNudges(
    supabase,
    (insertedRows ?? []) as Array<{
      id: string;
      user_id: string;
      title: string;
      body: string;
      node_id: string | null;
    }>,
  ).catch((err) => {
    console.error("[cron/nudges] push delivery failed:", err);
    return { sent: 0, pruned: 0 };
  });

  const result = {
    ok: true,
    inserted: count ?? toInsert.length,
    candidates: candidates.length,
    suppressed: suppressed.size,
    push_sent: pushResult.sent,
    push_pruned: pushResult.pruned,
    ran_at: new Date().toISOString(),
  };
  console.log("[cron/nudges]", result);
  return NextResponse.json(result);
}
