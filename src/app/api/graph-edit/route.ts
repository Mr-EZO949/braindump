// POST /api/graph-edit
// Executes graph mutations from assistant-generated <graph_edit> blocks.
// Operations: move (reparent), remove_edge, rename, archive.
// Resolves node titles to IDs within the workspace scope.

import { NextRequest, NextResponse } from "next/server";
import { computeWorkspaceScores } from "@/lib/ai/scoring";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { GraphEditOperation } from "@/types/graph";

interface OpResult {
  op: string;
  success: boolean;
  error?: string;
  node?: string;
}

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as {
    workspace_id: string;
    operations: GraphEditOperation[];
  };

  const { workspace_id, operations } = body;
  if (!workspace_id || !Array.isArray(operations) || operations.length === 0) {
    return NextResponse.json({ error: "workspace_id and operations required" }, { status: 400 });
  }

  // Build title → id map for this workspace
  const { data: nodes } = await supabase
    .from("nodes")
    .select("id, title, status")
    .eq("workspace_id", workspace_id)
    .eq("user_id", user.id);

  if (!nodes) {
    return NextResponse.json({ error: "Failed to fetch nodes" }, { status: 500 });
  }

  // Map lowercase title → node(s) for case-insensitive lookup
  const titleMap = new Map<string, Array<{ id: string; title: string; status: string | null }>>();
  for (const n of nodes) {
    const key = (n.title as string).toLowerCase();
    const list = titleMap.get(key) ?? [];
    list.push({ id: n.id as string, title: n.title as string, status: n.status as string | null });
    titleMap.set(key, list);
  }

  function resolveTitle(title: string): { id: string } | { error: string } {
    const matches = titleMap.get(title.toLowerCase());
    if (!matches || matches.length === 0) return { error: `Node "${title}" not found` };
    // Prefer non-archived
    const active = matches.filter((m) => m.status !== "archived");
    if (active.length === 1) return { id: active[0].id };
    if (active.length > 1) return { id: active[0].id }; // take first match
    return { id: matches[0].id };
  }

  const results: OpResult[] = [];
  const nowIso = new Date().toISOString();

  for (const op of operations) {
    try {
      switch (op.op) {
        case "move": {
          const nodeRes = resolveTitle(op.node);
          const parentRes = resolveTitle(op.new_parent);
          if ("error" in nodeRes) { results.push({ op: "move", success: false, error: nodeRes.error, node: op.node }); break; }
          if ("error" in parentRes) { results.push({ op: "move", success: false, error: parentRes.error, node: op.new_parent }); break; }

          // Orphan existing belongs_to edge
          await supabase
            .from("edges")
            .update({ status: "orphaned", updated_at: nowIso })
            .eq("user_id", user.id)
            .eq("source_node_id", nodeRes.id)
            .eq("edge_type", "belongs_to")
            .neq("status", "orphaned")
            .neq("status", "user_rejected");

          // Create new belongs_to edge
          const { error: insertErr } = await supabase.from("edges").insert({
            user_id: user.id,
            workspace_id,
            source_node_id: nodeRes.id,
            target_node_id: parentRes.id,
            edge_type: "belongs_to",
            status: "active",
            user_confirmed: true,
          });

          if (insertErr) {
            results.push({ op: "move", success: false, error: insertErr.message, node: op.node });
          } else {
            results.push({ op: "move", success: true, node: op.node });
          }
          break;
        }

        case "remove_edge": {
          const srcRes = resolveTitle(op.source);
          const tgtRes = resolveTitle(op.target);
          if ("error" in srcRes) { results.push({ op: "remove_edge", success: false, error: srcRes.error, node: op.source }); break; }
          if ("error" in tgtRes) { results.push({ op: "remove_edge", success: false, error: tgtRes.error, node: op.target }); break; }

          // Check both directions
          let query = supabase
            .from("edges")
            .update({ status: "orphaned", updated_at: nowIso })
            .eq("user_id", user.id)
            .neq("status", "orphaned")
            .or(
              `and(source_node_id.eq.${srcRes.id},target_node_id.eq.${tgtRes.id}),and(source_node_id.eq.${tgtRes.id},target_node_id.eq.${srcRes.id})`
            );

          if (op.edge_type) {
            query = query.eq("edge_type", op.edge_type);
          }

          const { error: removeErr } = await query;
          if (removeErr) {
            results.push({ op: "remove_edge", success: false, error: removeErr.message });
          } else {
            results.push({ op: "remove_edge", success: true });
          }
          break;
        }

        case "rename": {
          const nodeRes = resolveTitle(op.node);
          if ("error" in nodeRes) { results.push({ op: "rename", success: false, error: nodeRes.error, node: op.node }); break; }

          const { error: renameErr } = await supabase
            .from("nodes")
            .update({ title: op.new_title, updated_at: nowIso })
            .eq("id", nodeRes.id)
            .eq("user_id", user.id);

          if (renameErr) {
            results.push({ op: "rename", success: false, error: renameErr.message, node: op.node });
          } else {
            results.push({ op: "rename", success: true, node: op.node });
          }
          break;
        }

        case "insert_between": {
          const intermediateRes = resolveTitle(op.intermediate);
          const childRes = resolveTitle(op.child);
          if ("error" in intermediateRes) {
            results.push({ op: "insert_between", success: false, error: intermediateRes.error, node: op.intermediate });
            break;
          }
          if ("error" in childRes) {
            results.push({ op: "insert_between", success: false, error: childRes.error, node: op.child });
            break;
          }
          if (intermediateRes.id === childRes.id) {
            results.push({ op: "insert_between", success: false, error: "intermediate and child must be different nodes", node: op.intermediate });
            break;
          }

          // Look up child's current parent — that becomes intermediate's
          // new parent. If child has no belongs_to (orphan), we anchor
          // intermediate to the workspace root instead.
          const { data: currentParentRow } = await supabase
            .from("edges")
            .select("target_node_id")
            .eq("user_id", user.id)
            .eq("source_node_id", childRes.id)
            .eq("edge_type", "belongs_to")
            .eq("status", "active")
            .maybeSingle();

          let intermediateParentId: string | null =
            (currentParentRow?.target_node_id as string | null) ?? null;
          if (!intermediateParentId) {
            const { data: wsRow } = await supabase
              .from("workspaces")
              .select("bootstrap_root_node_id")
              .eq("id", workspace_id)
              .eq("user_id", user.id)
              .maybeSingle();
            intermediateParentId = (wsRow?.bootstrap_root_node_id as string | null) ?? null;
          }

          // Cycle guard: intermediate's chosen parent can't be a descendant
          // of intermediate itself, else we'd create a cycle (e.g. inserting
          // a parent-node between two of its own descendants).
          if (intermediateParentId === intermediateRes.id) {
            results.push({ op: "insert_between", success: false, error: "intermediate cannot be its own parent", node: op.intermediate });
            break;
          }

          // Step 1: re-parent intermediate to child's current parent.
          await supabase
            .from("edges")
            .update({ status: "orphaned", updated_at: nowIso })
            .eq("user_id", user.id)
            .eq("source_node_id", intermediateRes.id)
            .eq("edge_type", "belongs_to")
            .neq("status", "orphaned")
            .neq("status", "user_rejected");

          if (intermediateParentId) {
            const { error: interInsertErr } = await supabase.from("edges").insert({
              user_id: user.id,
              workspace_id,
              source_node_id: intermediateRes.id,
              target_node_id: intermediateParentId,
              edge_type: "belongs_to",
              status: "active",
              user_confirmed: true,
            });
            if (interInsertErr) {
              results.push({ op: "insert_between", success: false, error: `intermediate parent insert failed: ${interInsertErr.message}`, node: op.intermediate });
              break;
            }
          }

          // Step 2: re-parent child to intermediate.
          await supabase
            .from("edges")
            .update({ status: "orphaned", updated_at: nowIso })
            .eq("user_id", user.id)
            .eq("source_node_id", childRes.id)
            .eq("edge_type", "belongs_to")
            .neq("status", "orphaned")
            .neq("status", "user_rejected");

          const { error: childInsertErr } = await supabase.from("edges").insert({
            user_id: user.id,
            workspace_id,
            source_node_id: childRes.id,
            target_node_id: intermediateRes.id,
            edge_type: "belongs_to",
            status: "active",
            user_confirmed: true,
          });

          if (childInsertErr) {
            results.push({ op: "insert_between", success: false, error: `child parent insert failed: ${childInsertErr.message}`, node: op.child });
          } else {
            results.push({ op: "insert_between", success: true, node: op.child });
          }
          break;
        }

        case "archive": {
          const nodeRes = resolveTitle(op.node);
          if ("error" in nodeRes) { results.push({ op: "archive", success: false, error: nodeRes.error, node: op.node }); break; }

          // Archive node
          await supabase
            .from("nodes")
            .update({ status: "archived", archived_at: nowIso, updated_at: nowIso })
            .eq("id", nodeRes.id)
            .eq("user_id", user.id);

          // Orphan connected edges
          await supabase
            .from("edges")
            .update({ status: "orphaned", updated_at: nowIso })
            .eq("user_id", user.id)
            .or(`source_node_id.eq.${nodeRes.id},target_node_id.eq.${nodeRes.id}`);

          results.push({ op: "archive", success: true, node: op.node });
          break;
        }

        default:
          results.push({ op: (op as { op: string }).op, success: false, error: "Unknown operation" });
      }
    } catch (err) {
      results.push({
        op: op.op,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // Recompute scores once after all operations
  await computeWorkspaceScores({ workspaceId: workspace_id, userId: user.id, supabase }).catch(() => {});

  // Return refreshed graph data
  const [{ data: updatedNodes }, { data: updatedEdges }] = await Promise.all([
    supabase.from("nodes").select("*").eq("workspace_id", workspace_id).eq("user_id", user.id),
    supabase.from("edges").select("*").eq("workspace_id", workspace_id).eq("user_id", user.id),
  ]);

  return NextResponse.json({
    results,
    updated_nodes: updatedNodes ?? [],
    updated_edges: updatedEdges ?? [],
  });
}
