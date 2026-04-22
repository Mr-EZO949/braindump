// Mutation tools for the assistant agent loop (M2.3+).
// Calling one of these from Claude pauses the loop until the user accepts or
// rejects the proposed action via the inline card in the chat UI. The handler
// in this file only runs after the user Accepts — the resume endpoint is
// responsible for enforcing that.
//
// Each handler returns a JSON-serialisable payload that gets fed back to
// Claude as a tool_result so the model knows what the user chose and can
// continue the conversation coherently.

import type { ToolContext, ToolDefinition } from "./read-only";

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

const VALID_NODE_TYPES = new Set([
  "goal",
  "project",
  "task",
  "concept",
  "class",
  "habit",
]);

// Edge types Claude is allowed to propose. Keeps the surface small and
// semantically meaningful — the inference pipeline uses a wider set, but
// user-facing proposals should stay legible.
const VALID_EDGE_TYPES = new Set([
  "belongs_to", // child → parent hierarchy (respects single-parent unique index)
  "contains", // parent → child; mirror of belongs_to
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
): Promise<{ id: string; status: string | null } | null> {
  const { data } = await ctx.supabase
    .from("nodes")
    .select("id, status")
    .eq("id", nodeId)
    .eq("user_id", ctx.userId)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  return (data as { id: string; status: string | null } | null) ?? null;
}

async function logLifecycleEvent(
  ctx: ToolContext,
  params: { node_id: string; previous_status: string; new_status: string },
): Promise<void> {
  // Append-only; failures are not fatal for the mutation — the user's action
  // succeeded, we just lost the audit trail for this step.
  const { error } = await ctx.supabase.from("lifecycle_events").insert({
    node_id: params.node_id,
    user_id: ctx.userId,
    previous_status: params.previous_status,
    new_status: params.new_status,
    cascade_triggered: false,
  });
  if (error) {
    console.warn("[mutations] failed to log lifecycle_event:", error.message);
  }
}

async function orphanEdgesForNode(ctx: ToolContext, nodeId: string): Promise<void> {
  // Mirrors the status-route behaviour: when a node becomes non-active, its
  // currently-active edges transition to 'orphaned' so the UI hides them.
  // Run both sides in parallel.
  await Promise.all([
    ctx.supabase
      .from("edges")
      .update({ status: "orphaned" })
      .eq("user_id", ctx.userId)
      .eq("source_node_id", nodeId)
      .eq("status", "active"),
    ctx.supabase
      .from("edges")
      .update({ status: "orphaned" })
      .eq("user_id", ctx.userId)
      .eq("target_node_id", nodeId)
      .eq("status", "active"),
  ]);
}

// ---------------------------------------------------------------------------
// propose_node
// Creates a node (Accept-gated by the pause flow). With a parent_node_id,
// also wires a `contains` edge parent→child.
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
          enum: ["goal", "project", "task", "concept", "class", "habit"],
          description: "Node type",
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
            "Optional parent node UUID. If provided, a contains edge is created from parent to the new node.",
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
    };

    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { accepted: false, error: "title is required" };
    if (title.length > 120) {
      return { accepted: false, error: "title must be 120 characters or fewer" };
    }

    const nodeType =
      typeof args.node_type === "string" ? args.node_type.toLowerCase() : "";
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

    const { data: node, error: nodeErr } = await ctx.supabase
      .from("nodes")
      .insert({
        user_id: ctx.userId,
        workspace_id: ctx.workspaceId,
        title,
        summary,
        node_type: nodeType,
        importance,
        importance_index: importanceIndex,
        status: "active",
      })
      .select("id, title, node_type")
      .single();

    if (nodeErr || !node) {
      return {
        accepted: false,
        error: `Failed to create node: ${nodeErr?.message ?? "unknown error"}`,
      };
    }

    let edgeCreated = false;
    if (parentId) {
      const { error: edgeErr } = await ctx.supabase.from("edges").insert({
        user_id: ctx.userId,
        workspace_id: ctx.workspaceId,
        source_node_id: parentId,
        target_node_id: node.id,
        edge_type: "contains",
        status: "active",
      });
      edgeCreated = !edgeErr;
    }

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
                enum: ["goal", "project", "task", "concept", "class", "habit"],
              },
              importance_index: { type: "integer", minimum: 0, maximum: 100 },
              parent_node_id: {
                type: "string",
                description: "UUID of an existing workspace node to attach under.",
              },
              parent_local_ref: {
                type: "string",
                description:
                  "local_ref of another item in this batch to attach under. Ignored if parent_node_id is set.",
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
    }>;

    for (let i = 0; i < args.nodes.length; i++) {
      const n = args.nodes[i] ?? {};
      const title = typeof n.title === "string" ? n.title.trim() : "";
      if (!title) return { accepted: false, error: `nodes[${i}].title is required` };
      if (title.length > 120) {
        return { accepted: false, error: `nodes[${i}].title must be ≤120 chars` };
      }
      const nodeType =
        typeof n.node_type === "string" ? n.node_type.toLowerCase() : "";
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

      let edgeCreated = false;
      const parentId =
        spec.parent_node_id ??
        (spec.parent_local_ref ? localRefToId.get(spec.parent_local_ref) ?? null : null);
      if (parentId) {
        const { error: edgeErr } = await ctx.supabase.from("edges").insert({
          user_id: ctx.userId,
          workspace_id: ctx.workspaceId,
          source_node_id: parentId,
          target_node_id: node.id,
          edge_type: "contains",
          status: "active",
        });
        edgeCreated = !edgeErr;
      }
      created.push({
        id: node.id as string,
        title: node.title as string,
        node_type: node.node_type as string,
        parent_edge_created: edgeCreated,
      });
    }

    return { accepted: true, created };
  },
};

// ---------------------------------------------------------------------------
// propose_edge
// Creates an edge between two existing nodes after Accept.
// ---------------------------------------------------------------------------

const PROPOSE_EDGE: ToolDefinition = {
  schema: {
    name: "propose_edge",
    description:
      "Propose connecting two existing nodes with an edge. Use for hierarchy (belongs_to / contains), dependency (required_for), or lateral links (supports, related_to, useful_for, inspired_by). The user must Accept before the edge is created.",
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
            "Relationship direction: belongs_to = source is a child of target; contains = source is a parent of target; required_for = source must happen before target; supports / related_to / useful_for / inspired_by are lateral.",
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

    // De-dup: if an active edge of this type already exists, call it a success.
    const { data: existing } = await ctx.supabase
      .from("edges")
      .select("id")
      .eq("user_id", ctx.userId)
      .eq("source_node_id", sourceId)
      .eq("target_node_id", targetId)
      .eq("edge_type", edgeType)
      .eq("status", "active")
      .maybeSingle();
    if (existing) {
      return {
        accepted: true,
        edge_id: existing.id as string,
        already_existed: true,
      };
    }

    const explanation =
      typeof args.explanation === "string" && args.explanation.trim().length > 0
        ? args.explanation.trim().slice(0, 1000)
        : null;

    const { data: edge, error: edgeErr } = await ctx.supabase
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

    if (edgeErr || !edge) {
      // Single-parent constraint on belongs_to shows up here — surface a
      // readable message rather than leaking the raw Postgres error.
      const msg = edgeErr?.message ?? "unknown error";
      const friendlier = msg.includes("unique") && edgeType === "belongs_to"
        ? "This node already has a parent. Move or remove the existing parent first."
        : msg;
      return { accepted: false, error: `Failed to create edge: ${friendlier}` };
    }

    return {
      accepted: true,
      edge_id: edge.id,
      source_node_id: sourceId,
      target_node_id: targetId,
      edge_type: edgeType,
    };
  },
};

// ---------------------------------------------------------------------------
// update_node
// Patches title / summary / node_type / importance_index on an existing node.
// At least one field must be provided.
// ---------------------------------------------------------------------------

const UPDATE_NODE: ToolDefinition = {
  schema: {
    name: "update_node",
    description:
      "Edit an existing node's title, summary, type, or importance. Only supply the fields you want to change. Requires Accept.",
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "UUID of the node to update" },
        title: { type: "string", description: "New title (max 120 chars)" },
        summary: { type: "string", description: "New summary (set to empty string to clear)" },
        node_type: {
          type: "string",
          enum: ["goal", "project", "task", "concept", "class", "habit"],
        },
        importance_index: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["node_id"],
    },
  },
  handler: async (input, ctx: ToolContext) => {
    const args = (input ?? {}) as {
      node_id?: string;
      title?: string;
      summary?: string;
      node_type?: string;
      importance_index?: number;
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
      const nt = args.node_type.toLowerCase();
      if (!VALID_NODE_TYPES.has(nt)) {
        return {
          accepted: false,
          error: `node_type must be one of ${Array.from(VALID_NODE_TYPES).join(", ")}`,
        };
      }
      patch.node_type = nt;
    }
    if (typeof args.importance_index === "number") {
      const idx = Math.max(0, Math.min(100, Math.round(args.importance_index)));
      patch.importance_index = idx;
      patch.importance = importanceFromIndex(idx);
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
    return {
      accepted: true,
      node_id: updated.id,
      title: updated.title,
      node_type: updated.node_type,
      importance_index: updated.importance_index,
      updated_fields: Object.keys(patch).filter((k) => k !== "updated_at"),
    };
  },
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

    const target = await fetchWorkspaceNode(ctx, nodeId);
    if (!target) {
      return { accepted: false, error: "node_id not found in this workspace" };
    }
    if (target.status === "archived") {
      return { accepted: true, node_id: nodeId, already_archived: true };
    }

    const previousStatus = target.status ?? "active";
    const { error } = await ctx.supabase
      .from("nodes")
      .update({
        status: "archived",
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", nodeId)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) {
      return { accepted: false, error: `Failed to archive: ${error.message}` };
    }

    await orphanEdgesForNode(ctx, nodeId);
    await logLifecycleEvent(ctx, {
      node_id: nodeId,
      previous_status: previousStatus,
      new_status: "archived",
    });

    return { accepted: true, node_id: nodeId, previous_status: previousStatus };
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

    const target = await fetchWorkspaceNode(ctx, nodeId);
    if (!target) {
      return { accepted: false, error: "node_id not found in this workspace" };
    }
    if (target.status === "completed") {
      return { accepted: true, node_id: nodeId, already_completed: true };
    }
    if (target.status === "archived") {
      return {
        accepted: false,
        error: "Cannot complete an archived node. Reactivate it first.",
      };
    }

    const previousStatus = target.status ?? "active";
    const { error } = await ctx.supabase
      .from("nodes")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", nodeId)
      .eq("user_id", ctx.userId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) {
      return { accepted: false, error: `Failed to complete: ${error.message}` };
    }

    await orphanEdgesForNode(ctx, nodeId);
    await logLifecycleEvent(ctx, {
      node_id: nodeId,
      previous_status: previousStatus,
      new_status: "completed",
    });

    return { accepted: true, node_id: nodeId, previous_status: previousStatus };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MUTATION_TOOLS: ToolDefinition[] = [
  PROPOSE_NODE,
  PROPOSE_NODES_BATCH,
  PROPOSE_EDGE,
  UPDATE_NODE,
  ARCHIVE_NODE,
  COMPLETE_NODE,
];
