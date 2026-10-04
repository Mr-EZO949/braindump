// The client side of connection analysis (/api/nodes/analyze): its answer,
// the notice a partial failure shows, and the links card it becomes in a
// thread (moved out of AppShell, 2026-10-04).

import type { ProposedEdgeWithNodes } from "@/lib/ai/connection";
import type { MergeCandidate } from "@/lib/ai/merge";
import type { ConnectionsCardData } from "@/types/chat";

export type AnalysisResponse = {
  proposed_edges?: ProposedEdgeWithNodes[];
  merge_candidates?: MergeCandidate[];
  proposed?: number;
  skipped?: number;
  failed?: number;
  failed_node_ids?: string[];
  warning?: string;
  error?: string;
};

export type AINotice = {
  tone: "warning" | "error";
  message: string;
};

export function buildAnalysisNotice(result: AnalysisResponse): AINotice | null {
  if (result.warning && result.warning.trim()) {
    return {
      tone: "warning",
      message: result.warning.trim(),
    };
  }

  if (result.failed && result.failed > 0) {
    return {
      tone: "warning",
      message:
        result.proposed_edges && result.proposed_edges.length > 0
          ? `Some connection checks failed (${result.failed}), but partial results are still shown.`
          : `Connection analysis failed for ${result.failed} item${result.failed === 1 ? "" : "s"}. Retry when ready.`,
    };
  }

  return null;
}

/** Proposed links as a card awaiting the user in the thread. */
export function connectionsCardFromEdges(edges: ProposedEdgeWithNodes[]): ConnectionsCardData {
  return {
    status: "awaiting" as const,
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceTitle: edge.source_title,
      targetTitle: edge.target_title,
      edgeType: edge.edge_type,
      explanation: edge.explanation || null,
    })),
  };
}

/** Unique, non-empty node ids, first-seen order. */
export function normalizeNodeIds(nodeIds: string[]): string[] {
  return Array.from(
    new Set(nodeIds.filter((nodeId): nodeId is string => typeof nodeId === "string" && nodeId.length > 0)),
  );
}
