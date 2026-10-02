// set_commitments — chat/dump → fixed commitments (docs/commitments.md).
//
// "Stats every weekday at 2pm until Dec 20" becomes a weekly row that Focus,
// What Now and the planner read as busy time. A DIRECT tool like
// update_priorities: it applies as soon as the model calls it, the chat shows
// a card with an Undo, and the result carries the undo snapshot
// (undoCommitmentChanges puts it back).

import {
  COMMITMENT_SELECT,
  describeCommitment,
  loadActiveCommitments,
  normalizeCommitment,
  type Commitment,
} from "@/lib/planner/commitments";
import {
  parseCommitmentChanges,
  type CommitmentChange,
  type CommitmentFields,
  type CommitmentUndo,
} from "@/lib/planner/commitment-changes";
import { localDateISO } from "@/lib/time/local-date";
import type { ToolContext, ToolDefinition } from "./read-only";

type Source = "chat" | "dump";

type Outcome =
  | { ok: true; action: CommitmentChange["action"]; commitment: Commitment }
  | { ok: false; action: CommitmentChange["action"]; title: string; error: string };

function toRow(fields: Partial<CommitmentFields>) {
  return { ...fields, updated_at: new Date().toISOString() };
}

// A link must point at one of the user's nodes in this workspace; anything
// else is dropped (the commitment still counts as busy time).
async function ownedNodes(ctx: ToolContext, ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; target_date: string | null }>();
  const { data } = await ctx.supabase
    .from("nodes")
    .select("id, target_date")
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .in("id", ids);
  return new Map(((data ?? []) as { id: string; target_date: string | null }[]).map((n) => [n.id, n]));
}

async function applyOne(
  ctx: ToolContext,
  change: CommitmentChange,
  existing: Map<string, Commitment>,
  source: Source,
): Promise<Outcome> {
  if (change.action === "add") {
    const { data, error } = await ctx.supabase
      .from("commitments")
      .insert({ ...toRow(change.fields), user_id: ctx.userId, workspace_id: ctx.workspaceId, source })
      .select(COMMITMENT_SELECT)
      .single();
    const commitment = data ? normalizeCommitment(data as Record<string, unknown>) : null;
    return commitment
      ? { ok: true, action: "add", commitment }
      : { ok: false, action: "add", title: change.fields.title, error: error?.message ?? "not saved" };
  }

  const current = existing.get(change.commitment_id)!;
  if (change.action === "remove") {
    const { error } = await ctx.supabase
      .from("commitments")
      .delete()
      .eq("id", current.id)
      .eq("user_id", ctx.userId);
    return error
      ? { ok: false, action: "remove", title: current.title, error: error.message }
      : { ok: true, action: "remove", commitment: current };
  }

  const { data, error } = await ctx.supabase
    .from("commitments")
    .update(toRow(change.patch))
    .eq("id", current.id)
    .eq("user_id", ctx.userId)
    .select(COMMITMENT_SELECT)
    .single();
  const commitment = data ? normalizeCommitment(data as Record<string, unknown>) : null;
  return commitment
    ? { ok: true, action: "update", commitment }
    : { ok: false, action: "update", title: current.title, error: error?.message ?? "not saved" };
}

export async function applyCommitmentChanges(ctx: ToolContext, input: unknown, source: Source = "chat") {
  const today = ctx.today ?? localDateISO(new Date(), null);
  const existing = await loadActiveCommitments(ctx.supabase, ctx.userId, today);
  const parsed = parseCommitmentChanges(input, { today, existing });
  if (!parsed.ok) return { accepted: false, error: parsed.error };

  // Links: keep only the user's own nodes. A class node's end date doubles as
  // the commitment's when the user didn't say one.
  const linkIds = parsed.changes.flatMap((c) =>
    c.action === "add" && c.fields.node_id
      ? [c.fields.node_id]
      : c.action === "update" && c.patch.node_id
        ? [c.patch.node_id]
        : [],
  );
  const nodes = await ownedNodes(ctx, [...new Set(linkIds)]);
  const changes = parsed.changes.map((change): CommitmentChange => {
    if (change.action === "add" && change.fields.node_id) {
      const node = nodes.get(change.fields.node_id);
      const endsOn =
        change.fields.ends_on ?? (node?.target_date && node.target_date >= today ? node.target_date : null);
      return { ...change, fields: { ...change.fields, node_id: node ? node.id : null, ends_on: endsOn } };
    }
    if (change.action === "update" && change.patch.node_id && !nodes.has(change.patch.node_id)) {
      const patch = { ...change.patch };
      delete patch.node_id;
      return { ...change, patch };
    }
    return change;
  });

  const byId = new Map(existing.map((c) => [c.id, c]));
  const outcomes: Outcome[] = [];
  for (const change of changes) outcomes.push(await applyOne(ctx, change, byId, source));

  const applied = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok);
  const failed = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
  if (applied.length === 0) {
    return { accepted: false, error: failed.map((o) => `${o.title}: ${o.error}`).join("; ") || "nothing applied" };
  }

  const undo: CommitmentUndo = {
    created: applied.filter((o) => o.action === "add").map((o) => o.commitment.id),
    before: applied.filter((o) => o.action !== "add").map((o) => byId.get(o.commitment.id)!),
  };
  const detail = (o: Extract<Outcome, { ok: true }>) =>
    o.action === "remove" ? "Removed" : describeCommitment(o.commitment, today);
  return {
    accepted: true,
    applied: applied.map((o) => ({
      // The card keys (and pulses) by node; an unlinked commitment uses its own id.
      node_id: o.commitment.node_id ?? o.commitment.id,
      title: o.commitment.title,
      action: o.action,
      detail: detail(o),
      score_before: null,
      score_after: null,
    })),
    failed: failed.map((o) => ({ title: o.title, action: o.action, error: o.error })),
    message:
      `Saved ✓ ${applied.map((o) => `${o.commitment.title}: ${detail(o)}`).join(" · ")}` +
      (failed.length > 0 ? ` (couldn't: ${failed.map((o) => o.title).join(", ")})` : ""),
    undo,
  };
}

/** Puts back exactly what applyCommitmentChanges changed. */
export async function undoCommitmentChanges(ctx: ToolContext, undo: CommitmentUndo) {
  const errors: string[] = [];
  if (undo.created.length > 0) {
    const { error } = await ctx.supabase
      .from("commitments")
      .delete()
      .eq("user_id", ctx.userId)
      .in("id", undo.created);
    if (error) errors.push(error.message);
  }
  for (const before of undo.before) {
    const { id, ...fields } = before;
    const { data, error } = await ctx.supabase
      .from("commitments")
      .update(toRow(fields))
      .eq("id", id)
      .eq("user_id", ctx.userId)
      .select("id");
    if (error) {
      errors.push(error.message);
      continue;
    }
    // Removed → it's gone; put it back with its old id.
    if ((data ?? []).length === 0) {
      const { error: insertError } = await ctx.supabase
        .from("commitments")
        .insert({ id, ...toRow(fields), user_id: ctx.userId, workspace_id: ctx.workspaceId, source: "chat" });
      if (insertError) errors.push(insertError.message);
    }
  }
  return errors.length > 0 ? { ok: false as const, error: errors.join("; ") } : { ok: true as const };
}

export const SET_COMMITMENTS: ToolDefinition = {
  schema: {
    name: "set_commitments",
    description:
      "Save, change or remove the user's FIXED weekly commitments — times they are not free: a class, lecture, lab, work shift, practice, standing meeting ('stats every weekday at 2pm', 'I work Tue/Thu 9–5', 'no more practice on fridays'). Source \"user\" applies immediately (the user sees it with an Undo); source \"suggestion\" (your idea) waits on a card. Focus and the planner then plan around this time. Not for one-off events (add_task_to_calendar) and not for habits without a fixed time.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["user", "suggestion"],
          description:
            "user = the user said it (\"stats every weekday at 2pm\") — applies at once with Undo. suggestion = YOUR recommendation the user hasn't agreed to (you think they should block time) — waits on a card for their OK.",
        },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "update", "remove"] },
              commitment_id: {
                type: "string",
                description:
                  "update/remove only: the id of THAT SAME activity from the Fixed commitments list. A new activity is an add, never an update of another one.",
              },
              title: { type: "string", description: "Short name, e.g. 'Stats lecture', 'Café shift'" },
              node_id: {
                type: "string",
                description: "Optional: UUID of the existing node it belongs to (e.g. the Stats class node)",
              },
              days: {
                type: "array",
                items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
                description: "Weekdays it happens. 'Every day' for a class, lecture or job means mon–fri.",
              },
              start_time: { type: "string", description: "24h HH:MM, e.g. '14:00'" },
              end_time: {
                type: "string",
                description: "24h HH:MM. Leave out if the user didn't say (defaults to 1 hour).",
              },
              until: {
                type: "string",
                description:
                  "When it stops, only if the user said: their words copied verbatim ('dec 20', 'friday', 'for 6 weeks') or YYYY-MM-DD. Not said → leave it out (no end date). A vague end ('end of term') → leave it out.",
              },
              from: {
                type: "string",
                description: "When it starts, only if it isn't running yet: the user's words ('next monday', 'oct 6') or YYYY-MM-DD",
              },
            },
            required: ["action"],
          },
        },
      },
      required: ["source", "changes"],
    },
  },
  handler: (input, ctx: ToolContext) => applyCommitmentChanges(ctx, input, "chat"),
};

export const COMMITMENT_MUTATION_TOOLS: ToolDefinition[] = [SET_COMMITMENTS];
