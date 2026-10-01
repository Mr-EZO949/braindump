// The one writer of AI graph changes. A change set is an ordered list of ops —
// create · move · update · link · complete · archive — that may refer to nodes
// created in the same set by local_ref. Chat's mutation tools
// (lib/ai/tools/mutations.ts) are thin wrappers over it, so a node is the same
// object whichever tool created it, and gets the same intake as an accepted
// brain-dump proposal (node-intake.ts). Spec: docs/unified-turn.md.
//
// Each primitive below is the only implementation of its op: a parent is set
// by setNodeParent, a status by transitionNodeStatus.

import type { SupabaseClient } from "@supabase/supabase-js";

import { runClusteringPass } from "@/lib/ai/clustering";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { ensureWorkspaceRoot } from "@/lib/graph/ensure-workspace-root";
import { getWorkspaceRootId, setNodeParent } from "@/lib/graph/hierarchy";
import { getImportanceLabel } from "@/lib/graph/importance";
import {
  DEFAULT_IMPORTANCE_INDEX,
  embedNewNodes,
  judgeAndRescore,
  newNodeRow,
  type IntakeNode,
} from "@/lib/graph/node-intake";
import { NODE_TYPES } from "@/lib/graph/node-types";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { localDateISO } from "@/lib/time/local-date";
import type { NodeStatus, NodeType } from "@/types/graph";

export interface ChangeContext {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  // The user's local calendar date (YYYY-MM-DD) — never the UTC date.
  today?: string;
  // Runs work after the response has gone out (Next's `after`). The slow part
  // of a new node's intake — the judgment call and the rescore that reads it —
  // goes there so Accept answers at once. Absent → awaited in place.
  defer?: (work: () => Promise<void>) => void;
}

export type ChangeOp =
  | {
      kind: "create_node";
      local_ref?: string;
      title: string;
      node_type: string;
      summary?: string;
      parent_node_id?: string;
      parent_local_ref?: string;
      target_date?: string;
      importance_index?: number;
      body?: string;
      // The proposed_nodes row that records this proposal (a brain dump's
      // ledger: calibration, Undo, dump history). Not read here.
      ledger_id?: string;
    }
  | {
      kind: "move";
      node_id: string;
      new_parent_node_id?: string;
      new_parent_local_ref?: string;
    }
  | {
      kind: "update";
      node_id: string;
      title?: string;
      node_type?: string;
      summary?: string;
      target_date?: string;
      body?: string;
    }
  | {
      kind: "create_edge";
      source_node_id: string;
      target_node_id: string;
      edge_type: string;
      explanation?: string;
    }
  | { kind: "complete"; node_id: string }
  | { kind: "archive"; node_id: string };

export const CHANGE_KINDS = ["create_node", "move", "update", "create_edge", "complete", "archive"] as const;

export type OpResult =
  | { kind: string; ok: true; id?: string; detail?: string }
  | { kind: string; ok: false; error: string };

// A node this change set created, with the index of the op that made it.
export interface CreatedNode extends IntakeNode {
  index: number;
  parentAttached: boolean;
}

export interface ChangeSetOutcome {
  // One per op, in the order given.
  results: OpResult[];
  created: CreatedNode[];
}

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

const VALID_NODE_TYPES: ReadonlySet<string> = new Set(NODE_TYPES);

export function isValidNodeType(value: string): value is NodeType {
  return VALID_NODE_TYPES.has(value);
}

// The model's node_type as a stored value: tolerate "Big task" / "big-task"
// and the retired "concept" (→ note), so an old habit doesn't fail the tool.
export function toolNodeType(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return t === "concept" ? "note" : t;
}

// Edge types the assistant may propose. Keeps the surface small and
// semantically meaningful — the inference pipeline uses a wider set, but
// user-facing proposals should stay legible.
export const VALID_EDGE_TYPES: ReadonlySet<string> = new Set([
  "belongs_to", // child → parent: MOVES the source under the target
  "contains", // parent → child: the same move, said from the parent's side
  "required_for", // dependency: source is required for target
  "supports", // source reinforces target
  "related_to", // loose lateral connection
  "useful_for", // source is useful for target
  "inspired_by", // source was inspired by target
]);

// A node's parent is a belongs_to edge, child → parent (lib/graph/hierarchy.ts).
// "contains" is only the model's way of saying it from the parent's side.
const HIERARCHY_EDGE_TYPES: ReadonlySet<string> = new Set(["belongs_to", "contains"]);

export function isHierarchyEdgeType(edgeType: string): boolean {
  return HIERARCHY_EDGE_TYPES.has(edgeType);
}

export function hierarchyPair(
  edgeType: string,
  sourceId: string,
  targetId: string,
): { childId: string; parentId: string } {
  return edgeType === "contains"
    ? { childId: targetId, parentId: sourceId }
    : { childId: sourceId, parentId: targetId };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export async function fetchWorkspaceNode(
  ctx: ChangeContext,
  nodeId: string,
): Promise<{ id: string; status: string | null; node_type: string | null } | null> {
  const { data } = await ctx.supabase
    .from("nodes")
    .select("id, status, node_type")
    .eq("id", nodeId)
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  return (
    (data as { id: string; status: string | null; node_type: string | null } | null) ?? null
  );
}

// The workspace root, fetched at most once per change set. A workspace that
// never got one (the bootstrap wizard is skippable) is given one here, as the
// dump accept path does — otherwise its new nodes float.
function workspaceRootOnce(ctx: ChangeContext): () => Promise<string | null> {
  let cached: Promise<string | null> | null = null;
  const scope = { supabase: ctx.supabase, userId: ctx.userId, workspaceId: ctx.workspaceId };
  return () =>
    (cached ??= getWorkspaceRootId(scope).then((rootId) => rootId ?? ensureWorkspaceRoot(scope)));
}

// Parent link for a node that was just created. No parent named → the
// workspace root, so a new node never floats until the connection engine
// guesses one.
async function attachNewNode(
  ctx: ChangeContext,
  nodeId: string,
  parentId: string | null,
  rootId: () => Promise<string | null>,
): Promise<boolean> {
  const explicit = parentId !== null;
  const target = parentId ?? (await rootId());
  if (!target || target === nodeId) return false;
  const { error } = await ctx.supabase.from("edges").insert({
    user_id: ctx.userId,
    workspace_id: ctx.workspaceId,
    source_node_id: nodeId,
    target_node_id: target,
    edge_type: "belongs_to",
    status: "active",
    user_confirmed: explicit,
    explanation: explicit ? null : "Anchored to workspace.",
  });
  return !error;
}

export async function recomputeScores(ctx: ChangeContext): Promise<void> {
  await computeWorkspaceScores({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    supabase: ctx.supabase,
    today: ctx.today,
  }).catch((err: unknown) => {
    console.warn("[change-set] score recompute failed:", err);
  });
}

// Moves a node under a new parent. The result says where it came from so the
// model (or the no-model confirmation) can tell the user plainly.
export async function moveNode(
  ctx: ChangeContext,
  nodeId: string,
  parentId: string,
  explanation: string | null,
): Promise<Record<string, unknown> & { accepted: boolean; moved?: boolean }> {
  const result = await setNodeParent({
    supabase: ctx.supabase,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    nodeId,
    parentId,
    explanation,
  });
  if (!result.ok) return { accepted: false, error: result.error };
  if (!result.changed) {
    return {
      accepted: true,
      moved: false,
      node_id: nodeId,
      parent_node_id: parentId,
      message: `"${result.nodeTitle}" is already under "${result.parentTitle}".`,
    };
  }
  return {
    accepted: true,
    moved: true,
    node_id: nodeId,
    parent_node_id: parentId,
    previous_parent_title: result.previousParentTitle,
    message: `Moved "${result.nodeTitle}" under "${result.parentTitle}" ✓`,
  };
}

// A non-hierarchy link. An identical active edge counts as success.
export async function createLateralEdge(
  ctx: ChangeContext,
  sourceId: string,
  targetId: string,
  edgeType: string,
  explanation: string | null,
): Promise<{ ok: true; edgeId: string; alreadyExisted: boolean } | { ok: false; error: string }> {
  const { data: existing } = await ctx.supabase
    .from("edges")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("source_node_id", sourceId)
    .eq("target_node_id", targetId)
    .eq("edge_type", edgeType)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return { ok: true, edgeId: existing.id as string, alreadyExisted: true };

  const { data: edge, error } = await ctx.supabase
    .from("edges")
    .insert({
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: edgeType,
      status: "active",
      explanation,
      user_confirmed: true,
    })
    .select("id")
    .single();
  if (error || !edge) return { ok: false, error: error?.message ?? "unknown error" };
  return { ok: true, edgeId: edge.id as string, alreadyExisted: false };
}

// Does this node hold steps or phases (the children that make a task a big task)?
async function hasWorkChildren(ctx: ChangeContext, nodeId: string): Promise<boolean> {
  const { data: childEdges } = await ctx.supabase
    .from("edges")
    .select("source_node_id")
    .eq("user_id", ctx.userId)
    .eq("target_node_id", nodeId)
    .eq("edge_type", "belongs_to")
    .eq("status", "active");
  const childIds = (childEdges ?? []).map((e: { source_node_id: string }) => e.source_node_id);
  if (childIds.length === 0) return false;
  const { data: children } = await ctx.supabase
    .from("nodes")
    .select("id")
    .eq("user_id", ctx.userId)
    .in("id", childIds)
    .in("node_type", ["task", "big_task", "habit", "project"])
    .limit(1);
  return (children ?? []).length > 0;
}

// Patches title / summary / node_type / importance_index / target_date / body.
// Shared by update_node and the "update" op (which rescores once per set).
export async function updateNodeFields(
  input: unknown,
  ctx: ChangeContext,
  options?: { recompute?: boolean },
): Promise<Record<string, unknown>> {
  const args = (input ?? {}) as {
    node_id?: string;
    title?: string;
    summary?: string;
    node_type?: string;
    importance_index?: number;
    target_date?: string;
    body?: string;
  };
  const nodeId = typeof args.node_id === "string" ? args.node_id : "";
  if (!nodeId) return { accepted: false, error: "node_id is required" };

  const target = await fetchWorkspaceNode(ctx, nodeId);
  if (!target) {
    return { accepted: false, error: "node_id not found in this workspace" };
  }

  const patch: Record<string, unknown> = {};
  if (typeof args.title === "string") {
    const title = args.title.trim();
    if (!title) return { accepted: false, error: "title cannot be empty" };
    if (title.length > 120) {
      return { accepted: false, error: "title must be ≤120 chars" };
    }
    patch.title = title;
  }
  if (typeof args.summary === "string") {
    const summary = args.summary.trim();
    patch.summary = summary.length > 0 ? summary.slice(0, 2000) : null;
  }
  if (typeof args.node_type === "string") {
    const nt = toolNodeType(args.node_type);
    if (!isValidNodeType(nt)) {
      return {
        accepted: false,
        error: `node_type must be one of ${NODE_TYPES.join(", ")}`,
      };
    }
    // A node with steps under it can't be a plain task — same rule as the DB
    // trigger promote_task_with_children, which only fires when a child is
    // ADDED, not when the parent is retyped afterwards.
    patch.node_type = nt === "task" && (await hasWorkChildren(ctx, nodeId)) ? "big_task" : nt;
  }
  if (typeof args.importance_index === "number") {
    // importance_index alone is overwritten by the next score recompute, so
    // a chat-set importance pins manual_weight — the scorer's hard override.
    const idx = Math.max(0, Math.min(100, Math.round(args.importance_index)));
    patch.importance_index = idx;
    patch.importance = getImportanceLabel(idx);
    patch.manual_weight = idx;
    patch.manual_weight_set_at = new Date().toISOString();
  }
  if (typeof args.target_date === "string") {
    const td = args.target_date.trim();
    if (td === "") {
      patch.target_date = null;
    } else if (ISO_DATE.test(td)) {
      patch.target_date = td;
    } else {
      return {
        accepted: false,
        error: "target_date must be YYYY-MM-DD or empty string to clear",
      };
    }
  }
  if (typeof args.body === "string") {
    const trimmedBody = args.body.trim();
    patch.body = trimmedBody.length > 0 ? trimmedBody.slice(0, 400) : null;
  }

  if (Object.keys(patch).length === 0) {
    return { accepted: false, error: "no fields provided to update" };
  }
  patch.updated_at = new Date().toISOString();

  const { data: updated, error: updateErr } = await ctx.supabase
    .from("nodes")
    .update(patch)
    .eq("id", nodeId)
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .select("id, title, node_type, importance_index")
    .single();

  if (updateErr || !updated) {
    return {
      accepted: false,
      error: `Failed to update node: ${updateErr?.message ?? "unknown error"}`,
    };
  }
  // Deadline, type and importance all move the score — resize now, not at
  // the next unrelated event.
  if (
    options?.recompute !== false &&
    ("target_date" in patch || "manual_weight" in patch || "node_type" in patch)
  ) {
    await recomputeScores(ctx);
  }
  return {
    accepted: true,
    node_id: updated.id,
    title: updated.title,
    node_type: updated.node_type,
    importance_index: updated.importance_index,
    updated_fields: Object.keys(patch).filter((k) => k !== "updated_at"),
  };
}

// Every AI-driven status change runs the SAME transition as the Details
// button (status-transition.ts): cascades, planner sync, habit semantics,
// lifecycle + feedback events.
export function changeNodeStatus(
  ctx: ChangeContext,
  nodeId: string,
  newStatus: NodeStatus,
  options?: { recomputeScores?: boolean; habitSource?: "chat" | "dump" },
) {
  return transitionNodeStatus({
    supabase: ctx.supabase,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    nodeId,
    newStatus,
    // The user's local day (bd_tz cookie → chat route). UTC only as a fallback.
    today: ctx.today ?? localDateISO(new Date(), null),
    habitSource: options?.habitSource ?? "chat",
    recomputeScores: options?.recomputeScores,
  });
}

// ---------------------------------------------------------------------------
// applyChangeSet
// Creates the new nodes first (so any op can point at them by local_ref no
// matter where it was listed), links them to their parents, then runs the rest
// in order. Reports one outcome per op; a failed op never stops the others.
// ---------------------------------------------------------------------------

export async function applyChangeSet(
  ctx: ChangeContext,
  ops: ChangeOp[],
  options?: { source?: "chat" | "dump" },
): Promise<ChangeSetOutcome> {
  const source = options?.source ?? "chat";
  const results: OpResult[] = new Array<OpResult>(ops.length);
  const created: CreatedNode[] = [];
  const localRefToId = new Map<string, string>();
  // A node id as given: a local_ref from this set, or a UUID.
  const resolveRef = (value: unknown): string =>
    typeof value === "string" && value.length > 0 ? (localRefToId.get(value) ?? value) : "";
  const rootId = workspaceRootOnce(ctx);
  let scoresStale = false;
  let anchoredAtRoot = false;

  // Pass 1 — create every new node.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op?.kind !== "create_node") continue;
    const title = typeof op.title === "string" ? op.title.trim().slice(0, 120) : "";
    if (!title) {
      results[i] = { kind: "create_node", ok: false, error: "title required" };
      continue;
    }
    const nodeType = toolNodeType(op.node_type);
    if (!isValidNodeType(nodeType)) {
      results[i] = { kind: "create_node", ok: false, error: `invalid node_type "${op.node_type}"` };
      continue;
    }
    const targetDate =
      typeof op.target_date === "string" && ISO_DATE.test(op.target_date) ? op.target_date : null;
    const summary =
      typeof op.summary === "string" && op.summary.trim() ? op.summary.trim().slice(0, 2000) : null;
    const { data: node, error: nodeErr } = await ctx.supabase
      .from("nodes")
      .insert(
        newNodeRow({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          title,
          nodeType,
          summary,
          body: typeof op.body === "string" && op.body.trim() ? op.body.trim().slice(0, 400) : null,
          targetDate,
          importanceIndex:
            typeof op.importance_index === "number"
              ? Math.max(0, Math.min(100, Math.round(op.importance_index)))
              : DEFAULT_IMPORTANCE_INDEX,
        }),
      )
      .select("id")
      .single();
    if (nodeErr || !node) {
      results[i] = { kind: "create_node", ok: false, error: nodeErr?.message ?? "insert failed" };
      continue;
    }
    const nodeId = node.id as string;
    created.push({ index: i, id: nodeId, title, summary, node_type: nodeType, parentAttached: false });
    if (typeof op.local_ref === "string" && op.local_ref) localRefToId.set(op.local_ref, nodeId);
    if (targetDate) scoresStale = true;
  }

  // Pass 2 — parent links for the new nodes (root when none was given).
  for (const node of created) {
    const op = ops[node.index] as Extract<ChangeOp, { kind: "create_node" }>;
    const parentRef = resolveRef(op.parent_node_id) || resolveRef(op.parent_local_ref);
    let parentId: string | null = null;
    if (parentRef && parentRef !== node.id) {
      const parent = await fetchWorkspaceNode(ctx, parentRef);
      parentId = parent?.id ?? null;
    }
    node.parentAttached = await attachNewNode(ctx, node.id, parentId, rootId);
    if (!parentId) anchoredAtRoot = true;
    results[node.index] = {
      kind: "create_node",
      ok: true,
      id: node.id,
      ...(parentRef && !parentId
        ? { detail: "parent not found — placed under the workspace root" }
        : !node.parentAttached
          ? { detail: "created without a parent" }
          : {}),
    };
  }

  // Pass 3 — everything else, in the order given.
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (results[i]) continue;
    switch (op?.kind) {
      case "move": {
        const nodeId = resolveRef(op.node_id);
        const parentId = resolveRef(op.new_parent_node_id) || resolveRef(op.new_parent_local_ref);
        if (!nodeId || !parentId) {
          results[i] = { kind: "move", ok: false, error: "node_id and new_parent_node_id required" };
          break;
        }
        const moved = await moveNode(ctx, nodeId, parentId, null);
        if (!moved.accepted) {
          results[i] = { kind: "move", ok: false, error: String(moved.error ?? "move failed") };
          break;
        }
        if (moved.moved) scoresStale = true;
        results[i] = { kind: "move", ok: true, id: nodeId, detail: String(moved.message ?? "") };
        break;
      }

      case "update": {
        const nodeId = resolveRef(op.node_id);
        const updated = await updateNodeFields(
          {
            node_id: nodeId,
            ...(typeof op.title === "string" ? { title: op.title } : {}),
            ...(typeof op.node_type === "string" ? { node_type: op.node_type } : {}),
            ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
            // Until 2026-09-30 a deadline or body on a batch "update" was
            // dropped without a word and the op still reported success.
            ...(typeof op.target_date === "string" ? { target_date: op.target_date } : {}),
            ...(typeof op.body === "string" ? { body: op.body } : {}),
          },
          ctx,
          { recompute: false },
        );
        if (updated.accepted !== true) {
          results[i] = { kind: "update", ok: false, error: String(updated.error ?? "update failed") };
          break;
        }
        if (typeof op.node_type === "string" || typeof op.target_date === "string") scoresStale = true;
        results[i] = { kind: "update", ok: true, id: nodeId };
        break;
      }

      case "create_edge": {
        const sourceId = resolveRef(op.source_node_id);
        const targetId = resolveRef(op.target_node_id);
        const edgeType = typeof op.edge_type === "string" ? op.edge_type.toLowerCase() : "";
        if (!sourceId || !targetId || !VALID_EDGE_TYPES.has(edgeType)) {
          results[i] = { kind: "create_edge", ok: false, error: "source, target, and valid edge_type required" };
          break;
        }
        if (sourceId === targetId) {
          results[i] = { kind: "create_edge", ok: false, error: "source and target must differ" };
          break;
        }
        const explanation =
          typeof op.explanation === "string" && op.explanation.trim()
            ? op.explanation.trim().slice(0, 1000)
            : null;
        if (isHierarchyEdgeType(edgeType)) {
          const { childId, parentId } = hierarchyPair(edgeType, sourceId, targetId);
          const moved = await moveNode(ctx, childId, parentId, explanation);
          if (!moved.accepted) {
            results[i] = { kind: "create_edge", ok: false, error: String(moved.error ?? "move failed") };
            break;
          }
          if (moved.moved) scoresStale = true;
          results[i] = { kind: "create_edge", ok: true, detail: String(moved.message ?? "") };
          break;
        }
        // Both nodes must belong to this user + workspace.
        const { data: pair } = await ctx.supabase
          .from("nodes")
          .select("id")
          .in("id", [sourceId, targetId])
          .eq("user_id", ctx.userId)
          .eq("workspace_id", ctx.workspaceId);
        if (!pair || pair.length < 2) {
          results[i] = { kind: "create_edge", ok: false, error: "one or both nodes not in this workspace" };
          break;
        }
        const linked = await createLateralEdge(ctx, sourceId, targetId, edgeType, explanation);
        results[i] = linked.ok
          ? { kind: "create_edge", ok: true, id: linked.edgeId }
          : { kind: "create_edge", ok: false, error: linked.error };
        break;
      }

      case "complete":
      case "archive": {
        const nodeId = resolveRef(op.node_id);
        if (!nodeId) {
          results[i] = { kind: op.kind, ok: false, error: "node_id required" };
          break;
        }
        // Scores are recomputed ONCE after the loop.
        const outcome = await changeNodeStatus(
          ctx,
          nodeId,
          op.kind === "complete" ? "completed" : "archived",
          { recomputeScores: false, habitSource: source },
        );
        if (outcome.kind === "error") {
          results[i] = {
            kind: op.kind,
            ok: false,
            error: outcome.httpStatus === 404 ? "node not in this workspace" : outcome.error,
          };
          break;
        }
        if (outcome.kind === "changed") scoresStale = true;
        results[i] = {
          kind: op.kind,
          ok: true,
          id: nodeId,
          ...(outcome.kind === "habit_logged" ? { detail: "habit_logged" } : {}),
        };
        break;
      }

      default:
        results[i] = {
          kind: String((op as { kind?: unknown } | null)?.kind ?? "unknown"),
          ok: false,
          error: "unknown change kind",
        };
    }
  }

  if (created.length === 0) {
    // One score recompute for the whole set (each op skipped its own).
    if (scoresStale) await recomputeScores(ctx);
    return { results, created };
  }

  // Intake for the new nodes — the same an accepted dump proposal gets.
  const scope = { supabase: ctx.supabase, userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [, feedback] = await Promise.all([
    embedNewNodes(scope, created),
    ctx.supabase.from("feedback_events").insert(
      created.map((node) => ({
        user_id: ctx.userId,
        workspace_id: ctx.workspaceId,
        event_type: "accept_node",
        entity_type: "node",
        entity_id: node.id,
        metadata: { source, node_type: node.node_type },
      })),
    ),
  ]);
  if (feedback.error) console.warn("[change-set] accept feedback not saved:", feedback.error.message);

  const settle = async () => {
    try {
      // Its rescore covers the other ops in the set too.
      await judgeAndRescore(scope, created, ctx.today);
      // Grouping suggestions are only ever made for top-level nodes.
      if (anchoredAtRoot) await runClusteringPass(scope);
    } catch (err) {
      console.warn("[change-set] intake follow-up failed:", err);
    }
  };
  if (ctx.defer) {
    // The reply doesn't wait for the judgment; moves, deadlines and
    // completions in the same set still resize now.
    if (scoresStale) await recomputeScores(ctx);
    ctx.defer(settle);
  } else {
    await settle();
  }

  return { results, created };
}
