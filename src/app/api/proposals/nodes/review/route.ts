// POST /api/proposals/nodes/review
// Bulk accept or reject proposed nodes.
// Accept: writes to canonical nodes table, persists provenance on proposed_nodes,
// seeds sparse structural + same-dump soft proposed_edges from the extraction
// batch, and records feedback events on the canonical nodes.
// Reject: marks proposals rejected + records feedback events.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { generateAndStoreEmbedding } from "@/lib/ai/embeddings";
import { runClusteringPass } from "@/lib/ai/clustering";
import { scoreNodesJudgment } from "@/lib/ai/judgment";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import type { NodeType, WorkspaceProfile } from "@/types/graph";
import type { ExtractionSoftLink } from "@/types/ai";

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
  "project", "task", "class", "concept", "idea", "goal", "habit",
]);

type AcceptedPair = {
  created: {
    id: string;
    workspace_id: string;
    title: string;
    summary: string | null;
    node_type: NodeType;
  };
  edits?: ReviewAction["edits"];
  proposal: {
    id: string;
    ai_run_id: string | null;
    extraction_confidence: number | null;
    local_ref: string | null;
    primary_parent_local_ref: string | null;
    existing_parent_node_id: string | null;
    depends_on_local_refs: string[] | null;
    soft_links: ExtractionSoftLink[] | null;
    workspace_id: string;
  };
};

type SeededEdgeType =
  | "belongs_to"
  | "required_for"
  | "supports"
  | "related_to"
  | "prerequisite_for"
  | "useful_for"
  | "inspired_by";

function buildSeededEdgeExplanation(params: {
  edgeType: SeededEdgeType;
  sourceTitle: string;
  targetTitle: string;
  rationale?: string | null;
}) {
  if (params.rationale?.trim()) {
    return params.rationale.trim();
  }

  switch (params.edgeType) {
    case "belongs_to":
      return `${params.sourceTitle} is a direct child of ${params.targetTitle} in the extracted brain dump.`;
    case "required_for":
      return `${params.sourceTitle} must happen before ${params.targetTitle}.`;
    case "prerequisite_for":
      return `${params.sourceTitle} is a prerequisite for ${params.targetTitle}.`;
    case "supports":
      return `${params.sourceTitle} supports progress toward ${params.targetTitle}.`;
    case "useful_for":
      return `${params.sourceTitle} is useful for ${params.targetTitle}.`;
    case "inspired_by":
      return `${params.sourceTitle} is inspired by ${params.targetTitle}.`;
    case "related_to":
      return `${params.sourceTitle} is meaningfully related to ${params.targetTitle}.`;
  }
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
  const acceptedNodes: Array<AcceptedPair["created"]> = [];
  const acceptedEdges: Array<Record<string, unknown>> = [];
  const feedbackRows: Array<Record<string, unknown>> = [];
  let structuralEdgeProposalCount = 0;

  // ---------------------------------------------------------------------------
  // Process accepts
  // ---------------------------------------------------------------------------
  const toAccept = actions.filter((a) => a.action === "accept");
  let acceptedPairs: AcceptedPair[] = [];
  const existingParentIds = Array.from(
    new Set(
      toAccept
        .map((action) => proposalMap.get(action.id)?.existing_parent_node_id as string | null | undefined)
        .filter((id): id is string => Boolean(id))
    )
  );

  const { data: existingParentRows } = existingParentIds.length
    ? await supabase
        .from("nodes")
        .select("id, title, workspace_id, status")
        .in("id", existingParentIds)
        .eq("user_id", user.id)
    : { data: [] as Array<Record<string, unknown>> };

  const existingParentMap = new Map(
    (existingParentRows ?? []).map((row) => [
      row.id as string,
      {
        id: row.id as string,
        title: row.title as string,
        workspace_id: row.workspace_id as string,
        status: row.status as string | null,
      },
    ])
  );

  if (toAccept.length > 0) {
    const acceptedInputs = toAccept.flatMap((action) => {
      const proposal = proposalMap.get(action.id);
      if (!proposal) return [];

      const title = (action.edits?.proposed_title ?? proposal.proposed_title as string).trim();
      const summary = (action.edits?.proposed_summary ?? proposal.proposed_summary as string | null) || null;
      const rawType = action.edits?.proposed_node_type ?? (proposal.proposed_node_type as string);
      const nodeType: NodeType = VALID_NODE_TYPES.has(rawType as NodeType)
        ? (rawType as NodeType)
        : "concept";

      const importanceIndex = 50; // Neutral default — scoring engine will update in Phase 7

      // target_date carries through from the proposal to the canonical node
      // unchanged. Validation already ensured the field is YYYY-MM-DD or null,
      // and the user can edit it post-accept via update_node / the form.
      const targetDate = (proposal.proposed_target_date as string | null) ?? null;

      // Auto-complete marker — the entries route sets source_span to
      // `[[AUTO_COMPLETE]]` for proposals the AI flagged as "user
      // already did this." The node lands in the graph with status =
      // completed so it never shows up in active task lists. The
      // source_span text is replaced with null so it doesn't pollute
      // the node's provenance.
      const autoComplete = proposal.source_span === "[[AUTO_COMPLETE]]";
      const statusOnInsert: "active" | "completed" = autoComplete ? "completed" : "active";

      return [{
        edits: action.edits,
        proposal,
        nodeRow: {
          user_id: user.id,
          workspace_id: proposal.workspace_id as string,
          title,
          summary,
          raw_text: null,
          node_type: nodeType,
          importance: getImportanceLabel(importanceIndex),
          importance_index: importanceIndex,
          color: NODE_COLOR_BY_TYPE[nodeType],
          status: statusOnInsert,
          completed_at: autoComplete ? new Date().toISOString() : null,
          target_date: targetDate,
        },
      }];
    });

    if (acceptedInputs.length > 0) {
      const { data: created, error: insertError } = await supabase
        .from("nodes")
        .insert(acceptedInputs.map((entry) => entry.nodeRow))
        .select();

      if (insertError) {
        return NextResponse.json(
          { error: "Failed to create nodes", detail: insertError.message },
          { status: 500 }
        );
      }
      acceptedPairs = acceptedInputs.flatMap((entry, index) => {
        const createdNode = created?.[index];
        if (!createdNode) return [];
        return [{
          created: createdNode as AcceptedPair["created"],
          edits: entry.edits,
          proposal: {
            id: entry.proposal.id as string,
            ai_run_id: (entry.proposal.ai_run_id as string | null) ?? null,
            extraction_confidence: (entry.proposal.extraction_confidence as number | null) ?? null,
            local_ref: (entry.proposal.local_ref as string | null) ?? null,
            primary_parent_local_ref: (entry.proposal.primary_parent_local_ref as string | null) ?? null,
            existing_parent_node_id: (entry.proposal.existing_parent_node_id as string | null) ?? null,
            depends_on_local_refs: (entry.proposal.depends_on_local_refs as string[] | null) ?? null,
            soft_links: (entry.proposal.soft_links as ExtractionSoftLink[] | null) ?? null,
            workspace_id: entry.proposal.workspace_id as string,
          },
        }];
      });

      acceptedNodes.push(...acceptedPairs.map((pair) => pair.created));

      // Embed each accepted node in parallel + AWAIT before returning. The
      // old fire-and-forget version raced against downstream work (the
      // clustering pass that runs on the next /api/entries call would see
      // nodes without embeddings and skip them, never proposing umbrellas).
      // Failures are still swallowed per-node so a flaky Gemini call
      // doesn't fail the accept; we just lose a single embedding to the
      // retry queue.
      await Promise.all(
        acceptedPairs.map(({ created: node }) =>
          generateAndStoreEmbedding({
            nodeId: node.id,
            title: node.title,
            summary: node.summary,
            workspaceId: node.workspace_id,
            userId: user.id,
            supabase,
          }).catch(() => {
            // Logged silently — node is accepted regardless
          }),
        ),
      );

      await Promise.all(
        acceptedPairs.map(({ created, proposal }) =>
          supabase
            .from("proposed_nodes")
            .update({
              proposal_status: "accepted",
              accepted_node_id: created.id,
            })
            .eq("id", proposal.id)
            .eq("user_id", user.id)
        )
      );

      const directAcceptedEdgeRows = acceptedPairs.flatMap(({ created, proposal }) => {
        if (!proposal.existing_parent_node_id) {
          return [];
        }

        const parent = existingParentMap.get(proposal.existing_parent_node_id);
        if (
          !parent ||
          parent.workspace_id !== created.workspace_id ||
          parent.status === "archived"
        ) {
          return [];
        }

        return [
          {
            user_id: user.id,
            workspace_id: created.workspace_id,
            source_node_id: created.id,
            target_node_id: parent.id,
            edge_type: "belongs_to" as const,
            confidence: Math.max(proposal.extraction_confidence ?? 0.84, 0.84),
            explanation: buildSeededEdgeExplanation({
              edgeType: "belongs_to",
              sourceTitle: created.title,
              targetTitle: parent.title,
            }),
            status: "active",
            user_confirmed: true,
          },
        ];
      });

      if (directAcceptedEdgeRows.length > 0) {
        const { data: insertedEdges, error: directEdgeError } = await supabase
          .from("edges")
          .insert(directAcceptedEdgeRows)
          .select("*");

        if (directEdgeError) {
          return NextResponse.json(
            { error: "Failed to attach accepted nodes", detail: directEdgeError.message },
            { status: 500 }
          );
        }

        acceptedEdges.push(...(insertedEdges ?? []));
      }

      const acceptedByLocalRef = new Map<
        string,
        {
          aiRunId: string | null;
          confidence: number;
          nodeId: string;
          title: string;
        }
      >();

      acceptedPairs.forEach(({ created, proposal }) => {
        if (!proposal.local_ref) return;
        acceptedByLocalRef.set(proposal.local_ref, {
          aiRunId: proposal.ai_run_id,
          confidence: proposal.extraction_confidence ?? 0.75,
          nodeId: created.id,
          title: created.title,
        });
      });

      const structuralEdgeRows: Array<{
        ai_run_id: string | null;
        confidence: number;
        edge_type: SeededEdgeType;
        explanation: string;
        source_node_id: string;
        target_node_id: string;
        user_id: string;
        workspace_id: string;
      }> = [];
      const seenEdgeKeys = new Set<string>();
      // Track which nodes already have a belongs_to edge (as source).
      // Each node can have at most one parent — first one wins.
      const nodesWithParent = new Set<string>();

      // Seed direct edges (existing_parent_node_id) already created above
      for (const row of directAcceptedEdgeRows) {
        seenEdgeKeys.add(`${row.source_node_id}:${row.target_node_id}`);
        if (row.edge_type === "belongs_to") {
          nodesWithParent.add(row.source_node_id);
        }
      }

      const queueEdge = (row: {
        ai_run_id: string | null;
        confidence: number;
        edge_type: SeededEdgeType;
        explanation: string;
        source_node_id: string;
        target_node_id: string;
        user_id: string;
        workspace_id: string;
      }) => {
        if (row.source_node_id === row.target_node_id) return;
        const key = `${row.source_node_id}:${row.target_node_id}`;
        const revKey = `${row.target_node_id}:${row.source_node_id}`;
        if (seenEdgeKeys.has(key) || seenEdgeKeys.has(revKey)) return;
        // Enforce single parent: skip if this node already has a belongs_to edge
        if (row.edge_type === "belongs_to" && nodesWithParent.has(row.source_node_id)) return;
        seenEdgeKeys.add(key);
        if (row.edge_type === "belongs_to") {
          nodesWithParent.add(row.source_node_id);
        }
        structuralEdgeRows.push(row);
      };

      acceptedPairs.forEach(({ created, proposal }) => {
        if (proposal.primary_parent_local_ref) {
          const parent = acceptedByLocalRef.get(proposal.primary_parent_local_ref);
          if (parent) {
            queueEdge({
              ai_run_id: proposal.ai_run_id,
              confidence: Math.max(proposal.extraction_confidence ?? 0.75, 0.78),
              edge_type: "belongs_to",
              explanation: buildSeededEdgeExplanation({
                edgeType: "belongs_to",
                sourceTitle: created.title,
                targetTitle: parent.title,
              }),
              source_node_id: created.id,
              target_node_id: parent.nodeId,
              user_id: user.id,
              workspace_id: created.workspace_id,
            });
          }
        }

        for (const dependencyRef of proposal.depends_on_local_refs ?? []) {
          const dependency = acceptedByLocalRef.get(dependencyRef);
          if (!dependency) continue;
          queueEdge({
            ai_run_id: proposal.ai_run_id ?? dependency.aiRunId,
            confidence: Math.max(proposal.extraction_confidence ?? dependency.confidence ?? 0.72, 0.72),
            edge_type: "required_for",
            explanation: buildSeededEdgeExplanation({
              edgeType: "required_for",
              sourceTitle: dependency.title,
              targetTitle: created.title,
            }),
            source_node_id: dependency.nodeId,
            target_node_id: created.id,
            user_id: user.id,
            workspace_id: created.workspace_id,
          });
        }

        for (const softLink of proposal.soft_links ?? []) {
          const target = acceptedByLocalRef.get(softLink.target_local_ref);
          if (!target) continue;
          queueEdge({
            ai_run_id: proposal.ai_run_id ?? target.aiRunId,
            confidence: Math.max(proposal.extraction_confidence ?? target.confidence ?? 0.68, 0.68),
            edge_type: softLink.edge_type,
            explanation: buildSeededEdgeExplanation({
              edgeType: softLink.edge_type,
              sourceTitle: created.title,
              targetTitle: target.title,
              rationale: softLink.rationale,
            }),
            source_node_id: created.id,
            target_node_id: target.nodeId,
            user_id: user.id,
            workspace_id: created.workspace_id,
          });
        }
      });

      // Split: belongs_to edges are auto-accepted (tree backbone the user
      // implicitly approved), everything else goes to proposed_edges for review.
      const autoAcceptRows = structuralEdgeRows.filter((r) => r.edge_type === "belongs_to");
      const proposalRows = structuralEdgeRows.filter((r) => r.edge_type !== "belongs_to");

      if (autoAcceptRows.length > 0) {
        const edgeInsertRows = autoAcceptRows.map((row) => ({
          user_id: row.user_id,
          workspace_id: row.workspace_id,
          source_node_id: row.source_node_id,
          target_node_id: row.target_node_id,
          edge_type: row.edge_type,
          confidence: row.confidence,
          explanation: row.explanation,
          status: "active",
          user_confirmed: true,
        }));

        const { data: insertedEdges, error: edgeError } = await supabase
          .from("edges")
          .insert(edgeInsertRows)
          .select("*");

        if (!edgeError && insertedEdges) {
          acceptedEdges.push(...insertedEdges);
          structuralEdgeProposalCount += insertedEdges.length;
        }
      }

      if (proposalRows.length > 0) {
        await Promise.all(
          proposalRows.map(async (row) => {
            const { error } = await supabase.from("proposed_edges").insert({
              ...row,
              proposal_status: "pending_review",
            });
            if (!error) structuralEdgeProposalCount += 1;
          })
        );
      }

      // Anchor any accepted node that ended up without a belongs_to edge to
      // the workspace's bootstrap root. Two things land here:
      //   - subtree-roots (V7 climbing goal, OS course concept) where the
      //     AI didn't pick an existing parent and didn't reference a
      //     proposed sibling
      //   - "Call mom this weekend"-style standalone tasks that don't fit
      //     under any goal but should still hang off the workspace
      // Without this they'd float as disconnected clusters on the canvas.
      const orphanIds = acceptedPairs
        .map((pair) => pair.created.id)
        .filter((id) => !nodesWithParent.has(id));
      if (orphanIds.length > 0) {
        const workspaceIds = Array.from(
          new Set(acceptedPairs.map((pair) => pair.created.workspace_id)),
        );
        const { data: workspaceRows } = await supabase
          .from("workspaces")
          .select("id, bootstrap_root_node_id")
          .in("id", workspaceIds)
          .eq("user_id", user.id);
        const rootByWorkspace = new Map<string, string>();
        for (const row of workspaceRows ?? []) {
          if (row.bootstrap_root_node_id) {
            rootByWorkspace.set(row.id as string, row.bootstrap_root_node_id as string);
          }
        }
        const anchorRows: Array<Record<string, unknown>> = [];
        for (const pair of acceptedPairs) {
          if (nodesWithParent.has(pair.created.id)) continue;
          const rootId = rootByWorkspace.get(pair.created.workspace_id);
          if (!rootId || rootId === pair.created.id) continue;
          anchorRows.push({
            user_id: user.id,
            workspace_id: pair.created.workspace_id,
            source_node_id: pair.created.id,
            target_node_id: rootId,
            edge_type: "belongs_to",
            confidence: 0.8,
            explanation: `${pair.created.title} anchored to workspace.`,
            status: "active",
            user_confirmed: true,
          });
        }
        if (anchorRows.length > 0) {
          const { data: anchorEdges } = await supabase
            .from("edges")
            .insert(anchorRows)
            .select("*");
          if (anchorEdges) {
            acceptedEdges.push(...anchorEdges);
            structuralEdgeProposalCount += anchorEdges.length;
          }
        }
      }
    }

    // Record accept feedback events
    feedbackRows.push(
      ...acceptedPairs.map((pair) => ({
        user_id: user.id,
        workspace_id: pair.created.workspace_id,
        event_type: "accept_node",
        entity_type: "node",
        entity_id: pair.created.id,
        metadata: {
          edits: pair.edits ?? null,
          proposal_id: pair.proposal.id,
          local_ref: pair.proposal.local_ref,
          existing_parent_node_id: pair.proposal.existing_parent_node_id,
        },
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

  let rescoredAcceptedNodes: Array<Record<string, unknown>> = acceptedNodes;

  // Phase 7 — recompute scores for the affected workspace and return fresh node rows.
  if (acceptedPairs.length > 0) {
    const workspaceId = acceptedPairs[0].created.workspace_id;

    // Per-node AI judgment for newly accepted nodes. Best-effort: if Haiku
    // fails or is unconfigured, the heuristic scorer will still run and just
    // redistribute the judgment weight. Writes to ai_node_judgments BEFORE
    // computeWorkspaceScores so the fresh judgment feeds into the rescore.
    try {
      const { data: workspaceRow } = await supabase
        .from("workspaces")
        .select("profile_payload")
        .eq("id", workspaceId)
        .eq("user_id", user.id)
        .maybeSingle();
      const workspaceProfile =
        workspaceRow && typeof workspaceRow === "object"
          ? ((workspaceRow as { profile_payload?: WorkspaceProfile | null }).profile_payload ?? null)
          : null;

      // Skip judgment on low-leverage types (ideas) — they rarely drive the
      // graph's focus ranking, and a Haiku call per extraction-accept adds up
      // fast when a brain dump creates 10+ ideas. Ideas fall back to heuristic
      // scoring only; actionable types (task/goal/project/class/habit) still
      // get judged.
      const judgmentCandidates = acceptedPairs.filter(
        (pair) => pair.created.node_type !== "idea",
      );
      if (judgmentCandidates.length > 0) {
        await scoreNodesJudgment({
          nodes: judgmentCandidates.map((pair) => ({
            id: pair.created.id,
            title: pair.created.title,
            summary: pair.created.summary,
            node_type: pair.created.node_type,
          })),
          workspaceProfile,
          runType: "node_judgment",
          supabase,
          userId: user.id,
          workspaceId,
        });
      }
    } catch (err) {
      console.warn(
        "[proposals/review] node judgment failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    await computeWorkspaceScores({ workspaceId, userId: user.id, supabase });

    const acceptedNodeIds = acceptedPairs.map((pair) => pair.created.id);
    const { data: refreshedNodes } = await supabase
      .from("nodes")
      .select("*")
      .in("id", acceptedNodeIds)
      .eq("user_id", user.id);

    if (refreshedNodes && refreshedNodes.length > 0) {
      const refreshedMap = new Map(
        refreshedNodes.map((node) => [node.id as string, node])
      );
      rescoredAcceptedNodes = acceptedPairs
        .map((pair) => refreshedMap.get(pair.created.id))
        .filter(Boolean) as Array<Record<string, unknown>>;
    }
  }

  // Retroactive clustering pass — runs AFTER acceptance so freshly-created
  // nodes (with embeddings now persisted) are eligible for grouping. Best-
  // effort; failures here don't block the response. Suggestions are
  // persisted to cluster_suggestions and surface either via the returned
  // payload (clients can show them in a dedicated review section) or on
  // the next /api/entries call.
  let clusterSuggestions: Awaited<ReturnType<typeof runClusteringPass>> = [];
  if (acceptedPairs.length > 0) {
    const workspaceIdsTouched = Array.from(
      new Set(acceptedPairs.map((pair) => pair.created.workspace_id)),
    );
    try {
      const passes = await Promise.all(
        workspaceIdsTouched.map((wsId) =>
          runClusteringPass({
            supabase,
            userId: user.id,
            workspaceId: wsId,
          }),
        ),
      );
      clusterSuggestions = passes.flat();
    } catch (err) {
      console.error("[review] clustering pass failed", err);
    }
  }

  return NextResponse.json({
    accepted_nodes: rescoredAcceptedNodes,
    accepted_edges: acceptedEdges,
    accepted_count: acceptedPairs.length,
    generated_edge_proposals: structuralEdgeProposalCount,
    rejected_count: toReject.length,
    feedback_event_count: feedbackRows.length,
    cluster_suggestions: clusterSuggestions,
  });
}
