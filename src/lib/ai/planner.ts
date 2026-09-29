// Planner candidate set builder — Phase 10.1
// Selects candidate graph work, standalone manual planner items, and preference
// hints learned from recent plan edits/rejections.

import type { NodeType } from "@/types/graph";
import { todayLocalISO } from "@/lib/habits/streak";
import { KNOWLEDGE_TYPES, STRUCTURE_TYPES } from "@/lib/graph/node-types";
import {
  createRankingContext,
  daysBetween,
  relativeDue,
  type RankNode,
} from "@/lib/graph/priority-signals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

const MAX_CANDIDATES = 20;
// Focus's hero + alternatives: at most one step per deadline among these.
const FOCUS_HEAD_SIZE = 3;
// Nodes loaded per workspace: candidates plus the parents their deadlines,
// stakes and holds are inherited from.
const MAX_NODES_LOADED = 400;
// Lifecycle/chat history window for momentum, rotation and neglect.
const HISTORY_WINDOW_DAYS = 7;
const STEER_WINDOW_DAYS = 30;
const MAX_MANUAL_ITEMS = 6;
const RECENTLY_UNBLOCKED_WINDOW_HOURS = 24;
const RECENT_PLAN_WINDOW_DAYS = 7;
const DUE_SOON_WINDOW_DAYS = 7;
const PLANNER_FEEDBACK_WINDOW_DAYS = 30;
const TITLE_PREVIEW_LIMIT = 2;

// ─── Planner priority weights ────────────────────────────────────────────
//
// All tunables for `computePlannerPriority` live in this block. The numbers
// encode product intent ("dependency-just-cleared beats due-soon beats
// carried-over") rather than historical tuning. To re-tune the planner:
// change a number HERE, not in arithmetic somewhere downstream.
//
// Relative magnitudes are sanity-checked at module load.

/** Per-node-type base priority. Higher = more likely to be planned today. */
const PRIMARY_NODE_TYPE_PRIORITY: Record<NodeType, number> = {
  // task and habit are the most actionable units — both anchor the plan
  task: 120,
  habit: 98,
  // a big task with no steps yet plans as one "work session" block; once it
  // has steps it's a cluster anchor and its steps are planned instead
  big_task: 112,
  // goal frames direction but isn't itself executable in a session
  goal: 104,
  // project contains tasks but isn't actionable on its own
  project: 70,
  // class is a container for sessions/exams; the sessions are what plan
  class: 62,
  // idea/note/area are never planned (NON_ACTIONABLE_TYPES); the numbers only
  // keep the map total
  idea: 36,
  note: 30,
  area: 20,
};
const NODE_TYPE_PRIORITY_FALLBACK = 40;

/**
 * Positive contributions. Numbers chosen so the ORDER reflects priority:
 *   recently_unblocked > due_soon > carried_over > unlocks-bonus.
 * If the user complains that due-dates are getting buried under unblocked
 * items (or vice-versa), retune these constants — don't add new signals.
 */
const PLANNER_BONUSES = {
  /** A prerequisite just completed; this node finally became actionable. */
  RECENTLY_UNBLOCKED: 300,
  /** target_date within 7 days. */
  DUE_SOON: 240,
  /** A committed-cadence habit (daily / N-per-week) that's due this period —
   *  you said you'd do this and haven't yet. Just under a dated deadline. */
  CADENCE_DUE: 220,
  /** User previously planned this and didn't get to it. */
  CARRIED_OVER: 170,
  /** Has downstream dependents — completing this unlocks more work. */
  UNLOCKS_BASE: 120,
  UNLOCKS_PER_DEPENDENT: 18,
  /** Bonus cap so a chain-hub doesn't dwarf urgency signals. */
  UNLOCKS_MAX_BONUS: 72,
  /**
   * Ranking v2: deadline pressure (0–100, lead-time aware, inherited from a
   * dated parent) × this = up to +260. Replaces the old flat +240 that only
   * fired for calendar entries — node deadlines used to be invisible here.
   */
  DEADLINE_PER_PRESSURE: 2.6,
  /** Later open steps of the same deadline get this share — Focus shows the
   *  next step of each deadline, not three steps of the same exam. */
  DEADLINE_SIBLING_FACTOR: 0.55,
  /**
   * "Focus on X" per unit of (decaying) steering. An explicit instruction
   * beats a leftover (CARRIED_OVER) and ties a due habit, but an imminent
   * deadline (pressure ≳ 85) still wins.
   */
  STEER: 220,
  /** Yesterday's cluster still has deadline pressure → keep going on it. */
  MOMENTUM: 60,
  /** A dated cluster untouched for 3+ days: +20 per day past 2, capped. */
  NEGLECT_PER_DAY: 20,
  NEGLECT_MAX: 80,
  /** A waiting node whose check-back date arrived: one quick decision. */
  CHECK_BACK: 330,
} as const;

/** Momentum replaces rotation when the cluster's deadline pressure is at least this. */
const MOMENTUM_MIN_PRESSURE = 40;
/** Carried over this many times → suggest breaking it down instead. */
const CARRIED_OVER_BREAKDOWN_AT = 3;

/**
 * Negative contributions. Penalties are smaller than the corresponding
 * bonuses on purpose: a node should stay visible even when blocked so the
 * user can review it, just demoted in the ranking.
 */
const PLANNER_PENALTIES = {
  /** Has unmet structural prerequisites — can't really be started. */
  PREREQ_BASE: 70,
  PREREQ_PER_EXTRA: 12,
  PREREQ_MAX_PENALTY: 36,
  /** Has soft blockers (depends_on / blocks edges). */
  BLOCKER_BASE: 42,
  BLOCKER_PER_EXTRA: 8,
  BLOCKER_MAX_PENALTY: 24,
  /**
   * This node's project cluster was already worked yesterday AND there's an
   * untouched cluster available — demote so Focus rotates to neglected work
   * instead of repeating yesterday. Smaller than the urgency bonuses on
   * purpose: a genuinely due item (deadline, ready-to-start) from yesterday's
   * project still outranks a fresh-but-idle task elsewhere. Rotation nudges,
   * it doesn't override urgency.
   */
  ROTATION: 130,
} as const;

/**
 * Importance is 0–100 from the scoring module. Multiply into planner-priority
 * space so a high-importance node (95) ranks similarly to a recently-unblocked
 * task (95 * 1.8 = 171 ≈ low end of CARRIED_OVER).
 */
const IMPORTANCE_PRIORITY_WEIGHT = 1.8;

// Static design invariants. If a future tuner accidentally inverts these,
// fail at module load instead of producing subtly wrong plans.
if (PLANNER_BONUSES.RECENTLY_UNBLOCKED <= PLANNER_BONUSES.DUE_SOON) {
  throw new Error(
    "[planner] RECENTLY_UNBLOCKED must outrank DUE_SOON — newly-actionable work is the strongest signal",
  );
}
if (PLANNER_BONUSES.DUE_SOON <= PLANNER_BONUSES.CADENCE_DUE) {
  throw new Error(
    "[planner] DUE_SOON must outrank CADENCE_DUE — a dated deadline beats a cadence commitment",
  );
}
if (PLANNER_BONUSES.CADENCE_DUE <= PLANNER_BONUSES.CARRIED_OVER) {
  throw new Error(
    "[planner] CADENCE_DUE must outrank CARRIED_OVER — a due habit beats a leftover",
  );
}

const PREREQUISITE_EDGE_TYPES = new Set(["prerequisite_for", "required_for"]);
const BLOCKER_EDGE_TYPES = new Set(["blocks", "depends_on"]);

export interface PlannerCandidate {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  recently_unblocked: boolean;
  planning_signals: string[];
  /** A waiting node whose check-back date arrived — a decision, not work to schedule. */
  check_back?: boolean;
}

export interface PlannerManualItem {
  id: string;
  title: string;
  scheduled_date: string | null;
  start_time: string | null;
  duration_minutes: number | null;
}

export interface PlannerCandidateBundle {
  candidates: PlannerCandidate[];
  manual_items: PlannerManualItem[];
  preference_hints: string[];
}

type NodeRow = {
  current_importance_score: number | null;
  id: string;
  node_type: NodeType;
  status: string | null;
  summary: string | null;
  body: string | null;
  title: string;
  habit_target_per_week: number | null;
  created_at: string;
  target_date: string | null;
  stakes: number | null;
  waiting_for: string | null;
  resume_on: string | null;
  reading_order: number | null;
};

type EdgeRow = {
  edge_type: string;
  source_node_id: string;
  status: string | null;
  target_node_id: string;
};

type PlanTaskRow = {
  created_at: string;
  duration_minutes: number | null;
  id: string;
  node_id: string | null;
  scheduled_date: string | null;
  start_time: string | null;
  title: string;
};

type PlanFeedbackEventRow = {
  created_at: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
};

function isoDateDaysFromNow(days: number) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function summarizeTitles(titles: string[]) {
  const unique = [...new Set(titles.filter(Boolean))];
  if (unique.length === 0) {
    return "";
  }

  if (unique.length <= TITLE_PREVIEW_LIMIT) {
    return unique.join(" and ");
  }

  return `${unique.slice(0, TITLE_PREVIEW_LIMIT).join(", ")} +${unique.length - TITLE_PREVIEW_LIMIT} more`;
}

function parseCountMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, number>;
  }

  return Object.entries(value).reduce<Record<string, number>>((acc, [key, rawCount]) => {
    if (typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0) {
      acc[key] = rawCount;
    }
    return acc;
  }, {});
}

function buildPlannerPreferenceHints(feedbackEvents: PlanFeedbackEventRow[]) {
  const removedTypeCounts = new Map<string, number>();

  for (const event of feedbackEvents) {
    const metadata = event.metadata ?? {};
    const removedCounts = parseCountMap((metadata as Record<string, unknown>).removed_block_types);
    const rejectedCounts = parseCountMap((metadata as Record<string, unknown>).rejected_block_types);

    for (const [blockType, count] of Object.entries(removedCounts)) {
      removedTypeCounts.set(blockType, (removedTypeCounts.get(blockType) ?? 0) + count);
    }

    for (const [blockType, count] of Object.entries(rejectedCounts)) {
      removedTypeCounts.set(blockType, (removedTypeCounts.get(blockType) ?? 0) + count);
    }
  }

  const ranked = [...removedTypeCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);

  return ranked.flatMap(([blockType]) => {
    if (blockType === "admin") {
      return ["The user often removes admin blocks. Keep them sparse unless they are clearly urgent."];
    }

    if (blockType === "buffer") {
      return ["The user often trims buffer blocks. Keep buffers lean and only where they protect the schedule."];
    }

    if (blockType === "break") {
      return ["The user often cuts break blocks. Include them when the session length truly needs one, not by default."];
    }

    if (blockType === "focus") {
      return ["The user often cuts focus blocks. Keep them tightly tied to the clearest high-value work."];
    }

    return [];
  });
}

// ─── Priority signal helpers ─────────────────────────────────────────────
//
// Each helper returns the contribution of one signal to the final priority.
// Splitting them out lets the main function read as a sum of intentions
// instead of a wall of arithmetic, and makes each piece individually
// testable.

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function nodeTypeBasePriority(nodeType: NodeType): number {
  return PRIMARY_NODE_TYPE_PRIORITY[nodeType] ?? NODE_TYPE_PRIORITY_FALLBACK;
}

function unlocksBonus(unlocksCount: number): number {
  if (unlocksCount <= 0) return 0;
  return (
    PLANNER_BONUSES.UNLOCKS_BASE +
    Math.min(
      PLANNER_BONUSES.UNLOCKS_MAX_BONUS,
      unlocksCount * PLANNER_BONUSES.UNLOCKS_PER_DEPENDENT,
    )
  );
}

function prerequisitePenalty(prerequisiteCount: number): number {
  if (prerequisiteCount <= 0) return 0;
  return (
    PLANNER_PENALTIES.PREREQ_BASE +
    Math.min(
      PLANNER_PENALTIES.PREREQ_MAX_PENALTY,
      prerequisiteCount * PLANNER_PENALTIES.PREREQ_PER_EXTRA,
    )
  );
}

function blockerPenalty(blockerCount: number): number {
  if (blockerCount <= 0) return 0;
  return (
    PLANNER_PENALTIES.BLOCKER_BASE +
    Math.min(
      PLANNER_PENALTIES.BLOCKER_MAX_PENALTY,
      blockerCount * PLANNER_PENALTIES.BLOCKER_PER_EXTRA,
    )
  );
}

function importanceContribution(score: number | null): number {
  return Math.round((score ?? 0) * IMPORTANCE_PRIORITY_WEIGHT);
}

/**
 * Is a cadence habit "due" right now? Pure + unit-tested.
 *
 * - Already done today → never due (don't re-surface what you just did).
 * - No cadence target → not a tracked-cadence habit, never boosted here.
 * - Daily (target ≥ 7) → due whenever it's not yet done today.
 * - N-per-week → surfaces once you're behind pace: when the days left this week
 *   (incl. today) are about to run short for the sessions you still owe. So a
 *   3×/week habit stays quiet early in the week and nudges from mid-week; a
 *   high-frequency target (5–6/week) is naturally near-daily by design.
 *
 * dayOfWeek is ISO: 1 = Monday … 7 = Sunday.
 */
export function cadenceDue(params: {
  targetPerWeek: number | null;
  completionsThisWeek: number;
  doneToday: boolean;
  dayOfWeek: number;
}): boolean {
  const { targetPerWeek, completionsThisWeek, doneToday, dayOfWeek } = params;
  if (doneToday) return false;
  if (targetPerWeek == null) return false;
  const remaining = targetPerWeek - completionsThisWeek;
  if (remaining <= 0) return false; // already hit this week's target
  if (targetPerWeek >= 7) return true; // daily — due any day it's not yet done
  const daysLeftIncludingToday = 8 - dayOfWeek; // Mon → 7 … Sun → 1
  // Nudge once you're within a day of needing every remaining day this week.
  return daysLeftIncludingToday <= remaining + 1;
}

/**
 * Should this candidate be demoted for rotation? Pure. True only when its
 * project cluster was worked yesterday AND there's an untouched cluster to
 * offer instead — so a single-project user is never demoted into emptiness.
 */
export function rotationDemoted(params: {
  clusterTouchedYesterday: boolean;
  untouchedClusterAvailable: boolean;
}): boolean {
  return params.clusterTouchedYesterday && params.untouchedClusterAvailable;
}

/**
 * Combine signals into a single priority number for ranking planner
 * candidates. Higher = more deserving of a slot in today's plan.
 *
 * Reads top-down as a sum of intentions: base type, then bonuses (good
 * reasons to plan it), then penalties (reasons not to), then importance.
 * Exported so it can be tested in isolation.
 */
export function computePlannerPriority(params: {
  dueSoon: boolean;
  cadenceDue: boolean;
  carriedOver: boolean;
  currentImportanceScore: number | null;
  recentlyUnblocked: boolean;
  nodeType: NodeType;
  blockerCount: number;
  prerequisiteCount: number;
  unlocksCount: number;
  rotationDemoted: boolean;
  /** Ranking v2 — deadline pressure 0–100 (own or inherited). */
  deadlinePressure?: number;
  /** 1 for the next open step of a deadline, DEADLINE_SIBLING_FACTOR for later ones. */
  siblingFactor?: number;
  /** Net decaying steering, roughly −2…2. */
  steer?: number;
  momentum?: boolean;
  /** Days a dated cluster has gone untouched (0 = touched recently). */
  neglectDays?: number;
}): number {
  return (
    nodeTypeBasePriority(params.nodeType) +
    (params.recentlyUnblocked ? PLANNER_BONUSES.RECENTLY_UNBLOCKED : 0) +
    (params.dueSoon ? PLANNER_BONUSES.DUE_SOON : 0) +
    deadlineBonus(params.deadlinePressure ?? 0, params.siblingFactor ?? 1) +
    (params.cadenceDue ? PLANNER_BONUSES.CADENCE_DUE : 0) +
    (params.carriedOver ? PLANNER_BONUSES.CARRIED_OVER : 0) +
    unlocksBonus(params.unlocksCount) -
    prerequisitePenalty(params.prerequisiteCount) -
    blockerPenalty(params.blockerCount) -
    (params.rotationDemoted ? PLANNER_PENALTIES.ROTATION : 0) +
    (params.momentum ? PLANNER_BONUSES.MOMENTUM : 0) +
    neglectBonus(params.neglectDays ?? 0) +
    Math.round(PLANNER_BONUSES.STEER * (params.steer ?? 0)) +
    importanceContribution(params.currentImportanceScore)
  );
}

export function deadlineBonus(pressure: number, siblingFactor = 1): number {
  return Math.round(PLANNER_BONUSES.DEADLINE_PER_PRESSURE * pressure * siblingFactor);
}

export function neglectBonus(neglectDays: number): number {
  if (neglectDays < 3) return 0;
  return Math.min(PLANNER_BONUSES.NEGLECT_MAX, PLANNER_BONUSES.NEGLECT_PER_DAY * (neglectDays - 2));
}

/**
 * Rotation vs momentum for a candidate whose cluster was worked yesterday.
 * With deadline pressure, keep going (switching costs more than it helps);
 * without it, rotate to neglected work — but only when there is some.
 */
export function rhythmFor(params: {
  clusterTouchedYesterday: boolean;
  untouchedClusterAvailable: boolean;
  deadlinePressure: number;
}): { momentum: boolean; rotationDemoted: boolean } {
  if (!params.clusterTouchedYesterday) return { momentum: false, rotationDemoted: false };
  if (params.deadlinePressure >= MOMENTUM_MIN_PRESSURE) return { momentum: true, rotationDemoted: false };
  return {
    momentum: false,
    rotationDemoted: rotationDemoted({
      clusterTouchedYesterday: true,
      untouchedClusterAvailable: params.untouchedClusterAvailable,
    }),
  };
}

function sortManualItems(a: PlanTaskRow, b: PlanTaskRow) {
  const aHasDate = Boolean(a.scheduled_date);
  const bHasDate = Boolean(b.scheduled_date);

  if (aHasDate !== bHasDate) {
    return aHasDate ? -1 : 1;
  }

  if (a.scheduled_date && b.scheduled_date && a.scheduled_date !== b.scheduled_date) {
    return a.scheduled_date.localeCompare(b.scheduled_date);
  }

  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

export async function buildPlannerCandidates(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  /** The user's local date (YYYY-MM-DD) — see the rhythm-window note below.
   *  Falls back to the server's local date when absent. */
  clientToday?: string;
  /** The user's Date.getTimezoneOffset() (minutes; UTC−local). Falls back to
   *  the server's offset. */
  clientTzOffsetMinutes?: number;
}): Promise<PlannerCandidateBundle> {
  const unblockedAfter = new Date(
    Date.now() - RECENTLY_UNBLOCKED_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const recentPlanAfter = new Date(
    Date.now() - RECENT_PLAN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const feedbackAfter = new Date(
    Date.now() - PLANNER_FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const dueSoonCutoff = isoDateDaysFromNow(DUE_SOON_WINDOW_DAYS);

  // Rhythm windows — all anchored to the USER's timezone, not the server's.
  // habit_completions.completed_on is the user's LOCAL date, and hosted servers
  // run in UTC, so using the server clock would be a full day off for non-UTC
  // users. The client passes its local date + tz offset; we fall back to the
  // server's local time only when they're absent.
  const tzOffsetMin =
    typeof params.clientTzOffsetMinutes === "number" &&
    Number.isFinite(params.clientTzOffsetMinutes)
      ? params.clientTzOffsetMinutes
      : new Date().getTimezoneOffset();
  const todayDate =
    typeof params.clientToday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.clientToday)
      ? params.clientToday
      : todayLocalISO();
  // User's local midnight today, as a UTC instant (for the timestamp columns
  // lifecycle_events.created_at / chat_sessions.last_message_at).
  const todayStartMs = Date.parse(`${todayDate}T00:00:00.000Z`) + tzOffsetMin * 60_000;
  const todayStart = new Date(todayStartMs).toISOString();
  const yesterdayStart = new Date(todayStartMs - 24 * 60 * 60 * 1000).toISOString();
  const historyStart = new Date(
    todayStartMs - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const steerAfter = new Date(
    Date.now() - STEER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  // ISO weekday from the date string (parsed at noon UTC to dodge any edge):
  // Mon=1 … Sun=7.
  const rawDow = new Date(`${todayDate}T12:00:00.000Z`).getUTCDay();
  const isoDayOfWeek = rawDow === 0 ? 7 : rawDow;
  const weekMonday = new Date(
    Date.parse(`${todayDate}T12:00:00.000Z`) - (isoDayOfWeek - 1) * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const [
    nodesResult,
    edgesResult,
    cascadeResult,
    recentPlanBlocksResult,
    planTasksResult,
    planFeedbackEventsResult,
    lifecycleSinceYesterdayResult,
    habitCompletionsThisWeekResult,
    chatSessionsSinceYesterdayResult,
    steerEventsResult,
  ] = await Promise.all([
    // Active AND paused: paused nodes (and everything under them) are on hold,
    // and a paused node whose check-back date arrived comes back into Focus.
    params.supabase
      .from("nodes")
      .select(
        "id, title, summary, body, node_type, status, current_importance_score, habit_target_per_week, created_at, target_date, stakes, waiting_for, resume_on, reading_order",
      )
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .or("status.eq.active,status.eq.paused,status.is.null")
      .limit(MAX_NODES_LOADED),

    params.supabase
      .from("edges")
      .select("source_node_id, target_node_id, edge_type, status")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .not("status", "in", '("orphaned","user_rejected")'),

    params.supabase
      .from("cascade_results")
      .select(
        `
        affected_node_id,
        lifecycle_events!inner(created_at, node_id, nodes!inner(workspace_id, user_id))
      `,
      )
      .eq("action_taken", "unblocked")
      .gte("lifecycle_events.created_at", unblockedAfter)
      .eq("lifecycle_events.nodes.workspace_id", params.workspaceId)
      .eq("lifecycle_events.nodes.user_id", params.userId),

    params.supabase
      .from("plan_blocks")
      .select(
        `
        node_id,
        completion_status,
        plan_sessions!inner(workspace_id, user_id, status, created_at)
      `,
      )
      .not("node_id", "is", null)
      .eq("completion_status", "pending")
      .eq("plan_sessions.status", "accepted")
      .eq("plan_sessions.workspace_id", params.workspaceId)
      .eq("plan_sessions.user_id", params.userId)
      .gte("plan_sessions.created_at", recentPlanAfter),

    params.supabase
      .from("plan_tasks")
      .select("id, title, node_id, scheduled_date, start_time, duration_minutes, created_at")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .eq("done", false),

    params.supabase
      .from("feedback_events")
      .select("event_type, metadata, created_at")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .eq("entity_type", "plan_session")
      .in("event_type", ["accept_node", "reject_node"])
      .gte("created_at", feedbackAfter),

    // Rhythm: status changes this past week → today-done filter, rotation /
    // momentum (yesterday) and neglect (3+ days). lifecycle_events has user_id
    // but no workspace_id; the workspace's edges and nodes scope it below.
    params.supabase
      .from("lifecycle_events")
      .select("node_id, new_status, created_at")
      .eq("user_id", params.userId)
      .gte("created_at", historyStart),

    // Rhythm: this week's habit completions → cadence-due + today-done.
    params.supabase
      .from("habit_completions")
      .select("node_id, completed_on")
      .eq("user_id", params.userId)
      .gte("completed_on", weekMonday),

    // Rhythm: chats scoped to a node this past week (a cluster you talked
    // about counts as "worked", not just completions).
    params.supabase
      .from("chat_sessions")
      .select("scope_node_id, last_message_at")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .gte("last_message_at", historyStart),

    // Steering: "focus on X" / "X can wait" (decaying boost/demote events).
    params.supabase
      .from("feedback_events")
      .select("event_type, entity_id, created_at")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .eq("entity_type", "node")
      .in("event_type", ["boost_node", "demote_node"])
      .gte("created_at", steerAfter),
  ]);

  const loadedNodes = (nodesResult.data ?? []) as NodeRow[];
  // Candidates come from active nodes; paused ones only feed holds/check-backs.
  const rawNodes = loadedNodes.filter((node) => (node.status ?? "active") === "active");
  const edgeRows = (edgesResult.data ?? []) as EdgeRow[];
  const planTasks = (planTasksResult.data ?? []) as PlanTaskRow[];
  const feedbackEvents = (planFeedbackEventsResult.data ?? []) as PlanFeedbackEventRow[];

  const nodeById = new Map(loadedNodes.map((node) => [node.id, node]));
  const activeIds = new Set(rawNodes.map((node) => node.id));

  // Ranking v2 signals: node deadlines (own or inherited), stakes, decaying
  // steering and holds — the same math as the importance score.
  const rankCtx = createRankingContext({
    nodes: loadedNodes as RankNode[],
    edges: edgeRows,
    today: todayDate,
    steerEvents: (steerEventsResult.data ?? []) as Array<{
      event_type: string;
      entity_id: string;
      created_at: string;
    }>,
  });

  // Parent of ANY node in this workspace (completed ones too — completing a
  // step is the main way a cluster gets "worked").
  const clusterParentOf = new Map<string, string>();
  for (const edge of edgeRows) {
    if (edge.edge_type === "belongs_to") {
      if (!clusterParentOf.has(edge.source_node_id)) {
        clusterParentOf.set(edge.source_node_id, edge.target_node_id);
      }
    } else if (edge.edge_type === "contains") {
      if (!clusterParentOf.has(edge.target_node_id)) {
        clusterParentOf.set(edge.target_node_id, edge.source_node_id);
      }
    }
  }
  const inWorkspace = (nodeId: string) => nodeById.has(nodeId) || clusterParentOf.has(nodeId);

  const recentlyUnblockedIds = new Set<string>();
  for (const row of (cascadeResult.data ?? []) as Array<{ affected_node_id: string }>) {
    if (row.affected_node_id && activeIds.has(row.affected_node_id)) {
      recentlyUnblockedIds.add(row.affected_node_id);
    }
  }

  // How many recent accepted plans left this node undone (one pending block each).
  const carriedOverCountByNode = new Map<string, number>();
  for (const row of (recentPlanBlocksResult.data ?? []) as Array<{ node_id: string }>) {
    if (row.node_id && activeIds.has(row.node_id)) {
      carriedOverCountByNode.set(row.node_id, (carriedOverCountByNode.get(row.node_id) ?? 0) + 1);
    }
  }

  // ─── Rhythm signals (all derived in-memory, no AI) ──────────────────────
  const lifecycleRows = (lifecycleSinceYesterdayResult.data ?? []) as Array<{
    node_id: string;
    new_status: string;
    created_at: string;
  }>;
  const habitRows = (habitCompletionsThisWeekResult.data ?? []) as Array<{
    node_id: string;
    completed_on: string;
  }>;
  const chatRows = (chatSessionsSinceYesterdayResult.data ?? []) as Array<{
    scope_node_id: string | null;
    last_message_at: string | null;
  }>;

  // Done today: a completed status-change today, or a habit logged today.
  const doneTodayIds = new Set<string>();
  for (const row of lifecycleRows) {
    if (
      row.new_status === "completed" &&
      row.created_at >= todayStart &&
      activeIds.has(row.node_id)
    ) {
      doneTodayIds.add(row.node_id);
    }
  }
  // This week's habit completions per node (habit_completions is one row per
  // (node, date), so the count is distinct days done this week).
  const habitCompletionsThisWeekByNode = new Map<string, number>();
  for (const row of habitRows) {
    if (!activeIds.has(row.node_id)) continue;
    if (row.completed_on === todayDate) doneTodayIds.add(row.node_id);
    habitCompletionsThisWeekByNode.set(
      row.node_id,
      (habitCompletionsThisWeekByNode.get(row.node_id) ?? 0) + 1,
    );
  }
  // Nodes touched *yesterday* (strictly) — a completion/status change or a chat
  // scoped to them. Used for rotation: rotate away from yesterday's cluster.
  // Completed steps count (that's how a cluster usually gets worked).
  const touchedYesterdayNodeIds = new Set<string>();
  // Latest touch per node this past week — for neglect.
  const lastTouchByNode = new Map<string, string>();
  const noteTouch = (nodeId: string, at: string) => {
    const prev = lastTouchByNode.get(nodeId);
    if (!prev || at > prev) lastTouchByNode.set(nodeId, at);
    if (at >= yesterdayStart && at < todayStart) touchedYesterdayNodeIds.add(nodeId);
  };
  for (const row of lifecycleRows) {
    if (inWorkspace(row.node_id)) noteTouch(row.node_id, row.created_at);
  }
  for (const row of chatRows) {
    if (row.scope_node_id && row.last_message_at && inWorkspace(row.scope_node_id)) {
      noteTouch(row.scope_node_id, row.last_message_at);
    }
  }

  const dueSoonNodeDates = new Map<string, string>();
  const manualItems = planTasks
    .filter((task) => !task.node_id)
    .sort(sortManualItems)
    .slice(0, MAX_MANUAL_ITEMS)
    .map((task) => ({
      id: task.id,
      title: task.title,
      scheduled_date: task.scheduled_date,
      start_time: task.start_time,
      duration_minutes: task.duration_minutes,
    }));

  for (const task of planTasks) {
    if (!task.node_id || !task.scheduled_date || task.scheduled_date > dueSoonCutoff) {
      continue;
    }

    const current = dueSoonNodeDates.get(task.node_id);
    if (!current || task.scheduled_date < current) {
      dueSoonNodeDates.set(task.node_id, task.scheduled_date);
    }
  }

  const incomingEdgesByNode = new Map<string, EdgeRow[]>();
  const outgoingEdgesByNode = new Map<string, EdgeRow[]>();

  for (const edge of edgeRows) {
    if (!activeIds.has(edge.source_node_id) || !activeIds.has(edge.target_node_id)) {
      continue;
    }

    if (!incomingEdgesByNode.has(edge.target_node_id)) {
      incomingEdgesByNode.set(edge.target_node_id, []);
    }
    if (!outgoingEdgesByNode.has(edge.source_node_id)) {
      outgoingEdgesByNode.set(edge.source_node_id, []);
    }

    incomingEdgesByNode.get(edge.target_node_id)?.push(edge);
    outgoingEdgesByNode.get(edge.source_node_id)?.push(edge);
  }

  const preferenceHints = buildPlannerPreferenceHints(feedbackEvents);

  // Identify cluster anchors — nodes that have children via belongs_to.
  // These are containers ("Life Admin", "This Semester's Courses") not
  // workable items, so they should never surface as top-3 focus candidates.
  const isClusterAnchor = new Set<string>();
  for (const [parentId, edges] of incomingEdgesByNode.entries()) {
    if (edges.some((e) => e.edge_type === "belongs_to")) {
      isClusterAnchor.add(parentId);
    }
  }

  // Hard-exclude structure and knowledge — a course or an area is the wrapper
  // around its work, and ideas/notes aren't committed work (node-types.ts).
  const NON_ACTIONABLE_TYPES: ReadonlySet<NodeType> = new Set([...STRUCTURE_TYPES, ...KNOWLEDGE_TYPES]);

  // Resolve a node's project cluster: its parent, else itself.
  const belongsToParentOf = (nodeId: string): string => clusterParentOf.get(nodeId) ?? nodeId;
  // Which clusters were worked yesterday, and when each was last touched.
  const clustersTouchedYesterday = new Set<string>();
  for (const nodeId of touchedYesterdayNodeIds) {
    clustersTouchedYesterday.add(belongsToParentOf(nodeId));
  }
  const lastTouchByCluster = new Map<string, string>();
  for (const [nodeId, at] of lastTouchByNode) {
    for (const key of [nodeId, belongsToParentOf(nodeId)]) {
      const prev = lastTouchByCluster.get(key);
      if (!prev || at > prev) lastTouchByCluster.set(key, at);
    }
  }

  // Surfaceable actionable nodes: not a container, not a class, not done
  // today, and not parked under a paused parent (waiting for a result).
  const actionableNodes = rawNodes.filter((node) => {
    if (NON_ACTIONABLE_TYPES.has(node.node_type)) return false;
    if (isClusterAnchor.has(node.id)) return false;
    if (doneTodayIds.has(node.id)) return false; // today-awareness: hide what's done
    if (rankCtx.hold(node.id) !== "none") return false;
    return true;
  });

  // Next step per deadline: steps sharing a dated parent are ordered by the
  // user's reading order, then age; only the first gets full deadline weight.
  const siblingIndex = new Map<string, number>();
  const stepsByDeadlineOwner = new Map<string, NodeRow[]>();
  for (const node of actionableNodes) {
    const dl = rankCtx.deadline(node.id);
    if (!dl || !dl.inherited) continue;
    const list = stepsByDeadlineOwner.get(dl.ownerId) ?? [];
    list.push(node);
    stepsByDeadlineOwner.set(dl.ownerId, list);
  }
  for (const steps of stepsByDeadlineOwner.values()) {
    steps
      .sort(
        (a, b) =>
          (a.reading_order ?? Number.MAX_SAFE_INTEGER) - (b.reading_order ?? Number.MAX_SAFE_INTEGER) ||
          a.created_at.localeCompare(b.created_at),
      )
      .forEach((node, index) => siblingIndex.set(node.id, index));
  }
  // Only rotate-demote when there's somewhere else to send the user — never
  // demote a single-project user's only cluster into emptiness.
  const untouchedClusterAvailable = actionableNodes.some(
    (node) => !clustersTouchedYesterday.has(belongsToParentOf(node.id)),
  );

  const candidates = actionableNodes
    .map((node) => {
      const incoming = incomingEdgesByNode.get(node.id) ?? [];
      const outgoing = outgoingEdgesByNode.get(node.id) ?? [];

      const prerequisiteTitles = incoming
        .filter(
          (edge) =>
            PREREQUISITE_EDGE_TYPES.has(edge.edge_type) && activeIds.has(edge.source_node_id),
        )
        .map((edge) => nodeById.get(edge.source_node_id)?.title ?? "")
        .filter(Boolean);

      const blockerTitles = incoming
        .filter(
          (edge) => BLOCKER_EDGE_TYPES.has(edge.edge_type) && activeIds.has(edge.source_node_id),
        )
        .map((edge) => nodeById.get(edge.source_node_id)?.title ?? "")
        .filter(Boolean);

      const unlocksTitles = outgoing
        .filter(
          (edge) =>
            PREREQUISITE_EDGE_TYPES.has(edge.edge_type) && activeIds.has(edge.target_node_id),
        )
        .map((edge) => nodeById.get(edge.target_node_id)?.title ?? "")
        .filter(Boolean);

      const planningSignals: string[] = [];
      const dueSoonDate = dueSoonNodeDates.get(node.id);
      const dueSoon = Boolean(dueSoonDate);
      const carriedOverCount = carriedOverCountByNode.get(node.id) ?? 0;
      const carriedOver = carriedOverCount > 0;
      const recentlyUnblocked = recentlyUnblockedIds.has(node.id);
      const completionsThisWeek = habitCompletionsThisWeekByNode.get(node.id) ?? 0;
      const cadenceIsDue = cadenceDue({
        targetPerWeek: node.habit_target_per_week,
        completionsThisWeek,
        doneToday: doneTodayIds.has(node.id),
        dayOfWeek: isoDayOfWeek,
      });

      const deadline = rankCtx.deadline(node.id);
      const pressure = deadline?.pressure ?? 0;
      const isNextStep = (siblingIndex.get(node.id) ?? 0) === 0;
      const siblingFactor = isNextStep ? 1 : PLANNER_BONUSES.DEADLINE_SIBLING_FACTOR;
      const cluster = belongsToParentOf(node.id);
      const rhythm = rhythmFor({
        clusterTouchedYesterday: clustersTouchedYesterday.has(cluster),
        untouchedClusterAvailable,
        deadlinePressure: pressure,
      });
      // Neglect only counts for dated work that has existed a few days, and
      // (like momentum) it's a fact about the cluster — only its next step gets it.
      let neglectDays = 0;
      if (pressure > 0 && isNextStep) {
        const lastTouch = lastTouchByCluster.get(cluster) ?? lastTouchByCluster.get(node.id);
        const sinceTouch = lastTouch ? daysBetween(lastTouch, todayDate) : HISTORY_WINDOW_DAYS;
        neglectDays = Math.min(sinceTouch, daysBetween(node.created_at, todayDate));
      }
      const steer = rankCtx.steer(node.id);
      const stakes = rankCtx.stakes(node.id);

      // Order = what the Focus hero line should say first.
      if (deadline && pressure >= 20) {
        if (deadline.daysLeft < 0) {
          planningSignals.push(`${capitalize(relativeDue(deadline.daysLeft))} — done, moved or dropped?`);
        } else {
          const owner = deadline.inherited ? nodeById.get(deadline.ownerId)?.title : null;
          planningSignals.push(
            `${owner ? `"${owner}" ${relativeDue(deadline.daysLeft)}` : capitalize(relativeDue(deadline.daysLeft))}` +
              ` · ~${deadline.sessionsLeft} session${deadline.sessionsLeft === 1 ? "" : "s"} left`,
          );
        }
      }

      if (recentlyUnblocked) {
        planningSignals.push("Ready to start");
      }

      if (steer >= 0.3) {
        planningSignals.push("You asked to focus on this");
      }

      if (dueSoon && dueSoonDate) {
        planningSignals.push(`On your calendar (${dueSoonDate})`);
      }

      if (stakes === "high") {
        planningSignals.push("High stakes");
      }

      if (cadenceIsDue) {
        const target = node.habit_target_per_week;
        planningSignals.push(
          target != null && target >= 7
            ? "Daily — not done yet today"
            : `Due this week (${completionsThisWeek}/${target ?? 0} done)`,
        );
      }

      if (carriedOverCount >= CARRIED_OVER_BREAKDOWN_AT) {
        planningSignals.push(`Carried over ${carriedOverCount}× — break it into a smaller first step?`);
      } else if (carriedOver) {
        planningSignals.push("Carried over from a recent accepted plan");
      }

      if (rhythm.momentum && isNextStep) {
        planningSignals.push("Keep going — you worked on this yesterday");
      }

      if (neglectBonus(neglectDays) > 0) {
        planningSignals.push(`Untouched for ${neglectDays} days`);
      }

      if (unlocksTitles.length > 0) {
        planningSignals.push(`Required for ${summarizeTitles(unlocksTitles)}`);
      }

      const dependsOnTitles = [...prerequisiteTitles, ...blockerTitles];
      if (dependsOnTitles.length > 0) {
        planningSignals.push(`Depends on ${summarizeTitles(dependsOnTitles)}`);
      }

      const priority = computePlannerPriority({
        dueSoon,
        cadenceDue: cadenceIsDue,
        carriedOver,
        currentImportanceScore: node.current_importance_score,
        recentlyUnblocked,
        nodeType: node.node_type,
        blockerCount: blockerTitles.length,
        prerequisiteCount: prerequisiteTitles.length,
        unlocksCount: unlocksTitles.length,
        rotationDemoted: rhythm.rotationDemoted,
        momentum: rhythm.momentum && isNextStep,
        deadlinePressure: pressure,
        siblingFactor,
        steer,
        neglectDays,
      });

      return {
        candidate: {
          id: node.id,
          title: node.title,
          summary: node.summary,
          body: node.body,
          node_type: node.node_type,
          current_importance_score: node.current_importance_score,
          recently_unblocked: recentlyUnblocked,
          planning_signals: planningSignals,
        } satisfies PlannerCandidate,
        priority,
        deadlineOwner: deadline?.ownerId ?? null,
      };
    })
    // A waiting node whose check-back date arrived: one quick decision
    // (resume, done, or drop) — surfaced near the top.
    .concat(
      loadedNodes
        .filter((node) => node.status === "paused" && rankCtx.hold(node.id) === "check_back")
        .map((node) => ({
          candidate: {
            id: node.id,
            title: node.title,
            summary: node.summary,
            body: node.body,
            node_type: node.node_type,
            current_importance_score: node.current_importance_score,
            recently_unblocked: false,
            check_back: true,
            planning_signals: [
              node.waiting_for
                ? `Check back: waiting for ${node.waiting_for}`
                : "Paused — time to check back",
            ],
          } satisfies PlannerCandidate,
          priority: PLANNER_BONUSES.CHECK_BACK + importanceContribution(node.current_importance_score),
          deadlineOwner: null,
        })),
    )
    .sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }

      return (b.candidate.current_importance_score ?? 0) - (a.candidate.current_importance_score ?? 0);
    });

  return {
    candidates: diversifyHead(candidates, FOCUS_HEAD_SIZE)
      .slice(0, MAX_CANDIDATES)
      .map((entry) => entry.candidate),
    manual_items: manualItems,
    preference_hints: preferenceHints,
  };
}

// Focus shows its top few as "the next move + alternatives". Alternatives that
// are just the next steps of the same deadline aren't choices, so the head
// takes at most one step per deadline; everything else keeps its order after.
export function diversifyHead<T extends { deadlineOwner: string | null }>(
  sorted: T[],
  headSize: number,
): T[] {
  const head: T[] = [];
  const rest: T[] = [];
  const owners = new Set<string>();
  for (const entry of sorted) {
    if (head.length < headSize && (!entry.deadlineOwner || !owners.has(entry.deadlineOwner))) {
      head.push(entry);
      if (entry.deadlineOwner) owners.add(entry.deadlineOwner);
    } else {
      rest.push(entry);
    }
  }
  return [...head, ...rest];
}


