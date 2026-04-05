// Planner candidate set builder — Phase 10.1
// Selects, scores, and deduplicates work items for an AI planning session.
//
// Candidate selection rules:
//   1. Active nodes (status = active, in_progress, or todo — not completed/archived)
//   2. Recently unblocked nodes (cascade_results, action_taken = 'unblocked', last 24h) are
//      promoted to the top so the planner surfaces them prominently.
//   3. Sorted by current_importance_score desc within each tier.
//   4. Capped at MAX_CANDIDATES to keep the prompt manageable.

import type { NodeType } from "@/types/graph";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

const MAX_CANDIDATES = 20;
const RECENTLY_UNBLOCKED_WINDOW_HOURS = 24;
const RECENT_PLAN_WINDOW_DAYS = 7;

export interface PlannerCandidate {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  /** True when this node was unblocked by a cascade within the last 24 h. */
  recently_unblocked: boolean;
}

export async function buildPlannerCandidates(params: {
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
}): Promise<PlannerCandidate[]> {
  const unblockedAfter = new Date(
    Date.now() - RECENTLY_UNBLOCKED_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const recentPlanAfter = new Date(
    Date.now() - RECENT_PLAN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Run all queries in parallel.
  const [nodesResult, cascadeResult, recentPlanBlocksResult] = await Promise.all([
    params.supabase
      .from("nodes")
      .select("id, title, summary, node_type, status, current_importance_score")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .not("status", "in", '("completed","archived")')
      .order("current_importance_score", { ascending: false })
      .limit(MAX_CANDIDATES * 3), // fetch extra before dedup + filtering

    // cascade_results references lifecycle_events which references nodes.
    // We join via lifecycle_events to confirm the affected node belongs to this workspace.
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

    // Phase 10.1 — nodes from recent accepted plans that are still pending completion.
    // These were planned but not finished, so they should be surfaced again.
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
  ]);

  type NodeRow = {
    id: string;
    title: string;
    summary: string | null;
    node_type: string;
    status: string;
    current_importance_score: number | null;
  };

  const rawNodes: NodeRow[] = nodesResult.data ?? [];

  // Collect recently unblocked node IDs (cascade query may fail gracefully)
  const recentlyUnblockedIds = new Set<string>();
  if (cascadeResult.data && Array.isArray(cascadeResult.data)) {
    for (const row of cascadeResult.data as { affected_node_id: string }[]) {
      if (row.affected_node_id) {
        recentlyUnblockedIds.add(row.affected_node_id);
      }
    }
  }

  // Collect node IDs from recent accepted plans that are still pending (Phase 10.1)
  const recentPlanNodeIds = new Set<string>();
  if (recentPlanBlocksResult.data && Array.isArray(recentPlanBlocksResult.data)) {
    for (const row of recentPlanBlocksResult.data as { node_id: string }[]) {
      if (row.node_id) {
        recentPlanNodeIds.add(row.node_id);
      }
    }
  }

  // Tag and partition into three tiers:
  //   1. Recently unblocked (highest priority)
  //   2. Carried over from recent plans but not yet done
  //   3. Everything else by score
  const tagged: PlannerCandidate[] = rawNodes.map((n) => ({
    id: n.id,
    title: n.title,
    summary: n.summary,
    node_type: n.node_type as NodeType,
    current_importance_score: n.current_importance_score,
    recently_unblocked: recentlyUnblockedIds.has(n.id),
  }));

  const byScore = (a: PlannerCandidate, b: PlannerCandidate) =>
    (b.current_importance_score ?? 50) - (a.current_importance_score ?? 50);

  const unblocked = tagged.filter((c) => c.recently_unblocked).sort(byScore);
  const carriedOver = tagged
    .filter((c) => !c.recently_unblocked && recentPlanNodeIds.has(c.id))
    .sort(byScore);
  const rest = tagged
    .filter((c) => !c.recently_unblocked && !recentPlanNodeIds.has(c.id))
    .sort(byScore);

  return [...unblocked, ...carriedOver, ...rest].slice(0, MAX_CANDIDATES);
}
