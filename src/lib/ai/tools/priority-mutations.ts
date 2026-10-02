// update_priorities — chat → ranking (docs/ranking.md, "Chat → priorities").
//
// What the user says that changes WHAT MATTERS, not what exists: done,
// waiting on a result, a moved deadline, stakes, "focus on X this week",
// "X can wait", dropped. It is a DIRECT tool: it applies as soon as the model
// calls it (no Accept card) — the changes apply in order, scores recompute
// once, and the chat shows what went up and down with an Undo. The result
// carries an undo snapshot of exactly the fields it touched;
// undoPriorityChanges() restores them.

import { computeWorkspaceScores } from "@/lib/ai/scoring";
import {
  describePriorityChange,
  describePriorityDetail,
  parsePriorityChanges,
  PRIORITY_ACTIONS,
  type PriorityChange,
  type PriorityNodeBefore,
  type PriorityUndo,
} from "@/lib/graph/priority-changes";
import { stakesValue } from "@/lib/graph/priority-signals";
import { transitionNodeStatus, VALID_TRANSITIONS } from "@/lib/graph/status-transition";
import { localDateISO } from "@/lib/time/local-date";
import type { NodeStatus } from "@/types/graph";
import type { ToolContext, ToolDefinition } from "./read-only";

type NodeState = {
  id: string;
  title: string;
  status: string | null;
  current_importance_score: number | null;
  stakes: number | null;
  target_date: string | null;
  waiting_for: string | null;
  resume_on: string | null;
};

type Outcome = { change: PriorityChange; ok: boolean; error?: string };

async function logFeedback(
  ctx: ToolContext,
  nodeId: string,
  eventType: string,
  metadata: Record<string, unknown>,
) {
  // Best-effort, like every feedback write: a missing enum value (migration
  // not applied yet) must not fail the user's change.
  await ctx.supabase
    .from("feedback_events")
    .insert({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      event_type: eventType,
      entity_type: "node",
      entity_id: nodeId,
      metadata: { source: "chat", ...metadata },
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

async function transition(ctx: ToolContext, nodeId: string, status: NodeStatus): Promise<string | null> {
  const result = await transitionNodeStatus({
    supabase: ctx.supabase,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    nodeId,
    newStatus: status,
    today: ctx.today ?? localDateISO(new Date(), null),
    habitSource: "chat",
    recomputeScores: false,
  });
  return result.kind === "error" ? result.error : null;
}

async function patchNode(ctx: ToolContext, nodeId: string, patch: Record<string, unknown>) {
  const { error } = await ctx.supabase
    .from("nodes")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", nodeId)
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId);
  return error ? error.message : null;
}

// The fields a change is about to touch, as they are now — merged per node
// into the undo snapshot (first write wins: that's the original value).
function beforeFields(change: PriorityChange, node: NodeState): Omit<PriorityNodeBefore, "node_id"> {
  switch (change.action) {
    case "stakes":
      return { stakes: node.stakes };
    case "deadline":
      return { target_date: node.target_date };
    case "wait":
    case "resume":
    case "complete":
    case "drop":
      return {
        status: (node.status ?? "active") as PriorityNodeBefore["status"],
        waiting_for: node.waiting_for,
        resume_on: node.resume_on,
      };
    default:
      return {};
  }
}

async function applyChange(ctx: ToolContext, change: PriorityChange, node: NodeState): Promise<string | null> {
  const status = (node.status ?? "active") as NodeStatus;
  switch (change.action) {
    case "focus":
    case "deprioritize": {
      // Steering: a decaying boost/demote event (priority-signals.ts). This
      // row IS the signal, so unlike the audit events its failure counts.
      const { error } = await ctx.supabase.from("feedback_events").insert({
        user_id: ctx.userId,
        workspace_id: ctx.workspaceId,
        event_type: change.action === "focus" ? "boost_node" : "demote_node",
        entity_type: "node",
        entity_id: node.id,
        metadata: { source: "chat", reason: change.reason ?? null },
      });
      return error ? error.message : null;
    }
    case "stakes": {
      const error = await patchNode(ctx, node.id, { stakes: stakesValue(change.stakes) });
      if (!error) await logFeedback(ctx, node.id, "set_stakes", { stakes: change.stakes, reason: change.reason ?? null });
      return error;
    }
    case "deadline": {
      const error = await patchNode(ctx, node.id, { target_date: change.target_date });
      if (!error) await logFeedback(ctx, node.id, "set_deadline", { target_date: change.target_date });
      return error;
    }
    case "wait": {
      if (status === "completed" || status === "archived") return `"${node.title}" is already ${status}`;
      if (status !== "paused") {
        const error = await transition(ctx, node.id, "paused");
        if (error) return error;
      }
      return patchNode(ctx, node.id, { waiting_for: change.waiting_for, resume_on: change.check_back_on });
    }
    case "resume":
      return status === "active" ? null : transition(ctx, node.id, "active");
    case "complete":
      // paused → completed is allowed ("waiting for the result" → "passed").
      return transition(ctx, node.id, "completed");
    case "drop":
      return transition(ctx, node.id, "archived");
  }
}

function arrow(before: number | null, after: number | null): string {
  if (before === null || after === null) return "";
  if (after > before + 1) return " ↑";
  if (after < before - 1) return " ↓";
  return "";
}

export const UPDATE_PRIORITIES: ToolDefinition = {
  schema: {
    name: "update_priorities",
    description:
      "Change what matters about EXISTING nodes — their status, deadline, stakes or focus — from what the user says. All changes in one call; source \"user\" applies immediately (the user sees what moved, with an Undo), source \"suggestion\" (your own advice) waits on a card for their OK. Actions: complete (finished it) · wait (did their part, now waiting on a result/reply/decision: 'took the exam, waiting for results' — NOT complete; its open steps leave Focus) · resume (the wait is over / picking it back up) · deadline (set, move or clear target_date) · stakes (high: a lot rides on it — 'I need it for my masters'; low: 'it's pass/fail') · focus ('focus on X this week', 'X first' — fades over ~2 weeks) · deprioritize ('X can wait') · drop (cancelled, not doing it). Pass each node's exact title. Not for creating nodes.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["user", "suggestion"],
          description:
            "user = the user said it (\"focus on stats this week\", \"took the exam, waiting on results\") — applies at once with Undo. suggestion = YOUR recommendation the user hasn't agreed to (they asked what to prioritize, you advise) — waits on a card for their OK.",
        },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              node_id: { type: "string", description: "UUID of an existing node" },
              title: { type: "string", description: "The node's exact title (shown on the card)" },
              action: { type: "string", enum: [...PRIORITY_ACTIONS] },
              stakes: { type: "string", enum: ["high", "normal", "low"], description: "action=stakes only" },
              waiting_for: {
                type: "string",
                description: "action=wait only: what they're waiting on, a few words ('exam result', 'Anna's reply')",
              },
              check_back_on: {
                type: "string",
                description: "action=wait only: YYYY-MM-DD when to check back, if the user said or implied when",
              },
              target_date: {
                type: "string",
                description: "action=deadline only: YYYY-MM-DD, or empty string to clear",
              },
              date_words: {
                type: "string",
                description:
                  "action=deadline or wait: the user's own words for that date, copied verbatim ('this friday', 'next tuesday', 'in 2 weeks', 'oct 20'). Always fill it when they named a day — the server resolves it exactly.",
              },
              reason: { type: "string", description: "Optional: the user's reason in a few words" },
            },
            required: ["node_id", "title", "action"],
          },
        },
      },
      required: ["source", "changes"],
    },
  },
  handler: (input, ctx: ToolContext) => applyPriorityChanges(ctx, input),
};

export async function applyPriorityChanges(ctx: ToolContext, input: unknown) {
  const parsed = parsePriorityChanges(input, { today: ctx.today ?? localDateISO(new Date(), null) });
  if (!parsed.ok) return { accepted: false, error: parsed.error };
  const { changes } = parsed;

  const ids = [...new Set(changes.map((c) => c.node_id))];
  const { data: rows } = await ctx.supabase
    .from("nodes")
    .select("id, title, status, current_importance_score, stakes, target_date, waiting_for, resume_on")
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .in("id", ids);
  const nodes = new Map(((rows ?? []) as NodeState[]).map((n) => [n.id, n]));

  const outcomes: Outcome[] = [];
  const before = new Map<string, PriorityNodeBefore>();
  const steer: PriorityUndo["steer"] = [];
  for (const change of changes) {
    const node = nodes.get(change.node_id);
    if (!node) {
      outcomes.push({ change, ok: false, error: "node not found in this workspace" });
      continue;
    }
    // Titles on the card come from the model; the reply uses the real one.
    const named = { ...change, title: node.title } as PriorityChange;
    const error = await applyChange(ctx, named, node);
    outcomes.push({ change: named, ok: !error, ...(error ? { error } : {}) });
    if (error) continue;
    const fields = beforeFields(named, node);
    if (Object.keys(fields).length > 0) {
      before.set(node.id, { ...fields, ...before.get(node.id), node_id: node.id });
    }
    if (named.action === "focus" || named.action === "deprioritize") {
      steer.push({ node_id: node.id, event_type: named.action === "focus" ? "boost_node" : "demote_node" });
    }
  }

  const applied = outcomes.filter((o) => o.ok);
  let after = new Map<string, number>();
  if (applied.length > 0) {
    const { nodeUpdates } = await computeWorkspaceScores({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      supabase: ctx.supabase,
      today: ctx.today,
    });
    after = new Map(nodeUpdates.map((u) => [u.id, u.current_importance_score]));
  }

  const scoreBefore = (id: string) => nodes.get(id)?.current_importance_score ?? null;
  // nodeUpdates only lists nodes whose score moved; unchanged means "same".
  const scoreAfter = (id: string) => after.get(id) ?? scoreBefore(id);
  const lines = applied.map(
    (o) => describePriorityChange(o.change) + arrow(scoreBefore(o.change.node_id), scoreAfter(o.change.node_id)),
  );
  const failed = outcomes.filter((o) => !o.ok);

  if (applied.length === 0) {
    return {
      accepted: false,
      error: failed.map((o) => `${o.change.title}: ${o.error}`).join("; ") || "nothing applied",
    };
  }
  const undo: PriorityUndo = { nodes: [...before.values()], steer };
  return {
    accepted: true,
    applied: applied.map((o) => ({
      node_id: o.change.node_id,
      title: o.change.title,
      action: o.change.action,
      detail: describePriorityDetail(o.change),
      score_before: scoreBefore(o.change.node_id),
      score_after: scoreAfter(o.change.node_id),
    })),
    failed: failed.map((o) => ({ title: o.change.title, action: o.change.action, error: o.error ?? "failed" })),
    message:
      `Updated ✓ ${lines.join(" · ")}` +
      (failed.length > 0 ? ` (couldn't: ${failed.map((o) => describePriorityChange(o.change)).join(", ")})` : ""),
    undo,
  };
}

// Status back to what it was. Transitions run through the one status engine
// (reopen cascades, unarchive restores edges); completed → paused has no
// direct edge, so it goes through active.
async function restoreStatus(ctx: ToolContext, nodeId: string, from: string, to: NodeStatus): Promise<string | null> {
  if (from === to) return null;
  const path: NodeStatus[] =
    (VALID_TRANSITIONS[from as NodeStatus] ?? []).includes(to) ? [to] : ["active", to];
  for (const step of path) {
    const error = await transition(ctx, nodeId, step);
    if (error) return error;
  }
  return null;
}

/** Puts back exactly what applyPriorityChanges changed (see PriorityUndo). */
export async function undoPriorityChanges(ctx: ToolContext, undo: PriorityUndo) {
  const ids = undo.nodes.map((n) => n.node_id);
  const { data: rows } = ids.length
    ? await ctx.supabase
        .from("nodes")
        .select("id, title, status")
        .eq("user_id", ctx.userId)
        .eq("workspace_id", ctx.workspaceId)
        .in("id", ids)
    : { data: [] };
  const current = new Map(((rows ?? []) as { id: string; title: string; status: string | null }[]).map((n) => [n.id, n]));

  const errors: string[] = [];
  for (const before of undo.nodes) {
    const node = current.get(before.node_id);
    if (!node) {
      errors.push("a node is gone");
      continue;
    }
    if (before.status) {
      const error = await restoreStatus(ctx, node.id, node.status ?? "active", before.status);
      if (error) {
        errors.push(`${node.title}: ${error}`);
        continue;
      }
    }
    const patch: Record<string, unknown> = {};
    for (const key of ["waiting_for", "resume_on", "stakes", "target_date"] as const) {
      if (key in before) patch[key] = before[key];
    }
    // Leaving paused clears the waiting fields; only a paused node gets them back.
    if (before.status && before.status !== "paused") {
      delete patch.waiting_for;
      delete patch.resume_on;
    }
    if (Object.keys(patch).length > 0) {
      const error = await patchNode(ctx, node.id, patch);
      if (error) errors.push(`${node.title}: ${error}`);
    }
  }

  // feedback_events is append-only: cancel a focus with a matching "can wait"
  // (and vice versa). Both decay at the same rate, so they net to zero.
  for (const event of undo.steer) {
    const { error } = await ctx.supabase.from("feedback_events").insert({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      event_type: event.event_type === "boost_node" ? "demote_node" : "boost_node",
      entity_type: "node",
      entity_id: event.node_id,
      metadata: { source: "undo" },
    });
    if (error) errors.push(error.message);
  }

  await computeWorkspaceScores({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    supabase: ctx.supabase,
    today: ctx.today,
  });

  return errors.length > 0 ? { ok: false as const, error: errors.join("; ") } : { ok: true as const };
}

export const PRIORITY_MUTATION_TOOLS: ToolDefinition[] = [UPDATE_PRIORITIES];
