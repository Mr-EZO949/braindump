// Mutation tools for the assistant agent loop (M2.3+).
// Calling one of these from Claude pauses the loop until the user accepts or
// rejects the proposed action via the inline card in the chat UI. The handler
// in this file only runs after the user Accepts — the resume endpoint is
// responsible for enforcing that.
//
// Each handler returns a JSON-serialisable payload that gets fed back to
// Claude as a tool_result so the model knows what the user chose and can
// continue the conversation coherently.

import { getWorkspaceRootId, setNodeParent } from "@/lib/graph/hierarchy";
import { mergeNodes } from "@/lib/graph/merge";
import { transitionNodeStatus } from "@/lib/graph/status-transition";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { localDateISO } from "@/lib/time/local-date";
import type { NodeStatus } from "@/types/graph";

import type { ToolContext, ToolDefinition } from "./read-only";
import { NODE_TYPES } from "@/lib/graph/node-types";

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

type ImportanceLabel = "low" | "medium" | "high" | "critical";

function importanceFromIndex(idx: number): ImportanceLabel {
  if (idx >= 80) return "critical";
  if (idx >= 60) return "high";
  if (idx >= 40) return "medium";
  return "low";
}

const VALID_NODE_TYPES: ReadonlySet<string> = new Set(NODE_TYPES);

// Tool-schema text for every node_type field — Haiku leans on the schema
// more than the system prompt when it fills a tool call ("pass the stats
// final" came back as a task with the bare "Node type" description).
const NODE_TYPE_FIELD_DESCRIPTION =
  "task = one sitting (email the prof, solve 5 problems). big_task = one piece of work over several sittings (write the thesis, build a site). project = several different parts. goal = a result to reach, ideally dated (pass an exam, land a job, hit a number). habit = repeats on a cadence. area = an ongoing part of life (Health, Career). class = a course. idea = might do, not committed. note = something to remember (a person, advice, a fact).";

// The model's node_type as a stored value: tolerate "Big task" / "big-task"
// and the retired "concept" (→ note), so an old habit doesn't fail the tool.
function toolNodeType(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return t === "concept" ? "note" : t;
}

// Edge types Claude is allowed to propose. Keeps the surface small and
// semantically meaningful — the inference pipeline uses a wider set, but
// user-facing proposals should stay legible.
const VALID_EDGE_TYPES = new Set([
  "belongs_to", // child → parent: MOVES the source under the target
  "contains", // parent → child: the same move, said from the parent's side
  "required_for", // dependency: source is required for target
  "supports", // source reinforces target
  "related_to", // loose lateral connection
  "useful_for", // source is useful for target
  "inspired_by", // source was inspired by target
]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

async function fetchWorkspaceNode(
  ctx: ToolContext,
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

// A node's parent is a belongs_to edge, child → parent (lib/graph/hierarchy.ts).
// "contains" is only the model's way of saying it from the parent's side.
const HIERARCHY_EDGE_TYPES: ReadonlySet<string> = new Set(["belongs_to", "contains"]);

function hierarchyPair(
  edgeType: string,
  sourceId: string,
  targetId: string,
): { childId: string; parentId: string } {
  return edgeType === "contains"
    ? { childId: targetId, parentId: sourceId }
    : { childId: sourceId, parentId: targetId };
}

// The workspace root, fetched at most once per tool call.
function workspaceRootOnce(ctx: ToolContext): () => Promise<string | null> {
  let cached: Promise<string | null> | null = null;
  return () =>
    (cached ??= getWorkspaceRootId({
      supabase: ctx.supabase,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }));
}

// Parent link for a node chat just created. No parent named → the workspace
// root, so a new node never floats until the connection engine guesses one.
async function attachNewNode(
  ctx: ToolContext,
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

async function recomputeScores(ctx: ToolContext): Promise<void> {
  await computeWorkspaceScores({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    supabase: ctx.supabase,
    today: ctx.today,
  }).catch((err: unknown) => {
    console.warn("[mutations] score recompute failed:", err);
  });
}

// Every chat-driven status change runs the SAME transition as the Details
// button (src/lib/graph/status-transition.ts): cascades, planner sync, habit
// semantics, lifecycle + feedback events. Returns a tool_result payload.
async function toolStatusTransition(
  ctx: ToolContext,
  nodeId: string,
  newStatus: NodeStatus,
  options?: { recomputeScores?: boolean },
): Promise<Record<string, unknown>> {
  const result = await transitionNodeStatus({
    supabase: ctx.supabase,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    nodeId,
    newStatus,
    // The user's local day (bd_tz cookie → chat route). UTC only as a fallback.
    today: ctx.today ?? localDateISO(new Date(), null),
    habitSource: "chat",
    recomputeScores: options?.recomputeScores,
  });
  switch (result.kind) {
    case "error":
      return {
        accepted: false,
        error: result.httpStatus === 404 ? "node_id not found in this workspace" : result.error,
      };
    case "habit_logged":
      // Habits recur: logged for today, the node stays active (#13).
      return { accepted: true, node_id: nodeId, habit_logged: true, logged_on: result.loggedOn };
    case "unchanged":
      return {
        accepted: true,
        node_id: nodeId,
        ...(newStatus === "completed" ? { already_completed: true } : {}),
        ...(newStatus === "archived" ? { already_archived: true } : {}),
      };
    case "changed":
      return {
        accepted: true,
        node_id: nodeId,
        previous_status: result.previousStatus,
        auto_completed_node_ids: result.autoCompletedNodeIds,
        newly_available: result.newlyAvailable,
      };
  }
}

// ---------------------------------------------------------------------------
// propose_node
// Creates a node (Accept-gated by the pause flow) under parent_node_id, or
// under the workspace root when none is given.
// ---------------------------------------------------------------------------

const PROPOSE_NODE: ToolDefinition = {
  schema: {
    name: "propose_node",
    description:
      "Propose adding a new node to the graph. The user will see an inline card showing the proposed node and must Accept before it's created. Use when the user asks to add, track, or capture a single item. For a batch of related items, prefer propose_nodes_batch.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, specific, actionable title (max 120 chars)",
        },
        summary: {
          type: "string",
          description:
            "One-sentence summary explaining what the node is and why it matters",
        },
        node_type: {
          type: "string",
          enum: [...NODE_TYPES],
          description: NODE_TYPE_FIELD_DESCRIPTION,
        },
        importance_index: {
          type: "integer",
          description:
            "0–100 importance score (default 50). Higher = more critical.",
          minimum: 0,
          maximum: 100,
        },
        parent_node_id: {
          type: "string",
          description:
            "UUID of the existing node this goes under — the most specific one that fits (a project, goal, big task or area). Leave out only for a new top-level branch; it then sits under the workspace root.",
        },
        target_date: {
          type: "string",
          description:
            "Optional ISO date (YYYY-MM-DD) deadline for this node. Use when the user mentions a specific date, day-of-week + month, or relative window like 'by Friday' / 'August 1' / 'end of Q3'. Resolve relative references against today. Goals or projects with deadlines surface in the Roadmap view.",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
        body: {
          type: "string",
          description:
            "Optional longer description (≤400 chars) answering: so what / why does this matter / what's the next concrete step. Distinct from summary, which only says 'what is this'. Skip when there's nothing to say beyond the summary.",
        },
      },
      required: ["title", "node_type"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      title?: string;
      summary?: string;
      node_type?: string;
      importance_index?: number;
      parent_node_id?: string;
      target_date?: string;
      body?: string;
    };

    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { accepted: false, error: "title is required" };
    if (title.length > 120) {
      return { accepted: false, error: "title must be 120 characters or fewer" };
    }

    const nodeType = toolNodeType(args.node_type);
    if (!VALID_NODE_TYPES.has(nodeType)) {
      return {
        accepted: false,
        error: `node_type must be one of ${Array.from(VALID_NODE_TYPES).join(", ")}`,
      };
    }

    const importanceIndex =
      typeof args.importance_index === "number"
        ? Math.max(0, Math.min(100, Math.round(args.importance_index)))
        : 50;
    const importance = importanceFromIndex(importanceIndex);

    const summary =
      typeof args.summary === "string" && args.summary.trim().length > 0
        ? args.summary.trim().slice(0, 2000)
        : null;

    let parentId: string | null = null;
    if (typeof args.parent_node_id === "string" && args.parent_node_id.length > 0) {
      const parent = await fetchWorkspaceNode(ctx, args.parent_node_id);
      if (!parent) {
        return {
          accepted: false,
          error: "parent_node_id not found in this workspace",
        };
      }
      parentId = parent.id;
    }

    // Validate ISO date if provided. Empty string treated as "not set".
    const targetDate =
      typeof args.target_date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(args.target_date)
        ? args.target_date
        : null;

    // Trim body to the soft 400-char cap. null when empty / not supplied.
    const body =
      typeof args.body === "string" && args.body.trim().length > 0
        ? args.body.trim().slice(0, 400)
        : null;

    const { data: node, error: nodeErr } = await ctx.supabase
      .from("nodes")
      .insert({
        user_id: ctx.userId,
        workspace_id: ctx.workspaceId,
        title,
        summary,
        body,
        node_type: nodeType,
        importance,
        importance_index: importanceIndex,
        status: "active",
        target_date: targetDate,
      })
      .select("id, title, node_type")
      .single();

    if (nodeErr || !node) {
      return {
        accepted: false,
        error: `Failed to create node: ${nodeErr?.message ?? "unknown error"}`,
      };
    }

    const edgeCreated = await attachNewNode(
      ctx,
      node.id as string,
      parentId,
      workspaceRootOnce(ctx),
    );

    return {
      accepted: true,
      node_id: node.id,
      title: node.title,
      node_type: node.node_type,
      parent_edge_created: edgeCreated,
    };
  },
};

// ---------------------------------------------------------------------------
// propose_nodes_batch
// Brain-dump bridge: accepts an array of node specs, creates them all after
// a single Accept. Optional parent_local_ref lets the model reference sibling
// items in the same batch for nesting without needing DB IDs.
// ---------------------------------------------------------------------------

const PROPOSE_NODES_BATCH: ToolDefinition = {
  schema: {
    name: "propose_nodes_batch",
    description:
      "Propose adding multiple related nodes at once. The user sees a single inline card summarising the batch and confirms once — all nodes (and optional parent edges) are created atomically. Use this when the user brain-dumps a cluster of related items, asks to break a goal into subtasks, or otherwise wants 2+ nodes from one message.",
    input_schema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              local_ref: {
                type: "string",
                description:
                  "Optional short ID used to reference this node as a parent for sibling items in the same batch (e.g. \"n1\"). Not persisted.",
              },
              title: { type: "string" },
              summary: { type: "string" },
              node_type: {
                type: "string",
                enum: [...NODE_TYPES],
                description: NODE_TYPE_FIELD_DESCRIPTION,
              },
              importance_index: { type: "integer", minimum: 0, maximum: 100 },
              parent_node_id: {
                type: "string",
                description:
                  "UUID of an existing workspace node to attach under. Give every node a parent (this or parent_local_ref) unless it is a new top-level branch.",
              },
              parent_local_ref: {
                type: "string",
                description:
                  "local_ref of an EARLIER item in this batch to attach under (list parents first). Ignored if parent_node_id is set.",
              },
              target_date: {
                type: "string",
                description:
                  "Optional ISO date deadline (YYYY-MM-DD). Goals/projects with deadlines surface in the Roadmap view.",
                pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              },
            },
            required: ["title", "node_type"],
          },
        },
      },
      required: ["nodes"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      nodes?: Array<{
        local_ref?: string;
        title?: string;
        summary?: string;
        node_type?: string;
        importance_index?: number;
        parent_node_id?: string;
        parent_local_ref?: string;
        target_date?: string;
      }>;
    };

    if (!Array.isArray(args.nodes) || args.nodes.length === 0) {
      return { accepted: false, error: "nodes must be a non-empty array" };
    }
    if (args.nodes.length > 30) {
      return { accepted: false, error: "max 30 nodes per batch" };
    }

    // Validate every item up front so we don't half-create the batch.
    const normalised = [] as Array<{
      local_ref: string | null;
      title: string;
      summary: string | null;
      node_type: string;
      importance: ImportanceLabel;
      importance_index: number;
      parent_node_id: string | null;
      parent_local_ref: string | null;
      target_date: string | null;
    }>;

    for (let i = 0; i < args.nodes.length; i++) {
      const n = args.nodes[i] ?? {};
      const title = typeof n.title === "string" ? n.title.trim() : "";
      if (!title) return { accepted: false, error: `nodes[${i}].title is required` };
      if (title.length > 120) {
        return { accepted: false, error: `nodes[${i}].title must be ≤120 chars` };
      }
      const nodeType = toolNodeType(n.node_type);
      if (!VALID_NODE_TYPES.has(nodeType)) {
        return {
          accepted: false,
          error: `nodes[${i}].node_type must be one of ${Array.from(VALID_NODE_TYPES).join(", ")}`,
        };
      }
      const importanceIndex =
        typeof n.importance_index === "number"
          ? Math.max(0, Math.min(100, Math.round(n.importance_index)))
          : 50;
      const summary =
        typeof n.summary === "string" && n.summary.trim().length > 0
          ? n.summary.trim().slice(0, 2000)
          : null;
      const targetDate =
        typeof n.target_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(n.target_date)
          ? n.target_date
          : null;
      normalised.push({
        local_ref: typeof n.local_ref === "string" ? n.local_ref : null,
        title,
        summary,
        node_type: nodeType,
        importance: importanceFromIndex(importanceIndex),
        importance_index: importanceIndex,
        parent_node_id:
          typeof n.parent_node_id === "string" && n.parent_node_id.length > 0
            ? n.parent_node_id
            : null,
        parent_local_ref:
          typeof n.parent_local_ref === "string" && n.parent_local_ref.length > 0
            ? n.parent_local_ref
            : null,
        target_date: targetDate,
      });
    }

    // Verify every external parent_node_id belongs to this workspace.
    const externalParents = Array.from(
      new Set(
        normalised
          .map((n) => n.parent_node_id)
          .filter((id): id is string => id !== null),
      ),
    );
    if (externalParents.length > 0) {
      const { data: parentRows } = await ctx.supabase
        .from("nodes")
        .select("id")
        .eq("user_id", ctx.userId)
        .eq("workspace_id", ctx.workspaceId)
        .in("id", externalParents);
      const found = new Set(
        (parentRows ?? []).map((r: { id: string }) => r.id as string),
      );
      const missing = externalParents.filter((id) => !found.has(id));
      if (missing.length > 0) {
        return {
          accepted: false,
          error: `parent_node_id not found in workspace: ${missing.join(", ")}`,
        };
      }
    }

    // Insert nodes one-by-one so we can map local_ref → real UUID for edges.
    // Brief enough for batches up to 30.
    const localRefToId = new Map<string, string>();
    const createdIds: string[] = [];
    const created: Array<{
      id: string;
      title: string;
      node_type: string;
      parent_edge_created: boolean;
    }> = [];
    const rootId = workspaceRootOnce(ctx);
    const deferred: Array<{ index: number; ref: string }> = [];

    for (const spec of normalised) {
      const { data: node, error: nodeErr } = await ctx.supabase
        .from("nodes")
        .insert({
          user_id: ctx.userId,
          workspace_id: ctx.workspaceId,
          title: spec.title,
          summary: spec.summary,
          node_type: spec.node_type,
          importance: spec.importance,
          importance_index: spec.importance_index,
          status: "active",
          target_date: spec.target_date,
        })
        .select("id, title, node_type")
        .single();
      if (nodeErr || !node) {
        return {
          accepted: false,
          error: `Failed to create "${spec.title}": ${nodeErr?.message ?? "unknown error"}`,
          created_so_far: createdIds,
        };
      }
      createdIds.push(node.id as string);
      if (spec.local_ref) localRefToId.set(spec.local_ref, node.id as string);

      const parentId =
        spec.parent_node_id ??
        (spec.parent_local_ref ? localRefToId.get(spec.parent_local_ref) ?? null : null);
      // A parent_local_ref that points at a LATER item resolves after the loop.
      const waitsForLaterParent = !parentId && spec.parent_local_ref !== null;
      const edgeCreated = waitsForLaterParent
        ? false
        : await attachNewNode(ctx, node.id as string, parentId, rootId);
      created.push({
        id: node.id as string,
        title: node.title as string,
        node_type: node.node_type as string,
        parent_edge_created: edgeCreated,
      });
      if (waitsForLaterParent) deferred.push({ index: created.length - 1, ref: spec.parent_local_ref! });
    }

    for (const { index, ref } of deferred) {
      const row = created[index];
      const parentId = localRefToId.get(ref) ?? null;
      row.parent_edge_created = await attachNewNode(
        ctx,
        row.id,
        parentId === row.id ? null : parentId,
        rootId,
      );
    }

    return { accepted: true, created };
  },
};

// ---------------------------------------------------------------------------
// Shared edge writers (propose_edge + propose_changes_batch)
// ---------------------------------------------------------------------------

// Moves a node under a new parent. The tool_result says where it came from so
// the model (or the no-model confirmation) can tell the user plainly.
async function moveNode(
  ctx: ToolContext,
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
async function createLateralEdge(
  ctx: ToolContext,
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

// ---------------------------------------------------------------------------
// propose_edge
// Links two existing nodes after Accept — or, for belongs_to / contains, moves
// the child under its new parent.
// ---------------------------------------------------------------------------

const PROPOSE_EDGE: ToolDefinition = {
  schema: {
    name: "propose_edge",
    description:
      "Connect two existing nodes, or MOVE one. belongs_to (source goes under target) and contains (target goes under source) MOVE the child: a node has one parent, so its current parent link is replaced automatically — this is how you re-parent or re-home a node. required_for is a dependency; supports / related_to / useful_for / inspired_by are lateral links that leave the tree alone. The user must Accept first.",
    input_schema: {
      type: "object",
      properties: {
        source_node_id: { type: "string", description: "UUID of the source node" },
        target_node_id: { type: "string", description: "UUID of the target node" },
        edge_type: {
          type: "string",
          enum: [
            "belongs_to",
            "contains",
            "required_for",
            "supports",
            "related_to",
            "useful_for",
            "inspired_by",
          ],
          description:
            "belongs_to = MOVE source under target (replaces source's current parent); contains = MOVE target under source; required_for = source must happen before target; supports = source helps target; useful_for = source is a skill/resource target benefits from; related_to / inspired_by = loose lateral links.",
        },
        explanation: {
          type: "string",
          description: "One-sentence rationale shown with the edge.",
        },
      },
      required: ["source_node_id", "target_node_id", "edge_type"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      source_node_id?: string;
      target_node_id?: string;
      edge_type?: string;
      explanation?: string;
    };
    const sourceId = typeof args.source_node_id === "string" ? args.source_node_id : "";
    const targetId = typeof args.target_node_id === "string" ? args.target_node_id : "";
    const edgeType =
      typeof args.edge_type === "string" ? args.edge_type.toLowerCase() : "";

    if (!sourceId || !targetId) {
      return { accepted: false, error: "source_node_id and target_node_id are required" };
    }
    if (sourceId === targetId) {
      return { accepted: false, error: "source and target must be different nodes" };
    }
    if (!VALID_EDGE_TYPES.has(edgeType)) {
      return {
        accepted: false,
        error: `edge_type must be one of ${Array.from(VALID_EDGE_TYPES).join(", ")}`,
      };
    }

    // Both nodes must live in this workspace.
    const { data: nodeRows } = await ctx.supabase
      .from("nodes")
      .select("id")
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId)
      .in("id", [sourceId, targetId]);
    const foundIds = new Set(
      (nodeRows ?? []).map((n: { id: string }) => n.id as string),
    );
    if (!foundIds.has(sourceId) || !foundIds.has(targetId)) {
      return { accepted: false, error: "source or target node not in this workspace" };
    }

    const explanation =
      typeof args.explanation === "string" && args.explanation.trim().length > 0
        ? args.explanation.trim().slice(0, 1000)
        : null;

    // Hierarchy = a move: the node's old parent link is replaced, not added to.
    if (HIERARCHY_EDGE_TYPES.has(edgeType)) {
      const { childId, parentId } = hierarchyPair(edgeType, sourceId, targetId);
      const moved = await moveNode(ctx, childId, parentId, explanation);
      if (moved.accepted && moved.moved) await recomputeScores(ctx);
      return moved;
    }

    const linked = await createLateralEdge(ctx, sourceId, targetId, edgeType, explanation);
    if (!linked.ok) return { accepted: false, error: `Failed to create edge: ${linked.error}` };
    return {
      accepted: true,
      edge_id: linked.edgeId,
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: edgeType,
      ...(linked.alreadyExisted ? { already_existed: true } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// update_node
// Patches title / summary / node_type / importance_index on an existing node.
// At least one field must be provided.
// ---------------------------------------------------------------------------

// Does this node hold steps or phases (the children that make a task a big task)?
async function hasWorkChildren(ctx: ToolContext, nodeId: string): Promise<boolean> {
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

// Shared by update_node and propose_changes_batch's "update" op (which
// recomputes scores once for the whole batch).
async function updateNodeFields(
  input: unknown,
  ctx: ToolContext,
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
    if (!VALID_NODE_TYPES.has(nt)) {
      return {
        accepted: false,
        error: `node_type must be one of ${Array.from(VALID_NODE_TYPES).join(", ")}`,
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
    patch.importance = importanceFromIndex(idx);
    patch.manual_weight = idx;
    patch.manual_weight_set_at = new Date().toISOString();
  }
  if (typeof args.target_date === "string") {
    const td = args.target_date.trim();
    if (td === "") {
      patch.target_date = null;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(td)) {
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

const UPDATE_NODE: ToolDefinition = {
  schema: {
    name: "update_node",
    description:
      "Edit an existing node's title, summary, type, body, or target_date deadline. Only supply the fields you want to change. importance_index pins a permanent manual importance (0–100) — only when the user names a number; for 'X matters more/less', stakes, focus or waiting use update_priorities. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "UUID of the node to update" },
        title: { type: "string", description: "New title (max 120 chars)" },
        summary: { type: "string", description: "New summary (set to empty string to clear)" },
        node_type: {
          type: "string",
          enum: [...NODE_TYPES],
          description: NODE_TYPE_FIELD_DESCRIPTION,
        },
        importance_index: { type: "integer", minimum: 0, maximum: 100 },
        target_date: {
          type: "string",
          description:
            "ISO date deadline (YYYY-MM-DD). Pass empty string to clear. Goals/projects with deadlines surface in the Roadmap view.",
        },
        body: {
          type: "string",
          description:
            "Long-form description (≤400 chars) answering: so what / why it matters / next step. Pass empty string to clear.",
        },
      },
      required: ["node_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => updateNodeFields(input, ctx),
};

// ---------------------------------------------------------------------------
// archive_node / complete_node
// Status transitions + lifecycle event + edge orphaning. Scoring recomputation
// is skipped (stale scores are acceptable short-term and can be refreshed via
// the existing /recompute endpoint).
// ---------------------------------------------------------------------------

const ARCHIVE_NODE: ToolDefinition = {
  schema: {
    name: "archive_node",
    description:
      "Archive a node (soft-remove it from the active graph). Use when the user says a node is obsolete, cancelled, or no longer relevant. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "UUID of the node to archive" },
      },
      required: ["node_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as { node_id?: string };
    const nodeId = typeof args.node_id === "string" ? args.node_id : "";
    if (!nodeId) return { accepted: false, error: "node_id is required" };
    // Same code path as the Details button (orphans edges, logs lifecycle +
    // feedback events) — see src/lib/graph/status-transition.ts.
    return toolStatusTransition(ctx, nodeId, "archived");
  },
};

const COMPLETE_NODE: ToolDefinition = {
  schema: {
    name: "complete_node",
    description:
      "Mark a node as completed. Use when the user says they finished, shipped, or closed out a task/project/goal. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "UUID of the node to complete" },
      },
      required: ["node_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as { node_id?: string };
    const nodeId = typeof args.node_id === "string" ? args.node_id : "";
    if (!nodeId) return { accepted: false, error: "node_id is required" };
    // Same code path as the Details button: subtree + prerequisite cascades,
    // planner sync, score recompute — and habits log the user's day instead of
    // completing (#13). Chat used to hand-roll a weaker copy of this.
    return toolStatusTransition(ctx, nodeId, "completed");
  },
};

// ---------------------------------------------------------------------------
// propose_merge
// Collapse a duplicate node into a canonical (kept) one. Edges move from the
// duplicate to the canonical; the duplicate is archived. Same logic the
// merge-suggestion UI runs, exposed for chat-driven merges ("merge X into Y",
// "X is a duplicate of Y", "combine these").
// ---------------------------------------------------------------------------

const PROPOSE_MERGE: ToolDefinition = {
  schema: {
    name: "propose_merge",
    description:
      "Propose merging a duplicate node into a canonical (kept) node. Use when the user says \"merge X into Y\", identifies one node as a duplicate of another, or asks to combine two nodes. All active edges on the duplicate are re-pointed to the canonical, then the duplicate is archived. The user must Accept before the merge runs.",
    input_schema: {
      type: "object",
      properties: {
        canonical_node_id: {
          type: "string",
          description: "UUID of the node to KEEP (the canonical).",
        },
        duplicate_node_id: {
          type: "string",
          description:
            "UUID of the node to ARCHIVE (the duplicate). Its edges are moved to the canonical first.",
        },
      },
      required: ["canonical_node_id", "duplicate_node_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      canonical_node_id?: string;
      duplicate_node_id?: string;
    };
    if (
      typeof args.canonical_node_id !== "string" ||
      typeof args.duplicate_node_id !== "string" ||
      !args.canonical_node_id ||
      !args.duplicate_node_id
    ) {
      return {
        accepted: false,
        error: "canonical_node_id and duplicate_node_id are required",
      };
    }
    if (args.canonical_node_id === args.duplicate_node_id) {
      return {
        accepted: false,
        error: "canonical and duplicate must be different nodes",
      };
    }

    const result = await mergeNodes(
      ctx.supabase,
      ctx.userId,
      args.duplicate_node_id, // the absorbed source
      args.canonical_node_id, // the kept target
    );

    if (!result.ok) {
      return { accepted: false, error: result.error };
    }
    return {
      accepted: true,
      kept_node_id: result.kept_node_id,
      archived_node_id: result.archived_node_id,
      edges_moved: result.edges_moved,
      edges_skipped: result.edges_skipped,
    };
  },
};

// ---------------------------------------------------------------------------
// propose_changes_batch
// One Accept for a list of mixed changes — including a whole restructure:
// "make BrainDump its own project and put testing and marketing under it" is
// create_node + move + update + create_node in ONE card. The handler creates
// the new nodes first (so later ops can point at them by local_ref), then
// runs the rest in order and reports a per-op outcome.
// ---------------------------------------------------------------------------

type BatchChange =
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

const BATCH_KINDS = ["create_node", "move", "update", "create_edge", "complete", "archive"] as const;

const NODE_REF_DESCRIPTION =
  "UUID of an existing node, or the local_ref of a node created by a create_node in this batch.";

const PROPOSE_CHANGES_BATCH: ToolDefinition = {
  schema: {
    name: "propose_changes_batch",
    description:
      "Propose several graph changes under ONE Accept. Use it for any ask that needs more than one change — and for every RESTRUCTURE (regroup, split, re-parent, 'make X its own project with A and B under it'): put the new nodes, the moves and the renames in one batch so the user confirms once and the tree ends up right. New nodes can be referenced by later ops through local_ref. For several new related NODES and nothing else, prefer propose_nodes_batch.",
    input_schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [...BATCH_KINDS],
                description:
                  "create_node = new node (give it a parent and, if later ops refer to it, a local_ref). move = put an EXISTING node under a new parent (its old parent link is replaced). update = rename / retype / re-summarise an existing node. create_edge = lateral or dependency link between two nodes (belongs_to / contains here also mean move). complete = mark done. archive = soft-remove.",
              },
              // create_node fields
              local_ref: {
                type: "string",
                description:
                  'create_node only: a short id ("p1") other ops in this batch use to refer to the new node.',
              },
              title: { type: "string", description: "create_node: the title. update: the new title." },
              node_type: {
                type: "string",
                enum: [...NODE_TYPES],
                description: NODE_TYPE_FIELD_DESCRIPTION,
              },
              summary: { type: "string" },
              parent_node_id: {
                type: "string",
                description: `create_node only: where the new node goes. ${NODE_REF_DESCRIPTION}`,
              },
              target_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              importance_index: { type: "integer", minimum: 0, maximum: 100 },
              body: { type: "string" },
              // move fields
              new_parent_node_id: {
                type: "string",
                description: `move only: the node's new parent. ${NODE_REF_DESCRIPTION}`,
              },
              // create_edge fields
              source_node_id: { type: "string", description: NODE_REF_DESCRIPTION },
              target_node_id: { type: "string", description: NODE_REF_DESCRIPTION },
              edge_type: {
                type: "string",
                enum: [...VALID_EDGE_TYPES],
                description:
                  "required_for = source must happen before target; supports = source helps target; useful_for = source is a skill/resource target benefits from; related_to / inspired_by = loose links. belongs_to / contains move the child (same as kind move).",
              },
              explanation: { type: "string", description: "create_edge: one-sentence why." },
              // move / update / complete / archive
              node_id: {
                type: "string",
                description: `move / update / complete / archive: the node to act on. ${NODE_REF_DESCRIPTION}`,
              },
            },
            required: ["kind"],
          },
        },
      },
      required: ["changes"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as { changes?: BatchChange[] };
    if (!Array.isArray(args.changes) || args.changes.length === 0) {
      return { accepted: false, error: "changes must be a non-empty array" };
    }
    const changes = args.changes;

    type OpResult =
      | { kind: string; ok: true; id?: string; detail?: string }
      | { kind: string; ok: false; error: string };
    const results: OpResult[] = new Array<OpResult>(changes.length);
    const localRefToId = new Map<string, string>();
    // A node id as the model gave it: a local_ref from this batch, or a UUID.
    const resolveRef = (value: unknown): string =>
      typeof value === "string" && value.length > 0 ? (localRefToId.get(value) ?? value) : "";
    const rootId = workspaceRootOnce(ctx);
    let scoresStale = false;

    // Pass 1 — create every new node, so any op can refer to it by local_ref
    // no matter where the model listed it.
    const createdAt = new Map<number, string>();
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change?.kind !== "create_node") continue;
      const title = typeof change.title === "string" ? change.title.trim().slice(0, 120) : "";
      if (!title) {
        results[i] = { kind: "create_node", ok: false, error: "title required" };
        continue;
      }
      const nodeType = toolNodeType(change.node_type);
      if (!VALID_NODE_TYPES.has(nodeType)) {
        results[i] = {
          kind: "create_node",
          ok: false,
          error: `invalid node_type "${change.node_type}"`,
        };
        continue;
      }
      const importanceIndex =
        typeof change.importance_index === "number"
          ? Math.max(0, Math.min(100, Math.round(change.importance_index)))
          : 50;
      const targetDate =
        typeof change.target_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(change.target_date)
          ? change.target_date
          : null;
      const summary =
        typeof change.summary === "string" && change.summary.trim()
          ? change.summary.trim().slice(0, 2000)
          : null;
      const body =
        typeof change.body === "string" && change.body.trim()
          ? change.body.trim().slice(0, 400)
          : null;
      const { data: node, error: nodeErr } = await ctx.supabase
        .from("nodes")
        .insert({
          user_id: ctx.userId,
          workspace_id: ctx.workspaceId,
          title,
          summary,
          body,
          node_type: nodeType,
          importance: importanceFromIndex(importanceIndex),
          importance_index: importanceIndex,
          status: "active",
          target_date: targetDate,
        })
        .select("id")
        .single();
      if (nodeErr || !node) {
        results[i] = { kind: "create_node", ok: false, error: nodeErr?.message ?? "insert failed" };
        continue;
      }
      createdAt.set(i, node.id as string);
      if (typeof change.local_ref === "string" && change.local_ref) {
        localRefToId.set(change.local_ref, node.id as string);
      }
      if (targetDate) scoresStale = true;
    }

    // Pass 2 — parent links for the new nodes (root when none was given).
    for (const [i, nodeId] of createdAt) {
      const change = changes[i] as Extract<BatchChange, { kind: "create_node" }>;
      const parentRef = resolveRef(change.parent_node_id) || resolveRef(change.parent_local_ref);
      let parentId: string | null = null;
      if (parentRef && parentRef !== nodeId) {
        const parent = await fetchWorkspaceNode(ctx, parentRef);
        parentId = parent?.id ?? null;
      }
      const attached = await attachNewNode(ctx, nodeId, parentId, rootId);
      results[i] = {
        kind: "create_node",
        ok: true,
        id: nodeId,
        ...(parentRef && !parentId
          ? { detail: "parent not found — placed under the workspace root" }
          : !attached
            ? { detail: "created without a parent" }
            : {}),
      };
    }

    // Pass 3 — everything else, in the order given.
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (results[i]) continue;
      switch (change?.kind) {
        case "move": {
          const nodeId = resolveRef(change.node_id);
          const parentId =
            resolveRef(change.new_parent_node_id) || resolveRef(change.new_parent_local_ref);
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
          const nodeId = resolveRef(change.node_id);
          const updated = await updateNodeFields(
            {
              node_id: nodeId,
              ...(typeof change.title === "string" ? { title: change.title } : {}),
              ...(typeof change.node_type === "string" ? { node_type: change.node_type } : {}),
              ...(typeof change.summary === "string" ? { summary: change.summary } : {}),
            },
            ctx,
            { recompute: false },
          );
          if (updated.accepted !== true) {
            results[i] = { kind: "update", ok: false, error: String(updated.error ?? "update failed") };
            break;
          }
          if (typeof change.node_type === "string") scoresStale = true;
          results[i] = { kind: "update", ok: true, id: nodeId };
          break;
        }

        case "create_edge": {
          const sourceId = resolveRef(change.source_node_id);
          const targetId = resolveRef(change.target_node_id);
          const edgeType = typeof change.edge_type === "string" ? change.edge_type.toLowerCase() : "";
          if (!sourceId || !targetId || !VALID_EDGE_TYPES.has(edgeType)) {
            results[i] = {
              kind: "create_edge",
              ok: false,
              error: "source, target, and valid edge_type required",
            };
            break;
          }
          if (sourceId === targetId) {
            results[i] = { kind: "create_edge", ok: false, error: "source and target must differ" };
            break;
          }
          const explanation =
            typeof change.explanation === "string" && change.explanation.trim()
              ? change.explanation.trim().slice(0, 1000)
              : null;
          if (HIERARCHY_EDGE_TYPES.has(edgeType)) {
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
            results[i] = {
              kind: "create_edge",
              ok: false,
              error: "one or both nodes not in this workspace",
            };
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
          const nodeId = resolveRef(change.node_id);
          if (!nodeId) {
            results[i] = { kind: change.kind, ok: false, error: "node_id required" };
            break;
          }
          // The same transition the Details button runs (cascades, planner
          // sync, habit semantics). Scores are recomputed ONCE after the loop.
          const outcome = await transitionNodeStatus({
            supabase: ctx.supabase,
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            nodeId,
            newStatus: change.kind === "complete" ? "completed" : "archived",
            today: ctx.today ?? localDateISO(new Date(), null),
            habitSource: "chat",
            recomputeScores: false,
          });
          if (outcome.kind === "error") {
            results[i] = {
              kind: change.kind,
              ok: false,
              error: outcome.httpStatus === 404 ? "node not in this workspace" : outcome.error,
            };
            break;
          }
          if (outcome.kind === "changed") scoresStale = true;
          results[i] = {
            kind: change.kind,
            ok: true,
            id: nodeId,
            ...(outcome.kind === "habit_logged" ? { detail: "habit_logged" } : {}),
          };
          break;
        }

        default:
          results[i] = {
            kind: String((change as { kind?: unknown } | null)?.kind ?? "unknown"),
            ok: false,
            error: "unknown change kind",
          };
      }
    }

    // One score recompute for the whole batch (each op skipped its own).
    if (scoresStale) await recomputeScores(ctx);

    const okCount = results.filter((r) => r.ok).length;
    const failedCount = results.length - okCount;
    return {
      accepted: okCount > 0,
      applied: okCount,
      total: results.length,
      results,
      // A partial failure goes back to the model (actionSucceeded reads
      // `error`) so it can say what didn't land instead of a bare "Done".
      ...(failedCount > 0
        ? { error: `${failedCount} of ${results.length} changes failed — see results` }
        : { message: okCount === 1 ? "Done ✓" : `Applied ${okCount} changes ✓` }),
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MUTATION_TOOLS: ToolDefinition[] = [
  PROPOSE_NODE,
  PROPOSE_NODES_BATCH,
  PROPOSE_CHANGES_BATCH,
  PROPOSE_EDGE,
  PROPOSE_MERGE,
  UPDATE_NODE,
  ARCHIVE_NODE,
  COMPLETE_NODE,
];
