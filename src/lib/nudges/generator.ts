// Nudge generator. Pure DB queries — no LLM. The cron picks up the
// candidates this returns and inserts dedup'd rows into `nudges`.
//
// Three rules:
//   1. stale          — active goal/project with no activity for 14+ days
//   2. newly_ready    — a prereq just completed; the dependent is now free
//   3. due_soon       — target_date <= now+7d, not done, no recent edits
//
// Each candidate carries its own dedup_key. The cron checks for an existing
// row with the same (user_id, dedup_key) before inserting. That keeps the
// table from accumulating duplicate pending nudges for the same situation.

import type { SupabaseClient } from "@supabase/supabase-js";

const STALE_DAYS = 14;
const DUE_SOON_DAYS = 7;
const DUE_SOON_INACTIVITY_DAYS = 3;
const NEWLY_READY_LOOKBACK_HOURS = 24;

const PREREQUISITE_EDGE_TYPES = [
  "required_for",
  "prerequisite_for",
  "depends_on",
];

export type NudgeKind = "stale" | "newly_ready" | "due_soon" | "top_priority";

export type NudgeCandidate = {
  user_id: string;
  workspace_id: string;
  node_id: string | null;
  kind: NudgeKind;
  title: string;
  body: string;
  dedup_key: string;
};

type NodeRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  title: string;
  node_type: string;
  status: string;
  updated_at: string;
  target_date: string | null;
  completed_at: string | null;
  current_importance_score?: number | null;
};

type EdgeRow = {
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  status: string;
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Rule 1: stale goal/project ──────────────────────────────────────────
// Active goal/project not edited in 14 days AND no lifecycle event for it
// in the same window. We don't recurse into descendants — keeping the
// query cheap. A noisy descendant graph is a separate signal we may add.
async function findStaleGoalsAndProjects(
  supabase: SupabaseClient,
): Promise<NudgeCandidate[]> {
  const cutoff = daysAgo(STALE_DAYS);

  const { data: nodes, error } = await supabase
    .from("nodes")
    .select("id, user_id, workspace_id, title, node_type, status, updated_at")
    .eq("status", "active")
    .in("node_type", ["goal", "project"])
    .lt("updated_at", cutoff);

  if (error || !nodes || nodes.length === 0) return [];

  const nodeIds = nodes.map((n) => n.id as string);

  // Pull lifecycle events for these nodes within the window. Any event
  // disqualifies the node from being "stale."
  const { data: recentEvents } = await supabase
    .from("lifecycle_events")
    .select("node_id")
    .in("node_id", nodeIds)
    .gte("created_at", cutoff);

  const recentlyActive = new Set(
    (recentEvents ?? []).map((e) => e.node_id as string),
  );

  return nodes
    .filter((n) => !recentlyActive.has(n.id as string))
    .map((n) => ({
      user_id: n.user_id as string,
      workspace_id: n.workspace_id as string,
      node_id: n.id as string,
      kind: "stale" as const,
      title: `"${n.title}" has been quiet`,
      body: `No progress for ${STALE_DAYS}+ days. Still relevant, or should this be archived?`,
      dedup_key: `stale:${n.id}`,
    }));
}

// ─── Rule 2: newly ready ─────────────────────────────────────────────────
// A node X has incoming prerequisite edges from Y. If Y just completed
// (lifecycle event in the last NEWLY_READY_LOOKBACK_HOURS) AND every
// other prereq of X is also completed/archived AND X itself is active,
// X just became ready to start.
async function findNewlyReady(
  supabase: SupabaseClient,
): Promise<NudgeCandidate[]> {
  const since = hoursAgo(NEWLY_READY_LOOKBACK_HOURS);

  // Recently-completed nodes.
  const { data: completions } = await supabase
    .from("lifecycle_events")
    .select("node_id, created_at, action_taken")
    .eq("action_taken", "completed")
    .gte("created_at", since);

  if (!completions || completions.length === 0) return [];

  const completedIds = [
    ...new Set(completions.map((e) => e.node_id as string)),
  ];

  // Outgoing prereq edges from those completed nodes — the dependents.
  const { data: edges } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, edge_type, status")
    .in("source_node_id", completedIds)
    .in("edge_type", PREREQUISITE_EDGE_TYPES)
    .eq("status", "active");

  if (!edges || edges.length === 0) return [];

  const dependentIds = [
    ...new Set(edges.map((e) => e.target_node_id as string)),
  ];

  // Pull each dependent + check its other prereqs are all resolved.
  const { data: dependents } = await supabase
    .from("nodes")
    .select("id, user_id, workspace_id, title, node_type, status")
    .in("id", dependentIds)
    .eq("status", "active");

  if (!dependents || dependents.length === 0) return [];

  // All incoming prereq edges for these dependents.
  const { data: allInbound } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id, edge_type, status")
    .in("target_node_id", dependentIds)
    .in("edge_type", PREREQUISITE_EDGE_TYPES)
    .eq("status", "active") as { data: EdgeRow[] | null };

  // Source nodes referenced by inbound edges — need their statuses.
  const sourceIds = [
    ...new Set((allInbound ?? []).map((e) => e.source_node_id)),
  ];
  const { data: sourceStatusRows } = await supabase
    .from("nodes")
    .select("id, title, status")
    .in("id", sourceIds.length > 0 ? sourceIds : ["00000000-0000-0000-0000-000000000000"]);

  const statusById = new Map(
    (sourceStatusRows ?? []).map(
      (r) => [r.id as string, r.status as string] as const,
    ),
  );
  const titleById = new Map(
    (sourceStatusRows ?? []).map(
      (r) => [r.id as string, r.title as string] as const,
    ),
  );

  // For each dependent, are ALL prereqs completed/archived?
  const inboundByTarget = new Map<string, EdgeRow[]>();
  for (const e of allInbound ?? []) {
    const list = inboundByTarget.get(e.target_node_id) ?? [];
    list.push(e);
    inboundByTarget.set(e.target_node_id, list);
  }

  const candidates: NudgeCandidate[] = [];
  for (const dep of dependents) {
    const depId = dep.id as string;
    const inbound = inboundByTarget.get(depId) ?? [];
    const stillBlocked = inbound.some((e) => {
      const status = statusById.get(e.source_node_id);
      return status === "active";
    });
    if (stillBlocked) continue;

    // Pick the most recently-completed unblocker for the message body.
    const justCompleted = inbound
      .map((e) => e.source_node_id)
      .filter((id) => completedIds.includes(id));
    const unblockerId = justCompleted[0];
    if (!unblockerId) continue;

    candidates.push({
      user_id: dep.user_id as string,
      workspace_id: dep.workspace_id as string,
      node_id: depId,
      kind: "newly_ready",
      title: `"${dep.title}" is ready to start`,
      body: `"${titleById.get(unblockerId) ?? "A prerequisite"}" just shipped — nothing's blocking this anymore.`,
      dedup_key: `newly_ready:${depId}:${unblockerId}`,
    });
  }

  return candidates;
}

// ─── Rule 3: due soon, no activity ──────────────────────────────────────
// Active node with target_date within DUE_SOON_DAYS that hasn't been
// touched in DUE_SOON_INACTIVITY_DAYS. The inactivity gate prevents
// re-nudging on something the user is already working on.
async function findDueSoonNoActivity(
  supabase: SupabaseClient,
): Promise<NudgeCandidate[]> {
  const horizon = daysFromNow(DUE_SOON_DAYS);
  const inactivityCutoff = daysAgo(DUE_SOON_INACTIVITY_DAYS);
  const now = new Date().toISOString();

  const { data: nodes, error } = await supabase
    .from("nodes")
    .select(
      "id, user_id, workspace_id, title, node_type, status, updated_at, target_date",
    )
    .eq("status", "active")
    .not("target_date", "is", null)
    .lte("target_date", horizon)
    .gte("target_date", now)
    .lt("updated_at", inactivityCutoff);

  if (error || !nodes || nodes.length === 0) return [];

  return (nodes as NodeRow[]).map((n) => {
    const days = Math.max(
      0,
      Math.round(
        (new Date(n.target_date!).getTime() - Date.now()) /
          (24 * 60 * 60 * 1000),
      ),
    );
    const when =
      days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    return {
      user_id: n.user_id,
      workspace_id: n.workspace_id,
      node_id: n.id,
      kind: "due_soon" as const,
      title: `"${n.title}" is due ${when}`,
      body: `No activity for ${DUE_SOON_INACTIVITY_DAYS}+ days. Want to schedule it?`,
      dedup_key: `due_soon:${n.id}:${n.target_date}`,
    };
  });
}

// ─── Rule 4: top priority, untouched ────────────────────────────────────
// The single highest-scored active, actionable node per workspace — but only
// when it's been sitting untouched for 3+ days. The whole problem we solve is
// "I don't know what to start"; this points at the ONE thing, and goes quiet
// the moment the user actually engages with it (so it never nags about work
// already in progress).
const TOP_PRIORITY_UNTOUCHED_DAYS = 2;

// "What to START" priority for the nudge: importance, biased toward things the
// user can actually start NOW (tasks/projects over abstract goals you can't
// act on) and toward imminent deadlines. The ranking eval showed raw
// importance alone points at goals ("Land an Internship") and ignores due
// dates — useless as a "start here" signal. This is selection-only; it never
// touches the stored importance score.
function startPriority(n: NodeRow): number {
  const score = n.current_importance_score ?? 0;
  const actionableBonus = n.node_type === "goal" ? 0 : 15;
  let dueBonus = 0;
  if (n.target_date) {
    const days =
      (new Date(n.target_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (days <= 14) {
      dueBonus = Math.max(0, Math.min(30, Math.round(((14 - days) / 14) * 30)));
    }
  }
  return score + actionableBonus + dueBonus;
}

async function findTopPriority(
  supabase: SupabaseClient,
): Promise<NudgeCandidate[]> {
  const touchedCutoff = daysAgo(TOP_PRIORITY_UNTOUCHED_DAYS);

  const { data: nodes, error } = await supabase
    .from("nodes")
    .select(
      "id, user_id, workspace_id, title, node_type, status, updated_at, current_importance_score, target_date",
    )
    .eq("status", "active")
    .in("node_type", ["task", "goal", "project", "habit"])
    .not("current_importance_score", "is", null);

  if (error || !nodes || nodes.length === 0) return [];

  // Highest "start priority" per workspace — deadline + actionable aware.
  const topPerWs = new Map<string, NodeRow>();
  for (const n of nodes as NodeRow[]) {
    const cur = topPerWs.get(n.workspace_id);
    if (!cur || startPriority(n) > startPriority(cur)) {
      topPerWs.set(n.workspace_id, n);
    }
  }

  // Only nudge a #1 that's itself been untouched — if they're already on it,
  // stay silent.
  const tops = [...topPerWs.values()].filter((n) => n.updated_at < touchedCutoff);
  if (tops.length === 0) return [];

  const { data: recentEvents } = await supabase
    .from("lifecycle_events")
    .select("node_id")
    .in(
      "node_id",
      tops.map((n) => n.id),
    )
    .gte("created_at", touchedCutoff);
  const touched = new Set((recentEvents ?? []).map((e) => e.node_id as string));

  // Re-fire every ~2 days while the #1 stays untouched (the user keeps avoiding
  // it) — snooze/dismiss still silence it. The 2-day bucket in the dedup key
  // lets a new nudge through each window without spamming within it.
  const bucket = Math.floor(Date.now() / (2 * 24 * 60 * 60 * 1000));
  return tops
    .filter((n) => !touched.has(n.id))
    .map((n) => ({
      user_id: n.user_id,
      workspace_id: n.workspace_id,
      node_id: n.id,
      kind: "top_priority" as const,
      title: `Start with "${n.title}"`,
      body: `This is your highest-priority next move right now, and it's been sitting untouched. Make a dent — or bump something else up if it's wrong.`,
      dedup_key: `top_priority:${n.id}:${bucket}`,
    }));
}

// ─── Entry point ─────────────────────────────────────────────────────────
export async function generateNudgeCandidates(
  supabase: SupabaseClient,
): Promise<NudgeCandidate[]> {
  const [stale, ready, due, top] = await Promise.all([
    findStaleGoalsAndProjects(supabase),
    findNewlyReady(supabase),
    findDueSoonNoActivity(supabase),
    findTopPriority(supabase),
  ]);
  return [...stale, ...ready, ...due, ...top];
}
