// change — chat's one tool for changing the graph (docs/unified-turn.md).
//
// Until 2026-10-02 chat had eight: propose_node, propose_nodes_batch,
// propose_changes_batch, propose_edge, propose_merge, update_node,
// archive_node, complete_node — and every one of them waited for Accept,
// while the same words in a brain dump applied at once. Now a chat change is
// a change set like a dump's and goes through the same policy
// (turn-policy.ts via dump-turn.ts applyTurnChanges):
//
//   source "user"        the user asked for it or said it happened → what
//                        they reliably accept is applied now, with Undo
//                        (new items, things done, links); reorganizations
//                        wait on the card, row by row
//   source "suggestion"  the assistant's own idea → everything waits
//
// A "planned" tool, like build_graph: the split happens before the model
// hears back. The handler only runs for the rows the user then accepts.

import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANGE_KINDS, VALID_EDGE_TYPES, isHierarchyEdgeType, type ChangeOp } from "@/lib/graph/change-set";
import { NODE_TYPES } from "@/lib/graph/node-types";
import { getStructuralSubtree } from "@/lib/graph/structure";
import type { GraphData } from "@/types/graph";
import type { TurnApplied } from "@/types/ai";

import { applyTurnChanges } from "../dump-turn";
import { applyBuildPlan, type BuildPlanInput } from "./apply-plan";
import type { ToolContext, ToolDefinition } from "./read-only";

export const CHANGE_TOOL = "change";
export type ChangeSource = "user" | "suggestion";

const MAX_OPS = 20;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A chat capture the user stated: as sure as a confident extraction.
const STATED_CONFIDENCE = 0.9;

// What one planned tool call (change, build_graph) comes to.
export interface TurnPlan {
  // The turn card: what was applied now (with Undo) and the builder's
  // questions; the waiting rows show inside it. Null → no card.
  turn: TurnApplied | null;
  // What waits for the user: the card's input. Null when nothing waits.
  waiting: BuildPlanInput | null;
  // What the model hears when nothing waits.
  result: Record<string, unknown>;
}

const EMPTY_TURN: TurnApplied = { added: [], done: [], links: [], questions: [] };

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// ---------------------------------------------------------------------------
// The model's ops → checked ChangeOps
// ---------------------------------------------------------------------------

// Pure. Drops nothing silently: every op either becomes a ChangeOp or an
// error the model hears back. A belongs_to / contains link is a move. A new
// node without a local_ref gets one, so the calibration can clear it.
export function normalizeChangeOps(raw: unknown): { ops: ChangeOp[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { ops: [], errors: ["changes must be a non-empty array"] };
  if (raw.length > MAX_OPS) errors.push(`at most ${MAX_OPS} changes per call — the rest were left out`);

  const ops: ChangeOp[] = [];
  // The new nodes' local_refs: a ref in this set is a node of this call, any
  // other ref an existing node's id (planChange checks it exists).
  const usedRefs = new Set(
    raw.flatMap((r) => {
      const ref = r && typeof r === "object" && (r as { kind?: unknown }).kind === "create_node" ? str((r as { local_ref?: unknown }).local_ref) : "";
      return ref ? [ref] : [];
    }),
  );
  const localRefs = new Set(usedRefs);
  const isLocal = (ref: string) => localRefs.has(ref);
  let nextRef = 1;
  const freshRef = () => {
    while (usedRefs.has(`c${nextRef}`)) nextRef++;
    const ref = `c${nextRef++}`;
    usedRefs.add(ref);
    return ref;
  };

  raw.slice(0, MAX_OPS).forEach((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const kind = str(r.kind);
    const fail = (why: string) => errors.push(`changes[${i}] (${kind || "no kind"}): ${why}`);
    if (!(CHANGE_KINDS as readonly string[]).includes(kind)) return fail(`kind must be one of ${CHANGE_KINDS.join(", ")}`);

    switch (kind) {
      case "create_node": {
        const title = str(r.title);
        const nodeType = str(r.node_type).toLowerCase().replace(/[\s-]+/g, "_");
        if (!title) return fail("title is required");
        if (title.length > 120) return fail("title must be 120 characters or fewer");
        if (!(NODE_TYPES as readonly string[]).includes(nodeType)) return fail(`node_type must be one of ${NODE_TYPES.join(", ")}`);
        const parent = str(r.parent_node_id);
        ops.push({
          kind: "create_node",
          local_ref: str(r.local_ref) || freshRef(),
          title,
          node_type: nodeType,
          ...(str(r.summary) ? { summary: str(r.summary) } : {}),
          ...(str(r.body) ? { body: str(r.body) } : {}),
          ...(ISO_DATE.test(str(r.target_date)) ? { target_date: str(r.target_date) } : {}),
          // A parent is an existing id or another new node's local_ref.
          ...(parent ? (isLocal(parent) ? { parent_local_ref: parent } : { parent_node_id: parent }) : {}),
        });
        return;
      }
      case "move": {
        const nodeId = str(r.node_id);
        const parent = str(r.new_parent_node_id);
        if (!nodeId || !parent) return fail("node_id and new_parent_node_id are required");
        ops.push({
          kind: "move",
          node_id: nodeId,
          ...(isLocal(parent) ? { new_parent_local_ref: parent } : { new_parent_node_id: parent }),
        });
        return;
      }
      case "update": {
        const nodeId = str(r.node_id);
        if (!nodeId) return fail("node_id is required");
        const op: Extract<ChangeOp, { kind: "update" }> = { kind: "update", node_id: nodeId };
        if (str(r.title)) op.title = str(r.title);
        if (str(r.node_type)) op.node_type = str(r.node_type);
        if (typeof r.summary === "string") op.summary = r.summary;
        if (typeof r.body === "string") op.body = r.body;
        if (typeof r.target_date === "string" && (r.target_date === "" || ISO_DATE.test(r.target_date))) op.target_date = r.target_date;
        if (Object.keys(op).length === 2) return fail("give at least one field to change");
        ops.push(op);
        return;
      }
      case "create_edge": {
        const source = str(r.source_node_id);
        const target = str(r.target_node_id);
        const edgeType = str(r.edge_type).toLowerCase();
        if (!source || !target) return fail("source_node_id and target_node_id are required");
        if (source === target) return fail("source and target must be different nodes");
        if (!VALID_EDGE_TYPES.has(edgeType)) return fail(`edge_type must be one of ${[...VALID_EDGE_TYPES].join(", ")}`);
        if (isHierarchyEdgeType(edgeType)) {
          // A parent link is a move — the policy treats it as one.
          const child = edgeType === "contains" ? target : source;
          const parent = edgeType === "contains" ? source : target;
          ops.push({
            kind: "move",
            node_id: child,
            ...(isLocal(parent) ? { new_parent_local_ref: parent } : { new_parent_node_id: parent }),
          });
          return;
        }
        ops.push({
          kind: "create_edge",
          source_node_id: source,
          target_node_id: target,
          edge_type: edgeType,
          ...(str(r.explanation) ? { explanation: str(r.explanation).slice(0, 1000) } : {}),
        });
        return;
      }
      case "remove_edge": {
        const source = str(r.source_node_id);
        const target = str(r.target_node_id);
        if (!source || !target || source === target) return fail("two different nodes are required");
        const edgeType = str(r.edge_type).toLowerCase();
        if (edgeType && isHierarchyEdgeType(edgeType)) return fail("a parent link is changed with a move, not removed");
        ops.push({ kind: "remove_edge", source_node_id: source, target_node_id: target, ...(edgeType ? { edge_type: edgeType } : {}) });
        return;
      }
      case "merge": {
        const nodeId = str(r.node_id);
        const into = str(r.into_node_id);
        if (!nodeId || !into || nodeId === into) return fail("node_id (the duplicate) and into_node_id (the one kept) are required");
        ops.push({ kind: "merge", node_id: nodeId, into_node_id: into });
        return;
      }
      default: {
        // complete · archive · delete_node
        const nodeId = str(r.node_id);
        if (!nodeId) return fail("node_id is required");
        ops.push({ kind: kind as "complete" | "archive" | "delete_node", node_id: nodeId });
      }
    }
  });
  return { ops, errors };
}

// Every node id an op names that isn't a new node of the same set.
function existingRefs(ops: ChangeOp[]): string[] {
  const local = new Set(ops.flatMap((op) => (op.kind === "create_node" && op.local_ref ? [op.local_ref] : [])));
  const refs = ops.flatMap((op): Array<string | undefined> => {
    switch (op.kind) {
      case "create_node":
        return [op.parent_node_id];
      case "move":
        return [op.node_id, op.new_parent_node_id];
      case "create_edge":
      case "remove_edge":
        return [op.source_node_id, op.target_node_id];
      case "merge":
        return [op.node_id, op.into_node_id];
      default:
        return [op.node_id];
    }
  });
  return [...new Set(refs.filter((ref): ref is string => !!ref && !local.has(ref)))];
}

// ---------------------------------------------------------------------------
// The ledger (proposed_nodes): one row per new node, so the calibration
// learns from chat too and Undo teaches it (change-undo.ts remove_node).
// ---------------------------------------------------------------------------

export async function createChatEntry(ctx: ToolContext): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from("raw_entries")
    .insert({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      raw_text: (ctx.userMessage ?? "").slice(0, 10000) || "(chat)",
      source_type: "assistant_save",
      status: "completed",
    })
    .select("id")
    .single();
  if (error || !data) {
    console.warn("[change] chat entry not saved — new nodes go on the card:", error?.message);
    return null;
  }
  return data.id as string;
}

async function saveLedger(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string; entryId: string },
  creates: Array<Extract<ChangeOp, { kind: "create_node" }>>,
) {
  if (creates.length === 0) return [];
  const { data, error } = await supabase
    .from("proposed_nodes")
    .insert(
      creates.map((op) => ({
        raw_entry_id: scope.entryId,
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
        local_ref: op.local_ref,
        primary_parent_local_ref: op.parent_local_ref ?? null,
        existing_parent_node_id: op.parent_node_id ?? null,
        proposed_title: op.title,
        proposed_summary: op.summary ?? null,
        proposed_node_type: op.node_type,
        proposed_target_date: op.target_date ?? null,
        extraction_confidence: STATED_CONFIDENCE,
        proposal_status: "pending_review",
      })),
    )
    .select("id, local_ref, primary_parent_local_ref, existing_parent_node_id, proposed_node_type, extraction_confidence");
  if (error || !data) {
    console.warn("[change] ledger not saved — new nodes go on the card:", error?.message);
    return [];
  }
  return data as Array<{
    id: string;
    local_ref: string | null;
    primary_parent_local_ref: string | null;
    existing_parent_node_id: string | null;
    proposed_node_type: string;
    extraction_confidence: number;
  }>;
}

// ---------------------------------------------------------------------------
// The card's words: the title before a rename, what a delete takes with it.
// ---------------------------------------------------------------------------

async function annotateForCard(ctx: ToolContext, ops: ChangeOp[], titles: ReadonlyMap<string, string>): Promise<ChangeOp[]> {
  const deletes = ops.filter((op) => op.kind === "delete_node");
  let graph: GraphData | null = null;
  if (deletes.length > 0) {
    const [{ data: nodes }, { data: edges }] = await Promise.all([
      ctx.supabase.from("nodes").select("id").eq("user_id", ctx.userId).eq("workspace_id", ctx.workspaceId),
      ctx.supabase
        .from("edges")
        .select("id, source_node_id, target_node_id, edge_type")
        .eq("user_id", ctx.userId)
        .eq("workspace_id", ctx.workspaceId)
        .eq("status", "active"),
    ]);
    graph = { nodes: nodes ?? [], edges: edges ?? [] } as unknown as GraphData;
  }
  return ops.map((op): ChangeOp => {
    if (op.kind === "update" && op.title) {
      const before = titles.get(op.node_id);
      return before ? { ...op, before_title: before } : op;
    }
    if (op.kind === "delete_node") {
      const before = titles.get(op.node_id);
      const under = graph ? getStructuralSubtree(graph, op.node_id).descendantCount : 0;
      return { ...op, ...(before ? { before_title: before } : {}), subtree_count: under };
    }
    return op;
  });
}

// ---------------------------------------------------------------------------
// What the model hears about an applied turn
// ---------------------------------------------------------------------------

export function appliedForModel(applied: TurnApplied | null, waiting: number): Record<string, unknown> {
  const added = (applied?.added ?? []).map((n) => `${n.title} (${n.node_type.replace(/_/g, " ")})${n.parent_title ? ` under ${n.parent_title}` : ""}`);
  const linked = (applied?.links ?? []).filter((l) => !l.removed).map((l) => `${l.source_title} ${l.edge_type.replace(/_/g, " ")} ${l.target_title}`);
  const unlinked = (applied?.links ?? []).filter((l) => l.removed).map((l) => `${l.source_title} — ${l.target_title}`);
  const total = added.length + (applied?.done.length ?? 0) + linked.length + unlinked.length;
  return {
    accepted: total > 0,
    applied: total,
    ...(added.length ? { added } : {}),
    ...(applied?.done.length ? { done: applied.done } : {}),
    ...(linked.length ? { linked } : {}),
    ...(unlinked.length ? { unlinked } : {}),
    ...(waiting > 0 ? { waiting_on_card: waiting } : {}),
    message:
      total > 0
        ? "Applied now — the user sees it on a card with Undo. Don't list it again; one short sentence at most."
        : "Nothing was applied.",
  };
}

// ---------------------------------------------------------------------------
// Planning a change call
// ---------------------------------------------------------------------------

export async function planChange(input: unknown, ctx: ToolContext): Promise<TurnPlan> {
  const args = (input ?? {}) as { source?: unknown; changes?: unknown };
  // A missing source is treated as a suggestion: the safe side is a card.
  const source: ChangeSource = args.source === "user" ? "user" : "suggestion";
  const { ops, errors } = normalizeChangeOps(args.changes);
  const fail = (error: string): TurnPlan => ({ turn: null, waiting: null, result: { accepted: false, error } });
  if (ops.length === 0) return fail(errors.join("; ") || "No changes given.");

  // Every id must be a node of this workspace — never a guess.
  const refs = existingRefs(ops);
  const titles = new Map<string, string>();
  if (refs.length > 0) {
    const { data } = await ctx.supabase
      .from("nodes")
      .select("id, title")
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .in("id", refs);
    for (const row of (data ?? []) as Array<{ id: string; title: string }>) titles.set(row.id, row.title);
    const missing = refs.filter((ref) => !titles.has(ref));
    if (missing.length > 0) {
      return fail(
        `Not in this workspace: ${missing.join(", ")} — use a node id from the snapshot or search_nodes, or the local_ref of a create_node in this call.`,
      );
    }
  }
  const annotated = await annotateForCard(ctx, ops, titles);
  const notes = errors.length > 0 ? [`Left out: ${errors.join("; ")}`] : [];

  if (source === "suggestion") {
    return {
      turn: EMPTY_TURN,
      waiting: { changes: annotated, origin: "chat", suggested: true, ...(notes.length ? { notes } : {}) },
      result: {},
    };
  }

  // The user's own words: the dump policy, with a ledger for the new nodes.
  const creates = annotated.filter((op): op is Extract<ChangeOp, { kind: "create_node" }> => op.kind === "create_node");
  const entryId = creates.length > 0 ? await createChatEntry(ctx) : null;
  const ledger = entryId
    ? await saveLedger(ctx.supabase, { userId: ctx.userId, workspaceId: ctx.workspaceId, entryId }, creates)
    : [];
  const ledgerIdByRef = new Map(ledger.flatMap((row) => (row.local_ref ? [[row.local_ref, row.id] as const] : [])));
  const withLedger = annotated.map((op): ChangeOp => {
    const id = op.kind === "create_node" && op.local_ref ? ledgerIdByRef.get(op.local_ref) : undefined;
    return id && op.kind === "create_node" ? { ...op, ledger_id: id } : op;
  });

  const changes = await applyTurnChanges({
    ctx,
    ops: withLedger,
    ledger,
    held: new Set(),
    autoApply: ctx.autoApply !== false,
    source: "chat",
  });
  const applied = changes.added.length + changes.done.length + changes.links.length > 0;
  const turn: TurnApplied | null =
    applied || changes.waiting.length > 0
      ? { added: changes.added, done: changes.done, links: changes.links, questions: [], undo: changes.undo }
      : null;
  return {
    turn,
    waiting:
      changes.waiting.length > 0
        ? { changes: changes.waiting, origin: "chat", ...(notes.length ? { notes } : {}) }
        : null,
    result: { ...appliedForModel(turn, changes.waiting.length), ...(errors.length ? { left_out: errors } : {}) },
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

// Descriptions are part of every chat call's cached prefix (assistant-v28,
// fix list #19): what a field means lives here once; when to use the tool
// lives in prompts/assistant.ts. Node types are explained there, not here.
const REF = "Existing node id, or a local_ref from this call.";

const CHANGE: ToolDefinition = {
  schema: {
    name: CHANGE_TOOL,
    description:
      "Change the graph — add, move, rename/retype, link, unlink, mark done, archive, delete or merge — everything the message changes in ONE call. source \"user\": applied now with Undo (moves, renames, archives, deletes and merges wait on the card). source \"suggestion\": your own idea, all of it waits. Regroups, new parents over existing nodes and long multi-item messages → build_graph.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["user", "suggestion"],
          description: "user = their words asked for it or said it happened. suggestion = you propose it and they haven't agreed.",
        },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: MAX_OPS,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [...CHANGE_KINDS],
                description:
                  "create_node: new node (parent_node_id; local_ref if later items point at it). move: an existing node to a new parent. update: rename / retype / summary / deadline. create_edge: a link. remove_edge: removes whatever links two nodes, either direction, and says so if nothing did. complete: done (a habit: done today). archive: no longer relevant (restorable). delete_node: gone for good with everything under it. merge: node_id is a duplicate of into_node_id.",
              },
              local_ref: { type: "string", description: 'create_node: a short id ("n1") for later items in this call.' },
              title: { type: "string", description: "create_node: the title. update: the new title." },
              node_type: { type: "string", enum: [...NODE_TYPES] },
              summary: { type: "string" },
              body: { type: "string" },
              target_date: { type: "string", description: "YYYY-MM-DD. update: empty string clears it." },
              parent_node_id: { type: "string", description: `create_node: where it goes. ${REF}` },
              node_id: { type: "string", description: REF },
              new_parent_node_id: { type: "string", description: `move: the new parent. ${REF}` },
              source_node_id: { type: "string", description: REF },
              target_node_id: { type: "string", description: REF },
              edge_type: { type: "string", enum: [...VALID_EDGE_TYPES].filter((t) => !isHierarchyEdgeType(t)) },
              explanation: { type: "string", description: "create_edge: one sentence why." },
              into_node_id: { type: "string", description: "merge: the node that is kept." },
            },
            required: ["kind"],
          },
        },
      },
      required: ["source", "changes"],
    },
  },
  // Runs only for the rows the user accepted on the card.
  handler: async (input, ctx: ToolContext) => {
    const plan = (input ?? {}) as Partial<BuildPlanInput>;
    if (!Array.isArray(plan.changes) || plan.changes.length === 0) {
      return { accepted: false, error: "No changes to apply — call change again." };
    }
    return applyBuildPlan(plan as BuildPlanInput, ctx);
  },
};

export const CHANGE_TOOLS: ToolDefinition[] = [CHANGE];
