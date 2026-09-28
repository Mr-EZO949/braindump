// GET /api/account/usage
// Dump-usage counters for the account panel (#12): how many small / medium /
// big brain dumps the user has run, all-time and this calendar month.
//
// There's no stored dump-size column, so the tier is DERIVED the same way it's
// shown at dump time — classifyDumpSize(number of proposed nodes for that dump).
// proposed_nodes persist (they carry user_id + raw_entry_id), so this is exact
// and needs no migration and no new writes.

import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { classifyDumpSize, type DumpSizeTier } from "@/lib/ai/dump-size";

// A "dump" is a user-initiated brain dump (typed or spoken) — not an
// assistant_save (chat-created) or planner_convert entry.
const DUMP_SOURCE_TYPES = ["brain_dump", "voice"] as const;

type TierCounts = { small: number; medium: number; big: number; total: number };

function emptyCounts(): TierCounts {
  return { small: 0, medium: 0, big: 0, total: 0 };
}

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. All dump entries for this user (id + when).
  const { data: entries, error: entriesError } = await supabase
    .from("raw_entries")
    .select("id, created_at")
    .eq("user_id", user.id)
    .in("source_type", DUMP_SOURCE_TYPES as unknown as string[]);

  if (entriesError) {
    return NextResponse.json({ error: entriesError.message }, { status: 500 });
  }

  const dumpEntries = entries ?? [];
  if (dumpEntries.length === 0) {
    return NextResponse.json({ all_time: emptyCounts(), this_month: emptyCounts() });
  }

  // 2. Count proposed nodes per raw_entry. Paginate so a heavy user with more
  //    than one page of proposals is still counted exactly (the client caps at
  //    1000 rows/query by default).
  const proposalCountByEntry = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: propsError } = await supabase
      .from("proposed_nodes")
      .select("raw_entry_id")
      .eq("user_id", user.id)
      .range(from, from + PAGE - 1);
    if (propsError) {
      return NextResponse.json({ error: propsError.message }, { status: 500 });
    }
    const rows = page ?? [];
    for (const row of rows) {
      const id = row.raw_entry_id as string | null;
      if (id) proposalCountByEntry.set(id, (proposalCountByEntry.get(id) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }

  // 3. Classify each dump by its proposed-node count and tally.
  // created_at is stored/returned in UTC, so anchor "this month" to the UTC
  // month start too (avoids an off-by-an-hour boundary from local time).
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const allTime = emptyCounts();
  const thisMonth = emptyCounts();

  const bump = (counts: TierCounts, tier: DumpSizeTier) => {
    counts[tier] += 1;
    counts.total += 1;
  };

  for (const entry of dumpEntries) {
    const nodeCount = proposalCountByEntry.get(entry.id as string) ?? 0;
    const tier = classifyDumpSize(nodeCount);
    bump(allTime, tier);
    if ((entry.created_at as string) >= monthStart) {
      bump(thisMonth, tier);
    }
  }

  return NextResponse.json({ all_time: allTime, this_month: thisMonth });
}
