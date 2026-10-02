// Undo for a change set (docs/unified-turn.md). applyChangeSet records, for
// every op it applied, the one step that puts it back; the card keeps those
// steps and sends them to POST /api/changes/undo when the user taps Undo.
// The same steps serve what a turn applied at once (a dump's or a chat
// message's new nodes, things marked done, links) and what the user accepted
// on a card later (moves, renames, archives).
//
// The steps come back from the browser, so they are validated here
// (parseUndoSteps) and only ever touch this user's rows in this workspace.
// A permanent delete and a merge have no step: the card says so before Accept.

import type { ChangeContext } from "@/lib/graph/change-set";
import { changeNodeStatus } from "@/lib/graph/change-set";
import { setNodeParent } from "@/lib/graph/hierarchy";
import { VALID_TRANSITIONS } from "@/lib/graph/status-transition";
import type { NodeStatus } from "@/types/graph";

export type UndoStep =
  // A node the set created: removed again (its edges go with it).
  | { kind: "remove_node"; node_id: string; ledger_id?: string }
  // A status the set changed (done, archived): put back, with the nodes the
  // completion closed along with it.
  | { kind: "restore_status"; node_id: string; status: NodeStatus; also?: string[] }
  // A habit "done today": the day's check-in removed.
  | { kind: "unlog_habit"; node_id: string; date: string }
  // A link the set added.
  | { kind: "remove_edge"; edge_id: string }
  // A link the set removed.
  | {
      kind: "restore_edge";
      source_node_id: string;
      target_node_id: string;
      edge_type: string;
      explanation: string | null;
    }
  // A move: back under the old parent (none → no parent again).
  | { kind: "restore_parent"; node_id: string; parent_id: string | null }
  // A rename / retype / new summary or date: the old values.
  | { kind: "restore_fields"; node_id: string; fields: RestorableFields };

export interface RestorableFields {
  title?: string;
  summary?: string | null;
  node_type?: string;
  target_date?: string | null;
  body?: string | null;
}

// A row id: a UUID in the database; any short id-shaped string is let
// through (every query is scoped to this user and workspace anyway).
const ID = /^[\w-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: ReadonlySet<string> = new Set(["active", "completed", "paused", "archived"]);
const MAX_STEPS = 200;

const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const optText = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value.slice(0, 2000) : undefined;

function parseFields(raw: unknown): RestorableFields | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fields: RestorableFields = {};
  if (typeof r.title === "string" && r.title.trim()) fields.title = r.title.trim().slice(0, 120);
  const summary = optText(r.summary);
  if (summary !== undefined) fields.summary = summary;
  if (typeof r.node_type === "string" && r.node_type) fields.node_type = r.node_type;
  if (r.target_date === null || (typeof r.target_date === "string" && ISO_DATE.test(r.target_date))) {
    fields.target_date = r.target_date as string | null;
  }
  const body = optText(r.body);
  if (body !== undefined) fields.body = body === null ? null : body.slice(0, 400);
  return Object.keys(fields).length > 0 ? fields : null;
}

function parseStep(raw: unknown): UndoStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "remove_node":
      return isId(r.node_id)
        ? { kind: "remove_node", node_id: r.node_id, ...(isId(r.ledger_id) ? { ledger_id: r.ledger_id } : {}) }
        : null;
    case "restore_status": {
      if (!isId(r.node_id) || typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
      const also = Array.isArray(r.also) ? r.also.filter(isId).slice(0, MAX_STEPS) : [];
      return { kind: "restore_status", node_id: r.node_id, status: r.status as NodeStatus, ...(also.length ? { also } : {}) };
    }
    case "unlog_habit":
      return isId(r.node_id) && typeof r.date === "string" && ISO_DATE.test(r.date)
        ? { kind: "unlog_habit", node_id: r.node_id, date: r.date }
        : null;
    case "remove_edge":
      return isId(r.edge_id) ? { kind: "remove_edge", edge_id: r.edge_id } : null;
    case "restore_edge":
      return isId(r.source_node_id) && isId(r.target_node_id) && typeof r.edge_type === "string" && r.edge_type
        ? {
            kind: "restore_edge",
            source_node_id: r.source_node_id,
            target_node_id: r.target_node_id,
            edge_type: r.edge_type,
            explanation: typeof r.explanation === "string" ? r.explanation.slice(0, 1000) : null,
          }
        : null;
    case "restore_parent":
      return isId(r.node_id) && (r.parent_id === null || isId(r.parent_id))
        ? { kind: "restore_parent", node_id: r.node_id, parent_id: r.parent_id as string | null }
        : null;
    case "restore_fields": {
      const fields = parseFields(r.fields);
      return isId(r.node_id) && fields ? { kind: "restore_fields", node_id: r.node_id, fields } : null;
    }
    default:
      return null;
  }
}

// Steps as the browser sent them → the ones that are well-formed. Anything
// malformed is dropped, never guessed at.
export function parseUndoSteps(raw: unknown): UndoStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STEPS).flatMap((step) => {
    const parsed = parseStep(step);
    return parsed ? [parsed] : [];
  });
}

// completed → paused is not a transition; go through active.
async function restoreStatus(ctx: ChangeContext, nodeId: string, to: NodeStatus): Promise<string | null> {
  const { data } = await ctx.supabase
    .from("nodes")
    .select("status")
    .eq("id", nodeId)
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  if (!data) return "node not found";
  const from = ((data.status as NodeStatus | null) ?? "active") as NodeStatus;
  if (from === to) return null;
  const path: NodeStatus[] = (VALID_TRANSITIONS[from] ?? []).includes(to) ? [to] : ["active", to];
  for (const status of path) {
    const outcome = await changeNodeStatus(ctx, nodeId, status, { recomputeScores: false });
    if (outcome.kind === "error") return outcome.error;
  }
  return null;
}

async function runStep(ctx: ChangeContext, step: UndoStep): Promise<string | null> {
  const { supabase, userId, workspaceId } = ctx;
  switch (step.kind) {
    case "remove_node": {
      const { error } = await supabase
        .from("nodes")
        .delete()
        .eq("id", step.node_id)
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId);
      if (error) return error.message;
      if (step.ledger_id) {
        // Undo is a real "no" — it teaches the auto-apply calibration.
        await supabase
          .from("proposed_nodes")
          .update({ proposal_status: "rejected", accepted_node_id: null })
          .eq("id", step.ledger_id)
          .eq("user_id", userId);
      }
      return null;
    }
    case "restore_status": {
      const error = await restoreStatus(ctx, step.node_id, step.status);
      if (error) return error;
      // What the completion closed along with it opens again.
      for (const id of step.also ?? []) await restoreStatus(ctx, id, "active");
      return null;
    }
    case "unlog_habit": {
      const { error } = await supabase
        .from("habit_completions")
        .delete()
        .eq("node_id", step.node_id)
        .eq("user_id", userId)
        .eq("completed_on", step.date);
      return error?.message ?? null;
    }
    case "remove_edge": {
      const { error } = await supabase
        .from("edges")
        .delete()
        .eq("id", step.edge_id)
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId);
      return error?.message ?? null;
    }
    case "restore_edge": {
      const { data: pair } = await supabase
        .from("nodes")
        .select("id")
        .in("id", [step.source_node_id, step.target_node_id])
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId);
      if (!pair || pair.length < 2) return "one of the linked nodes is gone";
      const { error } = await supabase.from("edges").insert({
        user_id: userId,
        workspace_id: workspaceId,
        source_node_id: step.source_node_id,
        target_node_id: step.target_node_id,
        edge_type: step.edge_type,
        status: "active",
        explanation: step.explanation,
        user_confirmed: true,
      });
      return error?.message ?? null;
    }
    case "restore_parent": {
      if (step.parent_id) {
        const moved = await setNodeParent({
          supabase,
          userId,
          workspaceId,
          nodeId: step.node_id,
          parentId: step.parent_id,
        });
        return moved.ok ? null : moved.error;
      }
      const { error } = await supabase
        .from("edges")
        .update({ status: "orphaned", updated_at: new Date().toISOString() })
        .eq("source_node_id", step.node_id)
        .eq("edge_type", "belongs_to")
        .eq("status", "active")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId);
      return error?.message ?? null;
    }
    case "restore_fields": {
      const { error } = await supabase
        .from("nodes")
        .update({ ...step.fields, updated_at: new Date().toISOString() })
        .eq("id", step.node_id)
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId);
      return error?.message ?? null;
    }
  }
}

// Runs the steps last-first (a set is undone in the reverse of the order it
// was applied). A failed step never stops the rest; the caller rescores once.
export async function undoChangeSteps(
  ctx: ChangeContext,
  steps: UndoStep[],
): Promise<{ undone: number; failed: string[] }> {
  let undone = 0;
  const failed: string[] = [];
  for (const step of [...steps].reverse()) {
    const error = await runStep(ctx, step);
    if (error) failed.push(`${step.kind}: ${error}`);
    else undone += 1;
  }
  return { undone, failed };
}
