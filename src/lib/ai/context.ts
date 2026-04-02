// Context builder for the assistant chat — Phase 8.2 + 8.3.
// Assembles a token-budgeted, priority-ranked context string from the graph.
// Never exceeds AI_TOKEN_BUDGETS.ASSISTANT_CHAT by design.

import { AI_TOKEN_BUDGETS, AI_ASSISTANT } from "./config";

// ---------------------------------------------------------------------------
// Token estimator — chars/4 approximation (standard estimate for English prose)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextItem {
  kind: "node" | "event" | "workspace_summary";
  id: string;
  text: string;
  /** Higher = kept first when truncating. */
  priority: number;
  tokens: number;
}

export interface AssembledContext {
  contextString: string;
  itemsIncluded: number;
  itemsTruncated: number;
  estimatedTokens: number;
  scopeLabel: string;
}

// Supabase client type — inferred from usage to avoid coupling to server module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export async function buildAssistantContext(params: {
  workspaceId: string;
  userId: string;
  selectedNodeId: string | null;
  supabase: SupabaseClient;
  message: string;
  budget?: number;
}): Promise<AssembledContext> {
  const budget = params.budget ?? AI_TOKEN_BUDGETS.ASSISTANT_CHAT;
  const items: ContextItem[] = [];

  // 48-hour window for recently completed nodes (from config)
  const completedAfter = new Date(
    Date.now() - AI_ASSISTANT.COMPLETED_NODE_CONTEXT_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Load all workspace data in parallel
  const [nodesResult, edgesResult, feedbackResult, recentlyCompletedResult] = await Promise.all([
    params.supabase
      .from("nodes")
      .select("id, title, summary, node_type, importance, current_importance_score, status")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .neq("status", "archived"),

    params.supabase
      .from("edges")
      .select("id, source_node_id, target_node_id, edge_type, status")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .eq("status", "active"),

    params.supabase
      .from("feedback_events")
      .select("event_type, entity_id, created_at")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .order("created_at", { ascending: false })
      .limit(20),

    params.supabase
      .from("nodes")
      .select("id, title, completed_at")
      .eq("workspace_id", params.workspaceId)
      .eq("user_id", params.userId)
      .eq("status", "completed")
      .gte("completed_at", completedAfter)
      .order("completed_at", { ascending: false })
      .limit(10),
  ]);

  type NodeRow = {
    id: string;
    title: string;
    summary: string | null;
    node_type: string;
    importance: string;
    current_importance_score: number | null;
    status: string;
  };
  type EdgeRow = {
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    status: string;
  };
  type FeedbackRow = { event_type: string; entity_id: string; created_at: string };
  type CompletedRow = { id: string; title: string; completed_at: string | null };

  const allNodes: NodeRow[] = nodesResult.data ?? [];
  const edges: EdgeRow[] = edgesResult.data ?? [];
  const feedbackEvents: FeedbackRow[] = feedbackResult.data ?? [];
  const recentlyCompleted: CompletedRow[] = recentlyCompletedResult.data ?? [];

  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const activeNodes = allNodes.filter((n) => n.status !== "completed");

  // Sort active nodes by score desc for priority ordering
  const sortedActive = [...activeNodes].sort((a, b) => {
    const sa = a.current_importance_score ?? 50;
    const sb = b.current_importance_score ?? 50;
    return sb - sa;
  });

  // ---------------------------------------------------------------------------
  // 1. Selected node — always included at full detail, highest priority
  // ---------------------------------------------------------------------------
  if (params.selectedNodeId) {
    const sel = allNodes.find((n) => n.id === params.selectedNodeId);
    if (sel) {
      const neighborEdges = edges.filter(
        (e) => e.source_node_id === sel.id || e.target_node_id === sel.id,
      );
      const neighborTitles = neighborEdges
        .map((e) => {
          const otherId = e.source_node_id === sel.id ? e.target_node_id : e.source_node_id;
          return nodeById.get(otherId)?.title;
        })
        .filter(Boolean) as string[];

      const lines = [
        `[SELECTED NODE]`,
        `Title: ${sel.title}`,
        `Type: ${sel.node_type}`,
        `Importance: ${sel.importance}${sel.current_importance_score != null ? ` (score: ${Math.round(sel.current_importance_score)})` : ""}`,
        `Status: ${sel.status}`,
        sel.summary ? `Summary: ${sel.summary}` : null,
        neighborTitles.length > 0 ? `Connected to: ${neighborTitles.join(", ")}` : null,
        neighborEdges.length > 0
          ? `Edge types: ${[...new Set(neighborEdges.map((e) => e.edge_type))].join(", ")}`
          : null,
      ].filter(Boolean) as string[];

      const text = lines.join("\n");
      items.push({ kind: "node", id: sel.id, text, priority: 100, tokens: estimateTokens(text) });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Workspace summary — always near top
  // ---------------------------------------------------------------------------
  const goalCount = activeNodes.filter((n) => n.node_type === "goal").length;
  const workspaceSummary = `Workspace overview: ${activeNodes.length} active nodes, ${goalCount} goals, ${edges.length} connections.`;
  items.push({
    kind: "workspace_summary",
    id: "ws",
    text: workspaceSummary,
    priority: 90,
    tokens: estimateTokens(workspaceSummary),
  });

  // ---------------------------------------------------------------------------
  // 3. Top important active nodes (up to 30, priority by score tier)
  // ---------------------------------------------------------------------------
  const perNodeBudget = 80; // ~320 chars each in condensed form
  for (const node of sortedActive.slice(0, 30)) {
    if (node.id === params.selectedNodeId) continue; // already added as selected
    const score = node.current_importance_score ?? 50;
    const summarySnippet = node.summary
      ? truncateToTokens(node.summary, perNodeBudget)
      : null;
    const parts = [
      `${node.title} [${node.node_type}]`,
      summarySnippet,
      `score: ${Math.round(score)}, status: ${node.status}`,
    ].filter(Boolean);
    const text = parts.join(" — ");
    const priority = score >= 80 ? 75 : score >= 50 ? 55 : 35;
    items.push({ kind: "node", id: node.id, text, priority, tokens: estimateTokens(text) });
  }

  // ---------------------------------------------------------------------------
  // 4. Recently completed nodes (within COMPLETED_NODE_CONTEXT_WINDOW_HOURS)
  // ---------------------------------------------------------------------------
  for (const node of recentlyCompleted) {
    const text = `Recently completed: ${node.title}`;
    items.push({ kind: "node", id: node.id, text, priority: 30, tokens: estimateTokens(text) });
  }

  // ---------------------------------------------------------------------------
  // 5. Recent user actions (feedback events)
  // ---------------------------------------------------------------------------
  if (feedbackEvents.length > 0) {
    const eventLines = feedbackEvents.slice(0, 10).map((e) => {
      const nodeTitle = nodeById.get(e.entity_id)?.title ?? e.entity_id;
      return `${e.event_type}: "${nodeTitle}"`;
    });
    const text = `Recent actions:\n${eventLines.join("\n")}`;
    items.push({
      kind: "event",
      id: "feedback",
      text,
      priority: 28,
      tokens: estimateTokens(text),
    });
  }

  // ---------------------------------------------------------------------------
  // Token budget enforcement — greedy fill by priority
  // ---------------------------------------------------------------------------
  items.sort((a, b) => b.priority - a.priority);

  const included: ContextItem[] = [];
  let usedTokens = 0;
  let truncatedCount = 0;

  for (const item of items) {
    if (usedTokens + item.tokens <= budget) {
      included.push(item);
      usedTokens += item.tokens;
    } else {
      truncatedCount++;
    }
  }

  const contextString = included.map((i) => i.text).join("\n\n");

  const selectedTitle = params.selectedNodeId
    ? allNodes.find((n) => n.id === params.selectedNodeId)?.title
    : null;
  const scopeLabel = selectedTitle
    ? `node: "${selectedTitle}"`
    : `workspace (${activeNodes.length} active nodes)`;

  return {
    contextString,
    itemsIncluded: included.length,
    itemsTruncated: truncatedCount,
    estimatedTokens: usedTokens,
    scopeLabel,
  };
}
