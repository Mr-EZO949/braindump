// A brain dump as ONE turn (docs/unified-turn.md, phase 3).
//
// Until 2026-09-30 a dump's output went three ways: new nodes to a review
// modal (proposed_nodes), edits to a chat card, completions straight in. Now
// the builder's whole output is one change set:
//
//   builder → ops (builder-ops.ts) → policy (turn-policy.ts)
//           → applied now, with Undo   (applyChangeSet)
//           → the rest on ONE card     (parked by the route, applied on Accept)
//
// proposed_nodes stays as the LEDGER of what was proposed — one row per new
// node, accepted / rejected / pending — because three things read it: the
// auto-apply calibration (auto-apply.ts), Undo (/api/proposals/nodes/undo) and
// the dump history. So this needs no new table.

import type { SupabaseClient } from "@supabase/supabase-js";

import { applyChangeSet, type ChangeContext, type ChangeOp } from "@/lib/graph/change-set";
import type { DumpTurn } from "@/types/ai";

import { loadCalibrationStats, selectAutoApply } from "./auto-apply";
import { builderToOps } from "./builder-ops";
import { saveProposalRows, type BuilderSuccess } from "./extraction";
import { resolveRefs, splitByPolicy } from "./turn-policy";

const UUID = /^[0-9a-fA-F-]{36}$/;

export interface DumpChanges {
  // Applied already — what the card shows under "Added" / "Done" / "Linked".
  added: DumpTurn["added"];
  done: string[];
  links: DumpTurn["links"];
  // Waiting for the user: a change set that stands on its own.
  waiting: ChangeOp[];
  notes: string[];
}

function refsOf(op: ChangeOp): string[] {
  switch (op.kind) {
    case "create_node":
      return [op.parent_node_id ?? ""];
    case "move":
      return [op.node_id, op.new_parent_node_id ?? ""];
    case "create_edge":
      return [op.source_node_id, op.target_node_id];
    default:
      return [op.node_id];
  }
}

export async function applyDumpChanges(params: {
  ctx: ChangeContext;
  rawEntryId: string;
  built: BuilderSuccess;
  // Completions the priority read did not overrule ("did it, now waiting").
  completeExistingNodeIds: string[];
  // The user's "Auto-add confident items" preference.
  autoApply: boolean;
}): Promise<DumpChanges> {
  const { ctx, built } = params;
  const { supabase, userId, workspaceId } = ctx;

  // 1 · The ledger: one row per proposed node.
  const ledger = await saveProposalRows({
    supabase,
    rawEntryId: params.rawEntryId,
    workspaceId,
    userId,
    aiRunId: built.aiRunId,
    nodes: built.nodes,
  });
  if (!ledger.ok) console.warn("[dump-turn] ledger not saved — everything goes on the card:", ledger.error);
  const ledgerRows = ledger.ok ? ledger.rows : [];
  const ledgerIdByRef = new Map(ledgerRows.flatMap((row) => (row.local_ref ? [[row.local_ref, row.id] as const] : [])));

  // 2 · One change set.
  const ops = builderToOps({
    nodes: built.nodes,
    changes: built.changes,
    completeExistingNodeIds: params.completeExistingNodeIds,
    autoCompleteLocalRefs: built.autoCompleteLocalRefs,
  }).map((op): ChangeOp => {
    const ledgerId = op.kind === "create_node" && op.local_ref ? ledgerIdByRef.get(op.local_ref) : undefined;
    return ledgerId && op.kind === "create_node" ? { ...op, ledger_id: ledgerId } : op;
  });

  // 3 · Which new nodes this user reliably accepts (same rule as before).
  const autoRefs = new Set<string>();
  if (params.autoApply && ledgerRows.length > 0) {
    try {
      const held = new Set(
        built.possibleDuplicates.flatMap((dup) => {
          const id = ledgerIdByRef.get(dup.localRef);
          return id ? [id] : [];
        }),
      );
      const stats = await loadCalibrationStats(supabase, userId);
      const autoIds = new Set(
        selectAutoApply({
          proposals: ledgerRows.map((row) => ({
            id: row.id,
            local_ref: row.local_ref ?? null,
            primary_parent_local_ref: row.primary_parent_local_ref ?? null,
            existing_parent_node_id: row.existing_parent_node_id ?? null,
            proposed_node_type: row.proposed_node_type,
            extraction_confidence: row.extraction_confidence,
          })),
          heldIds: held,
          stats,
        }),
      );
      for (const row of ledgerRows) if (row.local_ref && autoIds.has(row.id)) autoRefs.add(row.local_ref);
    } catch (err) {
      console.warn("[dump-turn] auto-apply selection failed — everything goes on the card:", err);
    }
  }

  // 4 · Apply what is safe; the rest waits.
  const { now, ask } = splitByPolicy(ops, autoRefs);
  const outcome =
    now.length > 0 ? await applyChangeSet(ctx, now, { source: "dump" }) : { results: [], created: [] };

  const refToId = new Map<string, string>();
  const createdByIndex = new Map(outcome.created.map((node) => [node.index, node]));
  now.forEach((op, index) => {
    const node = createdByIndex.get(index);
    if (node && op.kind === "create_node" && op.local_ref) refToId.set(op.local_ref, node.id);
  });

  // Names for the card: every existing node an op mentions, in one read.
  const titleByRef = new Map<string, string>();
  for (const op of ops) if (op.kind === "create_node" && op.local_ref) titleByRef.set(op.local_ref, op.title);
  const existingIds = [...new Set(ops.flatMap(refsOf).filter((ref) => UUID.test(ref)))];
  if (existingIds.length > 0) {
    const { data } = await supabase
      .from("nodes")
      .select("id, title")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .in("id", existingIds);
    for (const row of (data ?? []) as Array<{ id: string; title: string }>) titleByRef.set(row.id, row.title);
  }
  const nameOf = (ref: string | undefined) => (ref ? (titleByRef.get(ref) ?? null) : null);

  const added: DumpChanges["added"] = [];
  const done: string[] = [];
  const links: DumpChanges["links"] = [];
  const acceptedLedger: Array<{ ledgerId: string; nodeId: string }> = [];
  now.forEach((op, index) => {
    const result = outcome.results[index];
    if (!result?.ok) {
      if (result) console.warn(`[dump-turn] ${op.kind} did not apply:`, result.error);
      return;
    }
    if (op.kind === "create_node") {
      const node = createdByIndex.get(index);
      if (!node) return;
      added.push({
        id: node.id,
        proposal_id: op.ledger_id ?? null,
        title: node.title,
        node_type: node.node_type,
        parent_title: nameOf(op.parent_local_ref ?? op.parent_node_id),
      });
      if (op.ledger_id) acceptedLedger.push({ ledgerId: op.ledger_id, nodeId: node.id });
    } else if (op.kind === "complete") {
      const title = nameOf(op.node_id);
      if (title) done.push(title);
    } else if (op.kind === "create_edge") {
      const source = nameOf(op.source_node_id);
      const target = nameOf(op.target_node_id);
      if (source && target) links.push({ source_title: source, target_title: target, edge_type: op.edge_type });
    }
  });
  await settleLedger({ supabase, userId, workspaceId }, { accepted: acceptedLedger, rejected: [] });

  const proposalTitleByRef = new Map(built.nodes.map((n) => [n.local_ref, n.proposed_title]));
  const waitingRefs = new Set(ask.flatMap((op) => (op.kind === "create_node" && op.local_ref ? [op.local_ref] : [])));
  const notes = built.possibleDuplicates
    .filter((dup) => waitingRefs.has(dup.localRef))
    .map((dup) => `"${proposalTitleByRef.get(dup.localRef) ?? "A new item"}" looks like your existing "${dup.existingTitle}".`);

  return { added, done, links, waiting: resolveRefs(ask, refToId), notes };
}

// Records what became of proposed nodes: accepted ones point at the node they
// became (Undo finds it there), rejected ones teach the calibration.
export async function settleLedger(
  scope: { supabase: SupabaseClient; userId: string; workspaceId: string },
  decided: { accepted: Array<{ ledgerId: string; nodeId: string }>; rejected: string[] },
): Promise<void> {
  const { supabase, userId, workspaceId } = scope;
  if (decided.accepted.length === 0 && decided.rejected.length === 0) return;
  try {
    await Promise.all([
      // A skipped proposal is a review decision like any other (the accept
      // events are written where the node is created, in applyChangeSet).
      decided.rejected.length > 0
        ? supabase.from("feedback_events").insert(
            decided.rejected.map((id) => ({
              user_id: userId,
              workspace_id: workspaceId,
              event_type: "reject_node",
              entity_type: "proposed_node",
              entity_id: id,
              metadata: { source: "dump" },
            })),
          )
        : null,
      ...decided.accepted.map(({ ledgerId, nodeId }) =>
        supabase
          .from("proposed_nodes")
          .update({ proposal_status: "accepted", accepted_node_id: nodeId })
          .eq("id", ledgerId)
          .eq("user_id", userId),
      ),
      decided.rejected.length > 0
        ? supabase
            .from("proposed_nodes")
            .update({ proposal_status: "rejected" })
            .in("id", decided.rejected)
            .eq("user_id", userId)
            .eq("proposal_status", "pending_review")
        : null,
    ]);
  } catch (err) {
    console.warn("[dump-turn] ledger update failed:", err instanceof Error ? err.message : err);
  }
}

// What the user decided on a dump's card, written back to the ledger: the new
// nodes that were created, and the proposed ones the user left out.
export async function settleCardLedger(
  scope: { supabase: SupabaseClient; userId: string; workspaceId: string },
  params: {
    // Every op that was on the card.
    offered: ChangeOp[];
    // The ops that were applied, with their results (same order).
    applied: ChangeOp[];
    results: Array<{ ok: boolean; id?: string }>;
  },
): Promise<void> {
  const accepted: Array<{ ledgerId: string; nodeId: string }> = [];
  params.applied.forEach((op, index) => {
    const result = params.results[index];
    if (op.kind === "create_node" && op.ledger_id && result?.ok && result.id) {
      accepted.push({ ledgerId: op.ledger_id, nodeId: result.id });
    }
  });
  const acceptedIds = new Set(accepted.map((a) => a.ledgerId));
  const rejected = params.offered.flatMap((op) =>
    op.kind === "create_node" && op.ledger_id && !acceptedIds.has(op.ledger_id) ? [op.ledger_id] : [],
  );
  await settleLedger(scope, { accepted, rejected });
}
