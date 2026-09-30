// POST /api/proposals/edges/review
// Bulk accept or reject proposed edges.
// Accept: writes to canonical edges table + records feedback events.
// Reject: marks proposals rejected + records feedback events.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { computeWorkspaceScores } from "@/lib/ai/scoring";

interface ReviewAction {
  id: string; // proposed_edge id
  action: "accept" | "reject";
}

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

  const ids = actions.map((a) => a.id);
  const { data: proposals, error: fetchError } = await supabase
    .from("proposed_edges")
    .select("id, workspace_id, source_node_id, target_node_id, edge_type, confidence, explanation")
    .in("id", ids)
    .eq("user_id", user.id)
    .eq("proposal_status", "pending_review");

  if (fetchError || !proposals) {
    return NextResponse.json({ error: "Failed to fetch proposals" }, { status: 500 });
  }

  const proposalMap = new Map(proposals.map((p) => [p.id as string, p]));
  const feedbackRows: Array<Record<string, unknown>> = [];
  let affectedNodeIds: string[] = [];

  // ---------------------------------------------------------------------------
  // Process accepts
  // ---------------------------------------------------------------------------
  const toAccept = actions.filter((a) => a.action === "accept");
  let acceptedEdges:
    | Array<{
        created_at: string;
        edge_type: string;
        id: string;
        source_node_id: string;
        target_node_id: string;
        user_id: string;
        workspace_id: string;
      }>
    | null = null;

  if (toAccept.length > 0) {
    // Enforce single parent: find which source nodes already have a belongs_to edge
    const belongsToAccepts = toAccept.filter((a) => {
      const p = proposalMap.get(a.id);
      return p && (p.edge_type as string) === "belongs_to";
    });

    const nodesWithParent = new Set<string>();

    if (belongsToAccepts.length > 0) {
      const sourceIds = belongsToAccepts
        .map((a) => proposalMap.get(a.id)?.source_node_id as string)
        .filter(Boolean);

      if (sourceIds.length > 0) {
        const { data: existingParentEdges } = await supabase
          .from("edges")
          .select("source_node_id")
          .eq("user_id", user.id)
          .eq("edge_type", "belongs_to")
          .neq("status", "orphaned")
          .neq("status", "user_rejected")
          .in("source_node_id", sourceIds);

        for (const row of existingParentEdges ?? []) {
          nodesWithParent.add(row.source_node_id as string);
        }
      }
    }

    const edgeRows = toAccept.flatMap((action) => {
      const proposal = proposalMap.get(action.id);
      if (!proposal) return [];

      // Skip belongs_to if node already has a parent
      const sourceId = proposal.source_node_id as string;
      if ((proposal.edge_type as string) === "belongs_to" && nodesWithParent.has(sourceId)) {
        return [];
      }

      // Track so we don't create two parents in the same batch
      if ((proposal.edge_type as string) === "belongs_to") {
        nodesWithParent.add(sourceId);
      }

      return [{
        user_id: user.id,
        workspace_id: proposal.workspace_id as string,
        source_node_id: sourceId,
        target_node_id: proposal.target_node_id as string,
        edge_type: proposal.edge_type as string,
        // Keep the "why" on the edge the user accepted.
        confidence: (proposal.confidence as number | null) ?? null,
        explanation: (proposal.explanation as string | null) ?? null,
        user_confirmed: true,
      }];
    });

    if (edgeRows.length > 0) {
      const { data: insertedEdges, error: insertError } = await supabase
        .from("edges")
        .insert(edgeRows)
        .select("*");

      if (insertError) {
        return NextResponse.json(
          { error: "Failed to create edges", detail: insertError.message },
          { status: 500 }
        );
      }

      acceptedEdges =
        (insertedEdges as Array<{
          created_at: string;
          edge_type: string;
          id: string;
          source_node_id: string;
          target_node_id: string;
          user_id: string;
          workspace_id: string;
        }> | null) ?? [];
      affectedNodeIds = Array.from(
        new Set(
          (acceptedEdges ?? []).flatMap((edge) => [
            edge.source_node_id,
            edge.target_node_id,
          ])
        )
      );
    }

    await supabase
      .from("proposed_edges")
      .update({ proposal_status: "accepted" })
      .in("id", toAccept.map((a) => a.id))
      .eq("user_id", user.id);

    feedbackRows.push(
      ...((acceptedEdges ?? []).map((edge) => ({
        user_id: user.id,
        workspace_id: edge.workspace_id,
        event_type: "confirm_edge",
        entity_type: "edge",
        entity_id: edge.id,
        metadata: null,
      })))
    );
  }

  // ---------------------------------------------------------------------------
  // Process rejects
  // ---------------------------------------------------------------------------
  const toReject = actions.filter((a) => a.action === "reject");

  if (toReject.length > 0) {
    await supabase
      .from("proposed_edges")
      .update({ proposal_status: "rejected" })
      .in("id", toReject.map((a) => a.id))
      .eq("user_id", user.id);

    feedbackRows.push(
      ...toReject.map((a) => ({
        user_id: user.id,
        workspace_id: proposalMap.get(a.id)?.workspace_id as string,
        event_type: "reject_edge",
        entity_type: "proposed_edge",
        entity_id: a.id,
        metadata: null,
      }))
    );
  }

  if (feedbackRows.length > 0) {
    await supabase.from("feedback_events").insert(feedbackRows);
  }

  let updatedNodes: Array<Record<string, unknown>> = [];

  // Phase 7 — recompute scores when edges change graph topology.
  if (toAccept.length > 0) {
    const workspaceId = proposals[0]?.workspace_id as string | undefined;
    if (workspaceId) {
      await computeWorkspaceScores({ workspaceId, userId: user.id, supabase });

      if (affectedNodeIds.length > 0) {
        const { data: refreshedNodes } = await supabase
          .from("nodes")
          .select("*")
          .in("id", affectedNodeIds)
          .eq("user_id", user.id);

        updatedNodes = (refreshedNodes ?? []) as Array<Record<string, unknown>>;
      }
    }
  }

  return NextResponse.json({
    accepted_count: toAccept.length,
    accepted_edges: acceptedEdges ?? [],
    rejected_count: toReject.length,
    updated_nodes: updatedNodes,
  });
}
