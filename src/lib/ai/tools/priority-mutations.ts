// update_priorities — chat → ranking (docs/ranking.md, "Chat → priorities").
//
// What the user says that changes WHAT MATTERS, not what exists: done,
// waiting on a result, a moved deadline, stakes, "focus on X this week",
// "X can wait", dropped. One Accept-gated card for all of it; on Accept the
// changes apply in order, scores recompute once, and the reply names what
// went up and down (the graph refresh resizes the nodes).

import { computeWorkspaceScores } from "@/lib/ai/scoring";
import {
  describePriorityChange,
  parsePriorityChanges,
  PRIORITY_ACTIONS,
  type PriorityChange,
} from "@/lib/graph/priority-changes";
import { stakesValue } from "@/lib/graph/priority-signals";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { localDateISO } from "@/lib/time/local-date";
import type { NodeStatus } from "@/types/graph";
import type { ToolContext, ToolDefinition } from "./read-only";

type NodeState = {
  id: string;
  title: string;
  status: string | null;
  current_importance_score: number | null;
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
      "Change what matters about EXISTING nodes — their status, deadline, stakes or focus — from what the user says. One card for all changes; requires Accept. Actions: complete (finished it) · wait (did their part, now waiting on a result/reply/decision: 'took the exam, waiting for results' — NOT complete; its open steps leave Focus) · resume (the wait is over / picking it back up) · deadline (set, move or clear target_date) · stakes (high: a lot rides on it — 'I need it for my masters'; low: 'it's pass/fail') · focus ('focus on X this week', 'X first' — fades over ~2 weeks) · deprioritize ('X can wait') · drop (cancelled, not doing it). Pass each node's exact title. Not for creating nodes.",
    input_schema: {
      type: "object",
      properties: {
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
              reason: { type: "string", description: "Optional: the user's reason in a few words" },
            },
            required: ["node_id", "title", "action"],
          },
        },
      },
      required: ["changes"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const parsed = parsePriorityChanges(input);
    if (!parsed.ok) return { accepted: false, error: parsed.error };
    const { changes } = parsed;

    const ids = [...new Set(changes.map((c) => c.node_id))];
    const { data: rows } = await ctx.supabase
      .from("nodes")
      .select("id, title, status, current_importance_score")
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .in("id", ids);
    const nodes = new Map(((rows ?? []) as NodeState[]).map((n) => [n.id, n]));

    const outcomes: Outcome[] = [];
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

    const lines = applied.map((o) => {
      const before = nodes.get(o.change.node_id)?.current_importance_score ?? null;
      return describePriorityChange(o.change) + arrow(before, after.get(o.change.node_id) ?? null);
    });
    const failed = outcomes.filter((o) => !o.ok);

    if (applied.length === 0) {
      return {
        accepted: false,
        error: failed.map((o) => `${o.change.title}: ${o.error}`).join("; ") || "nothing applied",
      };
    }
    return {
      accepted: true,
      applied: applied.map((o) => ({
        node_id: o.change.node_id,
        title: o.change.title,
        action: o.change.action,
        score_before: nodes.get(o.change.node_id)?.current_importance_score ?? null,
        score_after: after.get(o.change.node_id) ?? null,
      })),
      failed: failed.map((o) => ({ title: o.change.title, action: o.change.action, error: o.error })),
      message:
        `Updated ✓ ${lines.join(" · ")}` +
        (failed.length > 0 ? ` (couldn't: ${failed.map((o) => describePriorityChange(o.change)).join(", ")})` : ""),
    };
  },
};

export const PRIORITY_MUTATION_TOOLS: ToolDefinition[] = [UPDATE_PRIORITIES];
