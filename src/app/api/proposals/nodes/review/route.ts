// POST /api/proposals/nodes/review
// Bulk accept or reject proposed nodes.
// Accept: writes to canonical nodes table, persists provenance on proposed_nodes,
// seeds sparse structural + same-dump soft proposed_edges from the extraction
// batch, and records feedback events on the canonical nodes.
// Reject: marks proposals rejected + records feedback events.

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { runClusteringPass } from "@/lib/ai/clustering";
import { ensureWorkspaceRoot } from "@/lib/graph/ensure-workspace-root";
import { embedNewNodes, judgeAndRescore, newNodeRow } from "@/lib/graph/node-intake";
import type { NodeType } from "@/types/graph";
import { normalizeNodeType } from "@/lib/graph/node-types";
import { normalizeEdgeType, type LinkKind } from "@/lib/graph/edge-types";
import type { ExtractionSoftLink } from "@/types/ai";

interface ReviewAction {
  id: string; // proposed_node id
  action: "accept" | "reject";
  // When a proposal is rejected because it duplicates an existing canonical
  // node, this carries the canonical node's id. Without it, any child
  // proposals whose parent_local_ref points at this proposal would be
  // orphaned (their parent never got created). With it, the children are
  // re-parented to the canonical existing node instead.
  replaced_by_node_id?: string;
  edits?: {
    proposed_title: string;
    proposed_summary: string | null;
    proposed_node_type: string;
  };
}


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

type SeededEdgeType = LinkKind;

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
    case "supports":
      return `${params.sourceTitle} helps ${params.targetTitle}.`;
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
      // proposed_body may not exist on older proposals (migration not yet
      // run); fall back to null so accept doesn't break the response.
      const body = ((proposal as { proposed_body?: string | null }).proposed_body ?? null) || null;
      const rawType = action.edits?.proposed_node_type ?? (proposal.proposed_node_type as string);
      // Legacy "concept" (proposals made before node types v2) → note.
      const nodeType: NodeType = normalizeNodeType(rawType);

      // target_date carries through from the proposal to the canonical node
      // unchanged. Validation already ensured the field is YYYY-MM-DD or null,
      // and the user can edit it post-accept via chat or the form.
      const targetDate = (proposal.proposed_target_date as string | null) ?? null;

      // Auto-complete marker — the entries route sets source_span to
      // `[[AUTO_COMPLETE]]` for proposals the AI flagged as "user
      // already did this." The node lands in the graph with status =
      // completed so it never shows up in active task lists. The
      // source_span text is replaced with null so it doesn't pollute
      // the node's provenance.
      const autoComplete = proposal.source_span === "[[AUTO_COMPLETE]]";

      return [{
        edits: action.edits,
        proposal,
        // The same row chat's tools write (lib/graph/node-intake.ts).
        nodeRow: newNodeRow({
          userId: user.id,
          workspaceId: proposal.workspace_id as string,
          title,
          nodeType,
          summary,
          body,
          targetDate,
          completed: autoComplete,
        }),
      }];
    });

    if (acceptedInputs.length > 0) {
      let { data: created, error: insertError } = await supabase
        .from("nodes")
        .insert(acceptedInputs.map((entry) => entry.nodeRow))
        .select();

      // Fallback if `body` column doesn't exist yet (migration not run on
      // this env). Strip body from each row and retry — the rest of the
      // flow stays functional, the user just doesn't see body content
      // until they run the migration.
      if (
        insertError &&
        /column.*body|"body".*does not exist/i.test(insertError.message ?? "")
      ) {
        const retry = await supabase
          .from("nodes")
          .insert(
            acceptedInputs.map((entry) => {
              const { body: _body, ...rest } = entry.nodeRow as Record<string, unknown>;
              return rest;
            }),
          )
          .select();
        created = retry.data;
        insertError = retry.error;
      }

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
        Array.from(new Set(acceptedPairs.map((pair) => pair.created.workspace_id))).map((wsId) =>
          embedNewNodes(
            { supabase, userId: user.id, workspaceId: wsId },
            acceptedPairs.filter((pair) => pair.created.workspace_id === wsId).map((pair) => pair.created),
          ),
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

      // ---------------------------------------------------------------------
      // Duplicate-merge re-parenting:
      //
      // When a proposed parent is rejected because it duplicates an existing
      // canonical node (UI auto-unchecks high-confidence duplicates), its
      // proposed children still carry a parent_local_ref pointing at it. If
      // we did nothing here, those children would create with no parent edge
      // — orphaned. Instead, register the canonical node id under the
      // rejected proposal's local_ref so downstream edge wiring (primary
      // parent + depends_on lookups) resolves to the canonical.
      // ---------------------------------------------------------------------
      const replacementCandidateIds = Array.from(
        new Set(
          actions
            .filter((a) => a.action === "reject" && typeof a.replaced_by_node_id === "string")
            .map((a) => a.replaced_by_node_id as string),
        ),
      );
      if (replacementCandidateIds.length > 0) {
        const { data: replacementRows } = await supabase
          .from("nodes")
          .select("id, title, workspace_id")
          .in("id", replacementCandidateIds)
          .eq("user_id", user.id);
        const replacementMap = new Map(
          (replacementRows ?? []).map((row) => [
            row.id as string,
            { id: row.id as string, title: row.title as string, workspace_id: row.workspace_id as string },
          ]),
        );
        for (const action of actions) {
          if (action.action !== "reject" || !action.replaced_by_node_id) continue;
          const proposal = proposalMap.get(action.id);
          if (!proposal?.local_ref) continue;
          const canonical = replacementMap.get(action.replaced_by_node_id);
          if (!canonical) continue;
          // Refuse to re-map across workspaces (defensive — never trust the client).
          if (canonical.workspace_id !== proposal.workspace_id) continue;
          // Don't clobber an actual acceptance under the same local_ref.
          if (acceptedByLocalRef.has(proposal.local_ref)) continue;
          acceptedByLocalRef.set(proposal.local_ref, {
            aiRunId: null,
            confidence: 0.85,
            nodeId: canonical.id,
            title: canonical.title,
          });
        }
      }

      // ---------------------------------------------------------------------
      // Cross-batch references:
      //
      // One dump's proposals can be accepted over more than one call — auto-
      // apply accepts the confident ones immediately and the rest are reviewed
      // later (and a user can always accept in steps). A child whose parent
      // (or dependency / link target) was accepted in an EARLIER call must
      // still wire up to it; before this, it was created with no parent edge.
      // local_refs are only unique within a dump, so lookups are per raw_entry.
      // ---------------------------------------------------------------------
      const missingRefsByEntry = new Map<string, Set<string>>();
      for (const { proposal } of acceptedPairs) {
        const rawEntryId = proposalMap.get(proposal.id)?.raw_entry_id as string | undefined;
        if (!rawEntryId) continue;
        const refs = [
          proposal.primary_parent_local_ref,
          ...(proposal.depends_on_local_refs ?? []),
          ...(proposal.soft_links ?? []).map((link) => link.target_local_ref),
        ];
        for (const ref of refs) {
          if (!ref || acceptedByLocalRef.has(ref)) continue;
          if (!missingRefsByEntry.has(rawEntryId)) missingRefsByEntry.set(rawEntryId, new Set());
          missingRefsByEntry.get(rawEntryId)!.add(ref);
        }
      }
      for (const [rawEntryId, refs] of missingRefsByEntry) {
        const { data: earlierAccepted } = await supabase
          .from("proposed_nodes")
          .select("local_ref, accepted_node_id, ai_run_id, extraction_confidence")
          .eq("raw_entry_id", rawEntryId)
          .eq("user_id", user.id)
          .eq("proposal_status", "accepted")
          .in("local_ref", [...refs])
          .not("accepted_node_id", "is", null);
        const earlierNodeIds = (earlierAccepted ?? []).map((row) => row.accepted_node_id as string);
        const { data: earlierNodes } = earlierNodeIds.length
          ? await supabase
              .from("nodes")
              .select("id, title, status")
              .in("id", earlierNodeIds)
              .eq("user_id", user.id)
          : { data: [] as Array<{ id: string; title: string; status: string | null }> };
        const liveTitleById = new Map(
          (earlierNodes ?? [])
            .filter((n) => n.status !== "archived")
            .map((n) => [n.id as string, n.title as string]),
        );
        for (const row of earlierAccepted ?? []) {
          const localRef = row.local_ref as string | null;
          const nodeId = row.accepted_node_id as string;
          const title = liveTitleById.get(nodeId);
          if (!localRef || !title || acceptedByLocalRef.has(localRef)) continue;
          acceptedByLocalRef.set(localRef, {
            aiRunId: (row.ai_run_id as string | null) ?? null,
            confidence: (row.extraction_confidence as number | null) ?? 0.75,
            nodeId,
            title,
          });
        }
      }

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
          // A proposal stored before the four link kinds may carry a retired name.
          const softKind = normalizeEdgeType(softLink.edge_type);
          queueEdge({
            ai_run_id: proposal.ai_run_id ?? target.aiRunId,
            confidence: Math.max(proposal.extraction_confidence ?? target.confidence ?? 0.68, 0.68),
            edge_type: softKind,
            explanation: buildSeededEdgeExplanation({
              edgeType: softKind,
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

        // Heal workspaces that never got a root — the bootstrap wizard is
        // skippable, and workspaces created before roots were seeded at
        // creation have none. Without this the nodes below are left orphaned
        // and clustering stays permanently disabled for that workspace.
        for (const workspaceId of workspaceIds) {
          if (rootByWorkspace.has(workspaceId)) continue;
          const healedRootId = await ensureWorkspaceRoot({
            supabase,
            userId: user.id,
            workspaceId,
          });
          if (healedRootId) rootByWorkspace.set(workspaceId, healedRootId);
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

  // Marked rejected in the same round trip as the feedback insert below.
  const rejectWrite =
    toReject.length > 0
      ? supabase
          .from("proposed_nodes")
          .update({ proposal_status: "rejected" })
          .in("id", toReject.map((a) => a.id))
          .eq("user_id", user.id)
      : null;

  if (toReject.length > 0) {
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
  await Promise.all([
    rejectWrite,
    feedbackRows.length > 0 ? supabase.from("feedback_events").insert(feedbackRows) : null,
  ]);

  let rescoredAcceptedNodes: Array<Record<string, unknown>> = acceptedNodes;

  // Retroactive clustering pass — runs AFTER acceptance so freshly-created
  // nodes (with embeddings now persisted) are eligible for grouping. Best-
  // effort; failures here don't block the response. Suggestions are
  // persisted to cluster_suggestions and surface either via the returned
  // payload (clients can show them in a dedicated review section) or on
  // the next /api/entries call. It reads nodes, edges and embeddings — never
  // scores — so it runs alongside the judgment → rescore chain below instead
  // of after it.
  const clusteringPass: Promise<Awaited<ReturnType<typeof runClusteringPass>>> =
    acceptedPairs.length > 0
      ? Promise.all(
          Array.from(new Set(acceptedPairs.map((pair) => pair.created.workspace_id))).map(
            (wsId) =>
              runClusteringPass({
                supabase,
                userId: user.id,
                workspaceId: wsId,
              }),
          ),
        )
          .then((passes) => passes.flat())
          .catch((err) => {
            console.error("[review] clustering pass failed", err);
            return [];
          })
      : Promise.resolve([]);

  // Phase 7 — recompute scores for the affected workspace and return fresh node rows.
  if (acceptedPairs.length > 0) {
    const workspaceId = acceptedPairs[0].created.workspace_id;

    // Per-node AI judgment for the newly accepted nodes, written BEFORE the
    // rescore so it feeds into it (shared with chat: lib/graph/node-intake.ts).
    await judgeAndRescore(
      { supabase, userId: user.id, workspaceId },
      acceptedPairs.map((pair) => pair.created),
    );

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

  const clusterSuggestions = await clusteringPass;

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
