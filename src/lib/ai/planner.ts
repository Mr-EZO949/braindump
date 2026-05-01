// Planner candidate set builder — Phase 10.1
// Selects candidate graph work, standalone manual planner items, and preference
// hints learned from recent plan edits/rejections.

import type { NodeType } from "@/types/graph";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

const MAX_CANDIDATES = 20;
const MAX_MANUAL_ITEMS = 6;
const RECENTLY_UNBLOCKED_WINDOW_HOURS = 24;
const RECENT_PLAN_WINDOW_DAYS = 7;
const DUE_SOON_WINDOW_DAYS = 7;
const PLANNER_FEEDBACK_WINDOW_DAYS = 30;
const TITLE_PREVIEW_LIMIT = 2;

const PRIMARY_NODE_TYPE_PRIORITY: Record<NodeType, number> = {
  task: 120,
  goal: 104,
  project: 70,
  class: 62,
  concept: 46,
  idea: 36,
  habit: 98,
};

const PREREQUISITE_EDGE_TYPES = new Set(["prerequisite_for", "required_for"]);
const BLOCKER_EDGE_TYPES = new Set(["blocks", "depends_on"]);

export interface PlannerCandidate {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  recently_unblocked: boolean;
  planning_signals: string[];
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
  title: string;
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

function computePlannerPriority(params: {
  dueSoon: boolean;
  carriedOver: boolean;
  currentImportanceScore: number | null;
  recentlyUnblocked: boolean;
  nodeType: NodeType;
  blockerCount: number;
  prerequisiteCount: number;
  unlocksCount: number;
}) {
  let priority = PRIMARY_NODE_TYPE_PRIORITY[params.nodeType] ?? 40;

  if (params.recentlyUnblocked) {
    priority += 300;
  }

  if (params.dueSoon) {
    priority += 240;
  }

  if (params.carriedOver) {
    priority += 170;
  }

  if (params.unlocksCount > 0) {
    priority += 120 + Math.min(72, params.unlocksCount * 18);
  }

  if (params.prerequisiteCount > 0) {
    priority -= 70 + Math.min(36, params.prerequisiteCount * 12);
  }

  if (params.blockerCount > 0) {
    priority -= 42 + Math.min(24, params.blockerCount * 8);
  }

  return priority + Math.round((params.currentImportanceScore ?? 0) * 1.8);
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

  const [
    nodesResult,
    edgesResult,
    cascadeResult,
    recentPlanBlocksResult,
    planTasksResult,
    planFeedbackEventsResult,
  ] = await Promise.all([
    params.supabase
      .from("nodes")
      .select("id, title, summary, node_type, status, current_importance_score")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .or("status.eq.active,status.is.null")
      .limit(MAX_CANDIDATES * 5),

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
  ]);

  const rawNodes = (nodesResult.data ?? []) as NodeRow[];
  const edgeRows = (edgesResult.data ?? []) as EdgeRow[];
  const planTasks = (planTasksResult.data ?? []) as PlanTaskRow[];
  const feedbackEvents = (planFeedbackEventsResult.data ?? []) as PlanFeedbackEventRow[];

  const nodeById = new Map(rawNodes.map((node) => [node.id, node]));
  const activeIds = new Set(rawNodes.map((node) => node.id));

  const recentlyUnblockedIds = new Set<string>();
  for (const row of (cascadeResult.data ?? []) as Array<{ affected_node_id: string }>) {
    if (row.affected_node_id && activeIds.has(row.affected_node_id)) {
      recentlyUnblockedIds.add(row.affected_node_id);
    }
  }

  const carriedOverNodeIds = new Set<string>();
  for (const row of (recentPlanBlocksResult.data ?? []) as Array<{ node_id: string }>) {
    if (row.node_id && activeIds.has(row.node_id)) {
      carriedOverNodeIds.add(row.node_id);
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

  // Hard-exclude class anchors — they're always containers (a course is the
  // wrapper around its tasks/exams; the course itself isn't actionable).
  const NON_ACTIONABLE_TYPES = new Set<NodeType>(["class"]);

  const candidates = rawNodes
    .filter((node) => {
      if (NON_ACTIONABLE_TYPES.has(node.node_type)) return false;
      if (isClusterAnchor.has(node.id)) return false;
      return true;
    })
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
      const carriedOver = carriedOverNodeIds.has(node.id);
      const recentlyUnblocked = recentlyUnblockedIds.has(node.id);

      if (recentlyUnblocked) {
        planningSignals.push("Recently unblocked");
      }

      if (dueSoon && dueSoonDate) {
        planningSignals.push(`Due soon (${dueSoonDate})`);
      }

      if (carriedOver) {
        planningSignals.push("Carried over from a recent accepted plan");
      }

      if (unlocksTitles.length > 0) {
        planningSignals.push(`Unblocks ${summarizeTitles(unlocksTitles)}`);
      }

      if (prerequisiteTitles.length > 0) {
        planningSignals.push(`Blocked by ${summarizeTitles(prerequisiteTitles)}`);
      }

      if (blockerTitles.length > 0) {
        planningSignals.push(`Depends on ${summarizeTitles(blockerTitles)}`);
      }

      const priority = computePlannerPriority({
        dueSoon,
        carriedOver,
        currentImportanceScore: node.current_importance_score,
        recentlyUnblocked,
        nodeType: node.node_type,
        blockerCount: blockerTitles.length,
        prerequisiteCount: prerequisiteTitles.length,
        unlocksCount: unlocksTitles.length,
      });

      return {
        candidate: {
          id: node.id,
          title: node.title,
          summary: node.summary,
          node_type: node.node_type,
          current_importance_score: node.current_importance_score,
          recently_unblocked: recentlyUnblocked,
          planning_signals: planningSignals,
        } satisfies PlannerCandidate,
        priority,
      };
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }

      return (b.candidate.current_importance_score ?? 0) - (a.candidate.current_importance_score ?? 0);
    })
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.candidate);

  return {
    candidates,
    manual_items: manualItems,
    preference_hints: preferenceHints,
  };
}
