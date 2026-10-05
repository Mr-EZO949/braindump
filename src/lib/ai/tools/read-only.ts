// Read-only tools for the assistant agent loop (M1.1).
// These execute automatically without user confirmation — they only query data.
//
// Each tool has:
//   - schema: Anthropic tool definition (sent to Claude in messages.create)
//   - handler: server-side executor that receives Claude's validated input + context
//
// Handlers return a JSON-serialisable value that gets fed back to Claude as
// a tool_result content block in the next turn of the agent loop.

import { AI_CANDIDATES, AI_RATE_LIMITS } from "../config";
import { matchNodes } from "../embeddings";
import { scoreNodesJudgment } from "../judgment";
import { checkAIRunRateLimitWindow } from "../rate-limit";
import { computeWorkspaceScores } from "../scoring";
import type { WorkspaceProfile } from "@/types/graph";
import { addDaysISO, localDateISO } from "@/lib/time/local-date";
import { normalizeEdges } from "@/lib/graph/edge-types";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export interface ToolContext {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  selectedNodeId: string | null;
  // The user's local calendar date (YYYY-MM-DD, from the bd_tz cookie). Tools
  // must use this for "today" — never new Date().toISOString(), which is UTC.
  today?: string;
  // Runs work after the response has gone out (Next's `after`) — see
  // ChangeContext in lib/graph/change-set.ts.
  defer?: (work: () => Promise<void>) => void;
  // The user's message this turn, word for word — build_graph hands it to the
  // graph builder so the chat model doesn't have to restate a dump.
  userMessage?: string;
  // Aborted when the user hits Stop: cancels a builder call in flight.
  signal?: AbortSignal;
  // The user's "Add confident items without asking" switch (default on; read
  // from auth metadata by the route): off → every change from chat waits on
  // the card.
  autoApply?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (
  input: unknown,
  ctx: ToolContext,
) => Promise<unknown>;

export interface ToolDefinition {
  schema: ToolSchema;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// search_nodes
// Semantic search across the user's nodes in the current workspace.
// ---------------------------------------------------------------------------

const SEARCH_NODES: ToolDefinition = {
  schema: {
    name: "search_nodes",
    description:
      "Find nodes by meaning (title, summary, content) when the one they mention isn't in the snapshot. Ranked by relevance.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", description: "Default 10", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  handler: async (input, ctx) => {
    const { query, limit } = (input ?? {}) as { query?: string; limit?: number };
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return { error: "query is required" };
    }

    const capped = Math.min(Math.max(limit ?? 10, 1), 20);

    const matches = await matchNodes({
      queryText: query,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      supabase: ctx.supabase,
      limit: Math.min(capped, AI_CANDIDATES.RETRIEVAL_K),
    });

    return {
      results: matches.slice(0, capped).map((node) => ({
        id: node.node_id,
        title: node.title,
        summary: node.summary ?? null,
        node_type: node.node_type,
        similarity: Number(node.similarity.toFixed(3)),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// get_node
// Full detail on a single node: summary, status, importance, neighbors.
// ---------------------------------------------------------------------------

const GET_NODE: ToolDefinition = {
  schema: {
    name: "get_node",
    description:
      "One node in full: description, children, connections (titles + edge types), history.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  handler: async (input, ctx) => {
    const { id } = (input ?? {}) as { id?: string };
    if (!id || typeof id !== "string") {
      return { error: "id is required" };
    }

    const { data: node, error: nodeErr } = await ctx.supabase
      .from("nodes")
      .select(
        "id, title, summary, raw_text, node_type, importance, importance_index, current_importance_score, status, created_at, updated_at",
      )
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .single();

    if (nodeErr || !node) {
      return { error: "Node not found in this workspace" };
    }

    // NOTE: the columns are source_node_id / target_node_id. This used to query
    // source_id / target_id, which don't exist — the error was swallowed, so
    // get_node returned ZERO neighbors for every node and the assistant edited
    // structure blind (a root cause of "chat replaced the parent", #19).
    const { data: edges } = await ctx.supabase
      .from("edges")
      .select("id, source_node_id, target_node_id, edge_type, status")
      .or(`source_node_id.eq.${id},target_node_id.eq.${id}`)
      .eq("user_id", ctx.userId)
      .eq("status", "active");

    const neighborIds = new Set<string>();
    for (const e of edges ?? []) {
      if (e.source_node_id !== id) neighborIds.add(e.source_node_id);
      if (e.target_node_id !== id) neighborIds.add(e.target_node_id);
    }

    const neighbors: Array<{
      id: string;
      title: string;
      node_type: string;
      edge_type: string;
      direction: "in" | "out";
    }> = [];

    if (neighborIds.size > 0) {
      const { data: neighborRows } = await ctx.supabase
        .from("nodes")
        .select("id, title, node_type")
        .in("id", Array.from(neighborIds))
        .eq("user_id", ctx.userId);

      const byId = new Map(
        (neighborRows ?? []).map(
          (n: { id: string; title: string; node_type: string }) => [n.id, n],
        ),
      );

      // Legacy link types read as the four kinds (lib/graph/edge-types.ts).
      for (const e of normalizeEdges(edges ?? [])) {
        const isOut = e.source_node_id === id;
        const otherId = isOut ? e.target_node_id : e.source_node_id;
        const other = byId.get(otherId) as
          | { id: string; title: string; node_type: string }
          | undefined;
        if (!other) continue;
        neighbors.push({
          id: other.id,
          title: other.title,
          node_type: other.node_type,
          edge_type: e.edge_type,
          direction: isOut ? "out" : "in",
        });
      }
    }

    // Spell the hierarchy out explicitly. A belongs_to edge points child →
    // parent, so a raw in/out list is easy to misread; the assistant needs to
    // know "what is this under / what's under it" to ADD children rather than
    // replace a node.
    const parent =
      neighbors.find((n) => n.edge_type === "belongs_to" && n.direction === "out") ?? null;
    const children = neighbors
      .filter((n) => n.edge_type === "belongs_to" && n.direction === "in")
      .map(({ id: childId, title, node_type }) => ({ id: childId, title, node_type }));

    return {
      id: node.id,
      title: node.title,
      summary: node.summary ?? null,
      raw_text: node.raw_text ?? null,
      node_type: node.node_type,
      importance: node.importance,
      status: node.status,
      created_at: node.created_at,
      parent: parent ? { id: parent.id, title: parent.title, node_type: parent.node_type } : null,
      children,
      neighbors,
    };
  },
};

// ---------------------------------------------------------------------------
// get_recent_activity
// Nodes whose status changed recently — "what did I do this week?"
// ---------------------------------------------------------------------------

const GET_RECENT_ACTIVITY: ToolDefinition = {
  schema: {
    name: "get_recent_activity",
    description:
      "Nodes completed, archived or otherwise changed in status in the last `hours` — for \"what have I done recently\" or a reflection.",
    input_schema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "Default 48", minimum: 1, maximum: 720 },
      },
    },
  },
  handler: async (input, ctx) => {
    const { hours } = (input ?? {}) as { hours?: number };
    const windowHours = Math.min(Math.max(hours ?? 48, 1), 720);
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

    const { data: events } = await ctx.supabase
      .from("lifecycle_events")
      .select("node_id, previous_status, new_status, created_at")
      .eq("user_id", ctx.userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);

    const eventRows = (events ?? []) as Array<{
      node_id: string;
      previous_status: string;
      new_status: string;
      created_at: string;
    }>;

    const nodeIds = Array.from(new Set(eventRows.map((e) => e.node_id)));

    if (nodeIds.length === 0) {
      return { events: [], window_hours: windowHours };
    }

    const { data: nodeRows } = await ctx.supabase
      .from("nodes")
      .select("id, title, node_type")
      .in("id", nodeIds)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId);

    const nodeMap = new Map(
      ((nodeRows ?? []) as Array<{
        id: string;
        title: string;
        node_type: string;
      }>).map((n) => [n.id, n]),
    );

    return {
      window_hours: windowHours,
      events: eventRows
        .map((e) => {
          const node = nodeMap.get(e.node_id);
          if (!node) return null;
          return {
            node_id: e.node_id,
            title: node.title,
            node_type: node.node_type,
            previous_status: e.previous_status,
            new_status: e.new_status,
            at: e.created_at,
          };
        })
        .filter((x) => x !== null),
    };
  },
};

// ---------------------------------------------------------------------------
// get_workspace_summary
// High-level snapshot: counts by type/status, active goals/projects.
// ---------------------------------------------------------------------------

const GET_WORKSPACE_SUMMARY: ToolDefinition = {
  schema: {
    name: "get_workspace_summary",
    description:
      "Counts by type and status plus every active goal and project — for a broad \"what's in my graph\" beyond the snapshot.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  handler: async (_input, ctx) => {
    const { data: nodes } = await ctx.supabase
      .from("nodes")
      .select("id, title, node_type, status")
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId);

    const rows = ((nodes ?? []) as Array<{
      id: string;
      title: string;
      node_type: string;
      status: string;
    }>);

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const activeGoals: string[] = [];
    const activeProjects: string[] = [];

    for (const n of rows) {
      byType[n.node_type] = (byType[n.node_type] ?? 0) + 1;
      byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
      if (n.status === "active") {
        if (n.node_type === "goal" && activeGoals.length < 10) {
          activeGoals.push(n.title);
        }
        if (n.node_type === "project" && activeProjects.length < 10) {
          activeProjects.push(n.title);
        }
      }
    }

    return {
      total_nodes: rows.length,
      by_type: byType,
      by_status: byStatus,
      active_goals: activeGoals,
      active_projects: activeProjects,
    };
  },
};

// ---------------------------------------------------------------------------
// get_calendar
// Plan tasks in a date range — "what's on my calendar tomorrow?"
// ---------------------------------------------------------------------------

const GET_CALENDAR: ToolDefinition = {
  schema: {
    name: "get_calendar",
    description:
      "Calendar tasks between start_date and end_date (inclusive) — for schedule questions. Default: today to +7 days.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
      },
    },
  },
  handler: async (input, ctx) => {
    const { start_date, end_date } = (input ?? {}) as {
      start_date?: string;
      end_date?: string;
    };

    // Default range starts on the USER's today (ctx.today, from bd_tz) — the
    // UTC date showed the wrong day's calendar late evening / after midnight.
    const defaultStart = ctx.today ?? localDateISO(new Date(), null);
    const plus7 = addDaysISO(defaultStart, 7);

    const startIso = isValidDate(start_date) ? start_date! : defaultStart;
    const endIso = isValidDate(end_date) ? end_date! : plus7;

    const { data: tasks } = await ctx.supabase
      .from("plan_tasks")
      .select(
        "id, title, done, scheduled_date, start_time, duration_minutes, node_id",
      )
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .gte("scheduled_date", startIso)
      .lte("scheduled_date", endIso)
      .order("scheduled_date", { ascending: true })
      .order("start_time", { ascending: true, nullsFirst: false });

    return {
      start_date: startIso,
      end_date: endIso,
      tasks: (tasks ?? []) as Array<unknown>,
    };
  },
};

function isValidDate(s: string | undefined): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---------------------------------------------------------------------------
// rerank_importance
// Re-rank every node in the workspace using an LLM judgment pass, then
// recompute downstream scores. User-invoked via chat — no approval card;
// the user asking for it is the approval. Gated by a per-user daily cap.
// ---------------------------------------------------------------------------

const RERANK_IMPORTANCE: ToolDefinition = {
  schema: {
    name: "rerank_importance",
    description:
      "Re-judge every node's significance (an LLM pass) and recompute all scores — ONLY when they explicitly ask to re-rank everything ('my whole situation changed, redo the importance'). Specific nodes → update_priorities. Not for 'what should I work on'. A few runs a day.",
    input_schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "Optional: what they prioritize now, one sentence ('finals week, ML dominates')",
        },
      },
    },
  },
  handler: async (input, ctx) => {
    const { focus } = (input ?? {}) as { focus?: string };

    const limit = await checkAIRunRateLimitWindow({
      supabase: ctx.supabase,
      userId: ctx.userId,
      runType: "rerank_importance",
      max: AI_RATE_LIMITS.RERANK_IMPORTANCE_PER_DAY,
      windowMs: 24 * 60 * 60 * 1000,
    });

    if (!limit.allowed) {
      return {
        error: "Daily rerank limit reached. Try again after " + limit.resetAt,
        reset_at: limit.resetAt,
      };
    }

    const { data: nodes } = await ctx.supabase
      .from("nodes")
      .select("id, title, summary, node_type, status")
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .neq("status", "archived");

    const nodeRows = ((nodes ?? []) as Array<{
      id: string;
      title: string;
      summary: string | null;
      node_type: string;
      status: string | null;
    }>).filter((n) => n.status !== "completed");

    if (nodeRows.length === 0) {
      return { ok: true, scored: 0, message: "No active nodes to rerank." };
    }

    const { data: parentEdges } = await ctx.supabase
      .from("edges")
      .select("source_node_id, target_node_id, edge_type")
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .in("edge_type", ["belongs_to", "contains"]);

    const titleById = new Map(nodeRows.map((n) => [n.id, n.title]));
    const parentTitleByNode = new Map<string, string>();
    const childCountByNode = new Map<string, number>();
    for (const e of (parentEdges ?? []) as Array<{
      source_node_id: string;
      target_node_id: string;
      edge_type: string;
    }>) {
      const childId = e.edge_type === "belongs_to" ? e.source_node_id : e.target_node_id;
      const parentId = e.edge_type === "belongs_to" ? e.target_node_id : e.source_node_id;
      if (!parentTitleByNode.has(childId)) {
        const parentTitle = titleById.get(parentId);
        if (parentTitle) parentTitleByNode.set(childId, parentTitle);
      }
      childCountByNode.set(parentId, (childCountByNode.get(parentId) ?? 0) + 1);
    }

    const { data: workspaceRow } = await ctx.supabase
      .from("workspaces")
      .select("profile_payload")
      .eq("id", ctx.workspaceId)
      .eq("user_id", ctx.userId)
      .maybeSingle();

    const workspaceProfile =
      workspaceRow && typeof workspaceRow === "object"
        ? ((workspaceRow as { profile_payload?: WorkspaceProfile | null }).profile_payload ?? null)
        : null;

    const judgmentInput = nodeRows.map((n) => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      node_type: n.node_type,
      parent_title: parentTitleByNode.get(n.id) ?? null,
      child_count: childCountByNode.get(n.id) ?? 0,
    }));

    const results = await scoreNodesJudgment({
      nodes: judgmentInput,
      workspaceProfile,
      focusHint: focus?.trim() ? focus.trim() : null,
      runType: "rerank_importance",
      supabase: ctx.supabase,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });

    if (results.length === 0) {
      // The judgment pass failed (logged in ai_runs) — say so instead of
      // reporting a successful rerank of nothing.
      return {
        ok: false,
        error: "The re-rank didn't go through — scores are unchanged. Try again in a minute.",
      };
    }

    await computeWorkspaceScores({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      supabase: ctx.supabase,
      today: ctx.today,
    }).catch(() => {});

    const top = [...results]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => ({
        id: r.node_id,
        title: titleById.get(r.node_id) ?? r.node_id,
        score: r.score,
        reason: r.reason,
      }));

    return {
      ok: true,
      scored: results.length,
      remaining_today: Math.max(0, limit.remaining - 1),
      top,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  SEARCH_NODES,
  GET_NODE,
  GET_RECENT_ACTIVITY,
  GET_WORKSPACE_SUMMARY,
  GET_CALENDAR,
  RERANK_IMPORTANCE,
];
