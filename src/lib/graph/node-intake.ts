// What every AI-created node gets, whichever door it came in through — an
// accepted brain-dump proposal (/api/proposals/nodes/review) or a chat action
// (change-set.ts). Spec: docs/unified-turn.md.
//
// Until 2026-09-30 only the dump path did this. A node added through chat had
// no embedding unless the browser stayed open to request one (so later dedup
// couldn't see it), no accept event (ranking's user-confirmation signal), no
// significance judgment, and its own importance labels ("critical").

import type { SupabaseClient } from "@supabase/supabase-js";

import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { scoreNodesJudgment } from "@/lib/ai/judgment";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
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

// Embeds the new nodes in parallel and waits: retrieval, dedup, clustering and
// the connection engine all read the embedding. A failed embedding never fails
// the accept — it goes to the retry queue.
export async function embedNewNodes(scope: IntakeScope, nodes: IntakeNode[]): Promise<void> {
  await Promise.all(
    nodes.map((node) =>
      generateAndStoreEmbedding({
        nodeId: node.id,
        title: node.title,
        summary: node.summary,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        supabase: scope.supabase,
      }).catch(() => {
        // The node is accepted regardless.
      }),
    ),
  );
}

// The significance judgment for the new nodes, then one rescore that reads it.
// Ideas and notes are skipped: they rarely drive Focus, and a dump can create
// ten of them. Best-effort — without the judgment the scorer redistributes its
// weight.
export async function judgeAndRescore(
  scope: IntakeScope,
  nodes: IntakeNode[],
  today?: string,
): Promise<void> {
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

  await computeWorkspaceScores({ workspaceId, userId, supabase, today });
}
