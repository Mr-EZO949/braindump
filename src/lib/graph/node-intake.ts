// What every new node gets, whichever door it came in through — an accepted
// brain-dump proposal (/api/proposals/nodes/review), a chat action
// (change-set.ts) or the Create sheet (/api/nodes/[id]/intake, since
// 2026-10-05). Spec: docs/unified-turn.md.
//
// Until 2026-09-30 only the dump path did this. A node added through chat had
// no embedding unless the browser stayed open to request one (so later dedup
// couldn't see it), no accept event (ranking's user-confirmation signal), no
// significance judgment, and its own importance labels ("critical").

import type { SupabaseClient } from "@supabase/supabase-js";

import { generateAndStoreEmbeddings } from "@/lib/ai/embeddings";
import { scoreNodesJudgment } from "@/lib/ai/judgment";
import { computeWorkspaceScores, type NodeScoreUpdate } from "@/lib/ai/scoring";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { KNOWLEDGE_TYPES } from "@/lib/graph/node-types";
import type { NodeType, WorkspaceProfile } from "@/types/graph";

export interface IntakeScope {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}

export interface IntakeNode {
  id: string;
  title: string;
  summary: string | null;
  node_type: string;
}

// Neutral until the scorer runs.
export const DEFAULT_IMPORTANCE_INDEX = 50;

// The `nodes` row for a new AI-created node.
export function newNodeRow(params: {
  userId: string;
  workspaceId: string;
  title: string;
  nodeType: NodeType;
  summary?: string | null;
  body?: string | null;
  targetDate?: string | null;
  importanceIndex?: number;
  // A milestone the user already reached ("got my first V7 today").
  completed?: boolean;
}) {
  const importanceIndex = params.importanceIndex ?? DEFAULT_IMPORTANCE_INDEX;
  return {
    user_id: params.userId,
    workspace_id: params.workspaceId,
    title: params.title,
    summary: params.summary ?? null,
    body: params.body ?? null,
    raw_text: null,
    node_type: params.nodeType,
    importance: getImportanceLabel(importanceIndex),
    importance_index: importanceIndex,
    color: NODE_COLOR_BY_TYPE[params.nodeType],
    status: params.completed ? ("completed" as const) : ("active" as const),
    completed_at: params.completed ? new Date().toISOString() : null,
    target_date: params.targetDate ?? null,
  };
}

// Embeds the new nodes and waits: retrieval, dedup, clustering and the
// connection engine all read the embedding. One batch call; a vector already
// computed for the same text (`known` — a dump's dedup embedded every
// proposal) is reused. A failed embedding never fails the accept — it goes to
// the retry queue.
export async function embedNewNodes(
  scope: IntakeScope,
  nodes: IntakeNode[],
  known?: ReadonlyMap<string, number[]>,
): Promise<void> {
  await generateAndStoreEmbeddings({
    nodes: nodes.map((node) => ({ nodeId: node.id, title: node.title, summary: node.summary })),
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    supabase: scope.supabase,
    known,
  }).catch(() => {
    // The nodes are accepted regardless.
  });
}

// The significance judgment for the new nodes, then one rescore that reads it.
// Ideas and notes are skipped: they rarely drive Focus, and a dump can create
// ten of them. Best-effort — without the judgment the scorer redistributes its
// weight. Returns the new scores (the browser resizes nodes from them).
export async function judgeAndRescore(
  scope: IntakeScope,
  nodes: IntakeNode[],
  today?: string,
): Promise<NodeScoreUpdate[]> {
  const { supabase, userId, workspaceId } = scope;
  try {
    const candidates = nodes.filter((node) => !KNOWLEDGE_TYPES.has(node.node_type as NodeType));
    if (candidates.length > 0) {
      const { data: workspaceRow } = await supabase
        .from("workspaces")
        .select("profile_payload")
        .eq("id", workspaceId)
        .eq("user_id", userId)
        .maybeSingle();
      const workspaceProfile =
        workspaceRow && typeof workspaceRow === "object"
          ? ((workspaceRow as { profile_payload?: WorkspaceProfile | null }).profile_payload ?? null)
          : null;
      await scoreNodesJudgment({
        nodes: candidates.map((node) => ({
          id: node.id,
          title: node.title,
          summary: node.summary,
          node_type: node.node_type,
        })),
        workspaceProfile,
        runType: "node_judgment",
        supabase,
        userId,
        workspaceId,
      });
    }
  } catch (err) {
    console.warn(
      "[node-intake] node judgment failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const { nodeUpdates } = await computeWorkspaceScores({ workspaceId, userId, supabase, today });
  return nodeUpdates;
}

// ---------------------------------------------------------------------------
// Hand-made nodes (#25, 2026-10-05). The Create sheet writes its row from the
// browser, then asks /api/nodes/[id]/intake for the same intake an AI-made
// node gets: embedding, accept event (the user made it — a confirmation),
// judgment → rescore. The user's save never waits on it.
// ---------------------------------------------------------------------------

export type HandMadeIntake =
  | { status: "done"; scores: NodeScoreUpdate[] }
  | { status: "already" | "not_found" };

export async function intakeHandMadeNode(
  scope: IntakeScope,
  nodeId: string,
  today?: string,
): Promise<HandMadeIntake> {
  const { supabase, userId, workspaceId } = scope;
  const { data: row } = await supabase
    .from("nodes")
    .select("id, title, summary, node_type")
    .eq("id", nodeId)
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!row) return { status: "not_found" };
  const node = row as IntakeNode;

  // Once per node: a repeated call (a retry, a double submit) doesn't pay for
  // a second judgment or count the accept twice.
  const { data: seen } = await supabase
    .from("feedback_events")
    .select("id")
    .eq("user_id", userId)
    .eq("entity_type", "node")
    .eq("entity_id", nodeId)
    .eq("event_type", "accept_node")
    .limit(1)
    .maybeSingle();
  if (seen) return { status: "already" };

  const [, feedback] = await Promise.all([
    embedNewNodes(scope, [node]),
    supabase.from("feedback_events").insert({
      user_id: userId,
      workspace_id: workspaceId,
      event_type: "accept_node",
      entity_type: "node",
      entity_id: nodeId,
      metadata: { source: "manual", node_type: node.node_type },
    }),
  ]);
  if (feedback.error) console.warn("[node-intake] accept feedback not saved:", feedback.error.message);

  const scores = await judgeAndRescore(scope, [node], today);
  return { status: "done", scores };
}

// A node's embedding again, from its current title + summary (after a hand
// edit or a chat rename changed them). Best-effort, like embedNewNodes.
export async function reembedNodes(scope: IntakeScope, nodeIds: string[]): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const { data } = await scope.supabase
    .from("nodes")
    .select("id, title, summary, node_type")
    .in("id", nodeIds)
    .eq("user_id", scope.userId)
    .eq("workspace_id", scope.workspaceId);
  const nodes = (data ?? []) as IntakeNode[];
  if (nodes.length > 0) await embedNewNodes(scope, nodes);
  return nodes.length;
}
