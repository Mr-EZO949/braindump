// POST /api/proposals/nodes/review
// Bulk accept or reject proposed nodes.
// Accept: writes to canonical nodes table + records feedback events.
// Reject: marks proposals rejected + records feedback events.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import type { NodeType } from "@/types/graph";

interface ReviewAction {
  id: string; // proposed_node id
  action: "accept" | "reject";
  edits?: {
    proposed_title: string;
    proposed_summary: string | null;
    proposed_node_type: string;
  };
}

const VALID_NODE_TYPES = new Set<NodeType>([
  "project", "task", "class", "concept", "idea", "journal", "question", "goal",
]);

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { actions } = body as { actions: ReviewAction[] };
  if (!Array.isArray(actions) || actions.length === 0) {
    return NextResponse.json({ error: "actions must be a non-empty array" }, { status: 400 });
  }

  // Fetch all referenced proposals in one query, scoped to this user
  const ids = actions.map((a) => a.id);
  const { data: proposals, error: fetchError } = await supabase
    .from("proposed_nodes")
    .select("*")
    .in("id", ids)
    .eq("user_id", user.id)
    .eq("proposal_status", "pending_review");

  if (fetchError || !proposals) {
    return NextResponse.json({ error: "Failed to fetch proposals" }, { status: 500 });
  }

  const proposalMap = new Map(proposals.map((p) => [p.id as string, p]));
  const acceptedNodes: unknown[] = [];
  const feedbackRows: unknown[] = [];

  // ---------------------------------------------------------------------------
  // Process accepts
  // ---------------------------------------------------------------------------
  const toAccept = actions.filter((a) => a.action === "accept");

  if (toAccept.length > 0) {
    const nodeRows = toAccept.flatMap((action) => {
      const proposal = proposalMap.get(action.id);
      if (!proposal) return [];

      const title = (action.edits?.proposed_title ?? proposal.proposed_title as string).trim();
      const summary = (action.edits?.proposed_summary ?? proposal.proposed_summary as string | null) || null;
      const rawType = action.edits?.proposed_node_type ?? (proposal.proposed_node_type as string);
      const nodeType: NodeType = VALID_NODE_TYPES.has(rawType as NodeType)
        ? (rawType as NodeType)
        : "concept";

      const importanceIndex = 50; // Neutral default — scoring engine will update in Phase 7
      return [{
        user_id: user.id,
        workspace_id: proposal.workspace_id as string,
        title,
        summary,
        raw_text: null,
        node_type: nodeType,
        importance: getImportanceLabel(importanceIndex),
        importance_index: importanceIndex,
        color: NODE_COLOR_BY_TYPE[nodeType],
        status: "active",
      }];
    });

    if (nodeRows.length > 0) {
      const { data: created, error: insertError } = await supabase
        .from("nodes")
        .insert(nodeRows)
        .select();

      if (insertError) {
        return NextResponse.json(
          { error: "Failed to create nodes", detail: insertError.message },
          { status: 500 }
        );
      }
      acceptedNodes.push(...(created ?? []));

      // Embed each accepted node — fire per-node, never block response on failure
      for (const node of (created ?? [])) {
        const n = node as { id: string; title: string; summary: string | null; workspace_id: string };
        void generateAndStoreEmbedding({
          nodeId: n.id,
          title: n.title,
          summary: n.summary,
          workspaceId: n.workspace_id,
          userId: user.id,
          supabase,
        }).catch(() => {
          // Logged silently — node is accepted regardless
        });
      }
    }

    // Mark proposals accepted
    await supabase
      .from("proposed_nodes")
      .update({ proposal_status: "accepted" })
      .in("id", toAccept.map((a) => a.id))
      .eq("user_id", user.id);

    // Record accept feedback events
    feedbackRows.push(
      ...toAccept.map((a) => ({
        user_id: user.id,
        workspace_id: proposalMap.get(a.id)?.workspace_id as string,
        event_type: "accept_node",
        entity_type: "proposed_node",
        entity_id: a.id,
        metadata: { edits: a.edits ?? null },
      }))
    );
  }

  // ---------------------------------------------------------------------------
  // Process rejects
  // ---------------------------------------------------------------------------
  const toReject = actions.filter((a) => a.action === "reject");

  if (toReject.length > 0) {
    await supabase
      .from("proposed_nodes")
      .update({ proposal_status: "rejected" })
      .in("id", toReject.map((a) => a.id))
      .eq("user_id", user.id);

    feedbackRows.push(
      ...toReject.map((a) => ({
        user_id: user.id,
        workspace_id: proposalMap.get(a.id)?.workspace_id as string,
        event_type: "reject_node",
        entity_type: "proposed_node",
        entity_id: a.id,
        metadata: null,
      }))
    );
  }

  // ---------------------------------------------------------------------------
  // Write all feedback events in one shot
  // ---------------------------------------------------------------------------
  if (feedbackRows.length > 0) {
    await supabase.from("feedback_events").insert(feedbackRows);
  }

  return NextResponse.json({
    accepted_nodes: acceptedNodes,
    accepted_count: acceptedNodes.length,
    rejected_count: toReject.length,
    feedback_event_count: feedbackRows.length,
  });
}
