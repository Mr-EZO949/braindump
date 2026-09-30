// Mutation tools for the assistant agent loop (M2.3+).
// Calling one of these from Claude pauses the loop until the user accepts or
// rejects the proposed action via the inline card in the chat UI. The handler
// in this file only runs after the user Accepts — the resume endpoint is
// responsible for enforcing that.
//
// Each handler returns a JSON-serialisable payload that gets fed back to
// Claude as a tool_result so the model knows what the user chose and can
// continue the conversation coherently.
//
// The tools are the model-facing surface only. What they write goes through
// lib/graph/change-set.ts — the one writer of AI graph changes — so a node is
// the same object whichever tool created it.

import {
  CHANGE_KINDS,
  VALID_EDGE_TYPES,
  applyChangeSet,
  changeNodeStatus,
  createLateralEdge,
  fetchWorkspaceNode,
  hierarchyPair,
  isHierarchyEdgeType,
  isValidNodeType,
  moveNode,
  recomputeScores,
  toolNodeType,
  updateNodeFields,
  type ChangeOp,
} from "@/lib/graph/change-set";
import { mergeNodes } from "@/lib/graph/merge";
import type { NodeStatus } from "@/types/graph";

import type { ToolContext, ToolDefinition } from "./read-only";
import { NODE_TYPES } from "@/lib/graph/node-types";

// Tool-schema text for every node_type field — Haiku leans on the schema
// more than the system prompt when it fills a tool call ("pass the stats
// final" came back as a task with the bare "Node type" description).
const NODE_TYPE_FIELD_DESCRIPTION =
  "task = one sitting (email the prof, solve 5 problems). big_task = one piece of work over several sittings (write the thesis, build a site). project = several different parts. goal = a result to reach, ideally dated (pass an exam, land a job, hit a number). habit = repeats on a cadence. area = an ongoing part of life (Health, Career). class = a course. idea = might do, not committed. note = something to remember (a person, advice, a fact).";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A chat-driven status change as a tool_result payload.
async function toolStatusTransition(
  ctx: ToolContext,
  nodeId: string,
  newStatus: NodeStatus,
): Promise<Record<string, unknown>> {
  const result = await changeNodeStatus(ctx, nodeId, newStatus);
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
    if (!isValidNodeType(nodeType)) {
      return {
        accepted: false,
        error: `node_type must be one of ${NODE_TYPES.join(", ")}`,
      };
    }

    const parentRef =
      typeof args.parent_node_id === "string" && args.parent_node_id.length > 0
        ? args.parent_node_id
        : null;
    if (parentRef && !(await fetchWorkspaceNode(ctx, parentRef))) {
      return {
        accepted: false,
        error: "parent_node_id not found in this workspace",
      };
    }

    const { results, created } = await applyChangeSet(ctx, [
      {
        kind: "create_node",
        title,
        node_type: nodeType,
        summary: args.summary,
        body: args.body,
        importance_index: args.importance_index,
        target_date: args.target_date,
        ...(parentRef ? { parent_node_id: parentRef } : {}),
      },
    ]);
    const node = created[0];
    if (!node) {
      const failure = results[0];
      return {
        accepted: false,
        error: `Failed to create node: ${failure && !failure.ok ? failure.error : "unknown error"}`,
      };
    }

    return {
      accepted: true,
      node_id: node.id,
      title: node.title,
      node_type: node.node_type,
      parent_edge_created: node.parentAttached,
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
    const ops: ChangeOp[] = [];
    for (let i = 0; i < args.nodes.length; i++) {
      const n = args.nodes[i] ?? {};
      const title = typeof n.title === "string" ? n.title.trim() : "";
      if (!title) return { accepted: false, error: `nodes[${i}].title is required` };
      if (title.length > 120) {
        return { accepted: false, error: `nodes[${i}].title must be ≤120 chars` };
      }
      const nodeType = toolNodeType(n.node_type);
      if (!isValidNodeType(nodeType)) {
        return {
          accepted: false,
          error: `nodes[${i}].node_type must be one of ${NODE_TYPES.join(", ")}`,
        };
      }
      ops.push({
        kind: "create_node",
        title,
        node_type: nodeType,
        summary: n.summary,
        importance_index: n.importance_index,
        ...(typeof n.local_ref === "string" && n.local_ref ? { local_ref: n.local_ref } : {}),
        ...(typeof n.parent_node_id === "string" && n.parent_node_id.length > 0
          ? { parent_node_id: n.parent_node_id }
          : {}),
        // Resolved after every node exists, so a parent listed later works.
        ...(typeof n.parent_local_ref === "string" && n.parent_local_ref.length > 0
          ? { parent_local_ref: n.parent_local_ref }
          : {}),
        ...(typeof n.target_date === "string" && ISO_DATE.test(n.target_date)
          ? { target_date: n.target_date }
          : {}),
      });
    }

    // Verify every external parent_node_id belongs to this workspace.
    const localRefs = new Set(
      ops.flatMap((op) => (op.kind === "create_node" && op.local_ref ? [op.local_ref] : [])),
    );
    const externalParents = Array.from(
      new Set(
        ops.flatMap((op) =>
          op.kind === "create_node" && op.parent_node_id && !localRefs.has(op.parent_node_id)
            ? [op.parent_node_id]
            : [],
        ),
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

    const outcome = await applyChangeSet(ctx, ops);
    const created = outcome.created.map((node) => ({
      id: node.id,
      title: node.title,
      node_type: node.node_type,
      parent_edge_created: node.parentAttached,
    }));
    const failed = outcome.results.flatMap((result, i) =>
      result.ok ? [] : [`"${(ops[i] as { title: string }).title}": ${result.error}`],
    );
    if (failed.length > 0) {
      return {
        accepted: created.length > 0,
        created,
        error: `Failed to create ${failed.join("; ")}`,
      };
    }

    return { accepted: true, created };
  },
};

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
    if (isHierarchyEdgeType(edgeType)) {
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
// create_node + move + update + create_node in ONE card. The input IS a change
// set: applyChangeSet creates the new nodes first (so later ops can point at
// them by local_ref), then runs the rest in order and reports a per-op outcome.
// ---------------------------------------------------------------------------

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
                enum: [...CHANGE_KINDS],
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
    const args = (input ?? {}) as { changes?: ChangeOp[] };
    if (!Array.isArray(args.changes) || args.changes.length === 0) {
      return { accepted: false, error: "changes must be a non-empty array" };
    }

    const { results } = await applyChangeSet(ctx, args.changes);

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
