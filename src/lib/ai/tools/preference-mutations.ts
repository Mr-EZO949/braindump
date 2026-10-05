// set_preferences — chat/dump → standing preferences (docs/preferences.md).
//
// "I want to spend 4h a day coding" is kept for later: the planner fits it
// into a day plan, Focus leans toward it when it hasn't been started today,
// and the chat snapshot lists it. A DIRECT tool like set_commitments: it
// applies as soon as the model calls it (source "user"), the chat shows a card
// with an Undo, and the result carries the undo snapshot.

import {
  applyToList,
  describePreference,
  parsePreferenceChanges,
  preferenceLabel,
  undoOnList,
  type PreferenceChange,
  type PreferenceUndo,
} from "@/lib/planner/preferences";
import { loadPreferences, savePreferences } from "@/lib/planner/preference-store";
import type { ToolContext, ToolDefinition } from "./read-only";

// A link must point at one of the user's own nodes; anything else is dropped
// (the budget still counts, matched by its name).
async function ownedNodeIds(ctx: ToolContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data } = await ctx.supabase.from("nodes").select("id").eq("user_id", ctx.userId).in("id", ids);
  return new Set(((data ?? []) as { id: string }[]).map((n) => n.id));
}

function linkIds(changes: PreferenceChange[]): string[] {
  return changes.flatMap((c) =>
    c.action === "add" && c.fields.node_id ? [c.fields.node_id] : c.action === "update" && c.patch.node_id ? [c.patch.node_id] : [],
  );
}

export async function applyPreferenceChanges(ctx: ToolContext, input: unknown) {
  const existing = await loadPreferences(ctx.userId, ctx.supabase);
  const parsed = parsePreferenceChanges(input, existing);
  if (!parsed.ok) return { accepted: false, error: parsed.error };

  const owned = await ownedNodeIds(ctx, [...new Set(linkIds(parsed.changes))]);
  const changes = parsed.changes.map((change): PreferenceChange => {
    if (change.action === "add" && change.fields.node_id && !owned.has(change.fields.node_id)) {
      return { ...change, fields: { ...change.fields, node_id: null } };
    }
    if (change.action === "update" && change.patch.node_id && !owned.has(change.patch.node_id)) {
      const patch = { ...change.patch };
      delete patch.node_id;
      return { ...change, patch };
    }
    return change;
  });

  const { next, applied, undo } = applyToList(existing, changes, () => crypto.randomUUID());
  if (applied.length === 0) return { accepted: false, error: "nothing to change" };
  const saved = await savePreferences(ctx.userId, next, ctx.supabase);
  if (!saved.ok) return { accepted: false, error: `couldn't save: ${saved.error}` };

  const detail = (a: (typeof applied)[number]) =>
    a.action === "remove" ? "Forgotten" : describePreference(a.preference);
  return {
    accepted: true,
    applied: applied.map((a) => ({
      // The card keys rows by node; a preference uses its own id.
      node_id: a.preference.id,
      title: preferenceLabel(a.preference),
      action: a.action,
      detail: detail(a),
      score_before: null,
      score_after: null,
    })),
    failed: [],
    message: `Saved ✓ ${applied.map((a) => `${preferenceLabel(a.preference)}: ${detail(a)}`).join(" · ")}`,
    undo,
  };
}

/** Puts back exactly what applyPreferenceChanges changed. */
export async function undoPreferenceChanges(ctx: Pick<ToolContext, "userId" | "supabase">, undo: PreferenceUndo) {
  const list = await loadPreferences(ctx.userId, ctx.supabase);
  const saved = await savePreferences(ctx.userId, undoOnList(list, undo), ctx.supabase);
  return saved.ok ? { ok: true as const } : { ok: false as const, error: saved.error };
}

export const SET_PREFERENCES: ToolDefinition = {
  schema: {
    name: "set_preferences",
    description:
      "Save, change or forget a STANDING preference about their time, kept for every future plan and Focus. kind: budget = time on something ('4h a day coding'), hours = working hours ('no work after 10pm'), peak = best focus hours, rule = any other ('gym in the mornings'). source \"user\" applies now with Undo; \"suggestion\" waits.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["user", "suggestion"] },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "update", "remove"] },
              preference_id: { type: "string", description: "update / remove: id from [STANDING PREFERENCES]" },
              kind: { type: "string", enum: ["budget", "hours", "peak", "rule"] },
              title: { type: "string", description: "budget: the activity; rule: the rule, short" },
              minutes: { type: "integer", description: "budget, per day unless per: week (4h = 240)" },
              per: { type: "string", enum: ["day", "week"] },
              days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
              node_id: { type: "string" },
              from: { type: "string", description: "HH:MM — hours: not before; peak: start" },
              until: { type: "string", description: "HH:MM — hours: no work after; peak: end" },
              part_of_day: { type: "string", enum: ["morning", "afternoon", "evening"] },
            },
            required: ["action"],
          },
        },
      },
      required: ["source", "changes"],
    },
  },
  handler: (input, ctx: ToolContext) => applyPreferenceChanges(ctx, input),
};

export const PREFERENCE_MUTATION_TOOLS: ToolDefinition[] = [SET_PREFERENCES];
