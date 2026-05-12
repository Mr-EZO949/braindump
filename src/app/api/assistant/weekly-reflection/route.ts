// POST /api/assistant/weekly-reflection
// Returns weekly stats + AI-generated reflective commentary for the modal.
// Stats pulled from lifecycle_events (completions), plan_tasks (scheduled vs
// done), and nodes (creations + active type breakdown).
//
// AI commentary runs on Haiku — short structured reflective text. Costs
// ~$0.001/call. Cached in-memory for 5 min via the Anthropic prompt cache
// is not viable here (the user's stats vary), so this is uncached on purpose.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";

const WINDOW_DAYS = 7;

type DailyBucket = {
  date: string; // YYYY-MM-DD
  completed: number;
  created: number;
  scheduled: number;
  scheduled_done: number;
};

type TypeBucket = {
  node_type: string;
  count: number;
};

function dateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildDailyBuckets(): DailyBucket[] {
  const out: DailyBucket[] = [];
  const today = new Date();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push({
      date: dateOnly(d),
      completed: 0,
      created: 0,
      scheduled: 0,
      scheduled_done: 0,
    });
  }
  return out;
}

// Monday of the current ISO week — used as the cache key so opening the
// reflection multiple times in the same week returns the same AI commentary
// instead of regenerating on every open.
function isoWeekStart(now: Date = new Date()): string {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return dateOnly(d);
}

async function generateCommentary(stats: {
  totalCompleted: number;
  totalCreated: number;
  totalScheduled: number;
  totalScheduledDone: number;
  topType: string | null;
  windowDays: number;
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const completionRate =
    stats.totalScheduled > 0
      ? Math.round((stats.totalScheduledDone / stats.totalScheduled) * 100)
      : null;

  const prompt = `The user is reviewing their last ${stats.windowDays} days of work in BrainDump. Stats:
- Nodes completed: ${stats.totalCompleted}
- New nodes created: ${stats.totalCreated}
- Tasks scheduled in planner: ${stats.totalScheduled}
- Scheduled tasks completed: ${stats.totalScheduledDone}${
    completionRate !== null ? ` (${completionRate}% completion rate)` : ""
  }
- Most active type: ${stats.topType ?? "none"}

Write a short, honest weekly reflection (2-3 sentences max, plain text — no markdown, no bullet points). Be observant, not generic. If completion rate is low, name it without being preachy. If activity is high, acknowledge it. If activity is zero, be direct that no work was logged. End with one concrete suggestion for the upcoming week.`;

  try {
    const client = new Anthropic({ apiKey });
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 256,
      temperature: AI_TEMPERATURE.ASSISTANT,
      system:
        "You are a reflective journaling assistant. Be honest, specific, and warm. Never use markdown formatting. Never use bullet points. Keep responses to 2-3 sentences.",
      messages: [{ role: "user", content: prompt }],
    });
    const block = r.content[0];
    if (block?.type === "text") return block.text.trim();
    return null;
  } catch (err) {
    console.error("[weekly-reflection] commentary failed", err);
    return null;
  }
}

export async function POST(req: NextRequest) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspace_id, force } = body as { workspace_id?: string; force?: boolean };
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  // Verify workspace ownership
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const buckets = buildDailyBuckets();
  const bucketByDate = new Map(buckets.map((b) => [b.date, b]));
  const windowStart = buckets[0].date;

  // 1. Completed nodes in the window — pulled from lifecycle_events
  const { data: completions } = await supabase
    .from("lifecycle_events")
    .select("created_at, node_id, nodes!inner(workspace_id, node_type, title)")
    .eq("user_id", user.id)
    .eq("new_status", "completed")
    .eq("nodes.workspace_id", workspace_id)
    .gte("created_at", `${windowStart}T00:00:00.000Z`);

  const completedTypeCounts = new Map<string, number>();
  for (const row of completions ?? []) {
    const created = (row.created_at as string).slice(0, 10);
    const bucket = bucketByDate.get(created);
    if (bucket) bucket.completed++;
    const nodes = row.nodes as { node_type?: string } | { node_type?: string }[] | null;
    const nodeType = Array.isArray(nodes) ? nodes[0]?.node_type : nodes?.node_type;
    if (nodeType) {
      completedTypeCounts.set(nodeType, (completedTypeCounts.get(nodeType) ?? 0) + 1);
    }
  }

  // 2. Created nodes in the window
  const { data: created } = await supabase
    .from("nodes")
    .select("created_at, node_type")
    .eq("user_id", user.id)
    .eq("workspace_id", workspace_id)
    .gte("created_at", `${windowStart}T00:00:00.000Z`);

  for (const row of created ?? []) {
    const day = (row.created_at as string).slice(0, 10);
    const bucket = bucketByDate.get(day);
    if (bucket) bucket.created++;
  }

  // 3. Plan_tasks scheduled in the window
  const { data: scheduled } = await supabase
    .from("plan_tasks")
    .select("scheduled_date, done")
    .eq("user_id", user.id)
    .eq("workspace_id", workspace_id)
    .gte("scheduled_date", windowStart);

  for (const row of scheduled ?? []) {
    const day = row.scheduled_date as string | null;
    if (!day) continue;
    const bucket = bucketByDate.get(day);
    if (bucket) {
      bucket.scheduled++;
      if (row.done) bucket.scheduled_done++;
    }
  }

  // 4. Compute totals
  const totalCompleted = buckets.reduce((sum, b) => sum + b.completed, 0);
  const totalCreated = buckets.reduce((sum, b) => sum + b.created, 0);
  const totalScheduled = buckets.reduce((sum, b) => sum + b.scheduled, 0);
  const totalScheduledDone = buckets.reduce((sum, b) => sum + b.scheduled_done, 0);

  // 5. Type breakdown — count of completed nodes by type
  const typeBreakdown: TypeBucket[] = Array.from(completedTypeCounts.entries())
    .map(([node_type, count]) => ({ node_type, count }))
    .sort((a, b) => b.count - a.count);

  const topType = typeBreakdown[0]?.node_type ?? null;

  // 6. AI commentary — cached per (user, workspace, week_start). Stats are
  //    recomputed live above (cheap SQL); only the AI message is persisted
  //    so it stays consistent across opens within the same week. ?force=true
  //    bypasses the cache when the user explicitly wants a fresh take.
  const weekStart = isoWeekStart();
  let commentary: string | null = null;
  let cached = false;

  if (!force) {
    const { data: existing } = await supabase
      .from("weekly_reflections")
      .select("commentary")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace_id)
      .eq("week_start", weekStart)
      .maybeSingle();
    if (existing?.commentary) {
      commentary = existing.commentary as string;
      cached = true;
    }
  }

  if (!commentary) {
    commentary = await generateCommentary({
      totalCompleted,
      totalCreated,
      totalScheduled,
      totalScheduledDone,
      topType,
      windowDays: WINDOW_DAYS,
    });
    if (commentary) {
      // Best-effort persist; failure here just means we'll regenerate next
      // time, not a user-visible error.
      await supabase.from("weekly_reflections").upsert(
        {
          user_id: user.id,
          workspace_id,
          week_start: weekStart,
          commentary,
          stats_at_generation: {
            completed: totalCompleted,
            created: totalCreated,
            scheduled: totalScheduled,
            scheduled_done: totalScheduledDone,
            top_type: topType,
          },
          generated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,workspace_id,week_start" },
      );
    }
  }

  return NextResponse.json({
    window_days: WINDOW_DAYS,
    daily: buckets,
    type_breakdown: typeBreakdown,
    totals: {
      completed: totalCompleted,
      created: totalCreated,
      scheduled: totalScheduled,
      scheduled_done: totalScheduledDone,
      completion_rate:
        totalScheduled > 0 ? totalScheduledDone / totalScheduled : null,
    },
    commentary,
    commentary_cached: cached,
    week_start: weekStart,
  });
}
