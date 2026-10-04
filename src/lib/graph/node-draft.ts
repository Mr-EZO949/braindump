// The create/edit node sheet's draft: defaults, a draft from a node, and the
// rows the sheet writes (moved out of AppShell, 2026-10-04).

import { getImportanceIndex, getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { NODE_TYPES, normalizeNodeType } from "@/lib/graph/node-types";
import type { CreateNodeInput, Node, NodeType } from "@/types/graph";

export const defaultCreateNodeDraft: CreateNodeInput = {
  custom_type: "",
  importance_index: 58,
  manual_weight: null,
  node_type: "task",
  raw_text: "",
  summary: "",
  body: "",
  title: "",
  target_date: "",
};

// Every current type opens in the sheet as itself; a legacy value (e.g. an
// old "concept" row) opens as its v2 equivalent.
const baseEditableNodeTypes = new Set<CreateNodeInput["node_type"]>(NODE_TYPES);

export function createDraftFromNode(node: Node): CreateNodeInput {
  const resolvedType = normalizeNodeType(node.node_type.toLowerCase(), node.node_type as NodeType);
  const nodeType = baseEditableNodeTypes.has(resolvedType as CreateNodeInput["node_type"])
    ? (resolvedType as Exclude<CreateNodeInput["node_type"], "custom">)
    : "custom";

  return {
    custom_type: nodeType === "custom" ? node.node_type : "",
    importance_index: getImportanceIndex(node),
    manual_weight: typeof node.manual_weight === "number" ? node.manual_weight : null,
    node_type: nodeType,
    raw_text: node.raw_text ?? "",
    summary: node.summary ?? "",
    body: node.body ?? "",
    title: node.title,
    target_date: typeof node.target_date === "string" ? node.target_date : "",
  };
}

/** The draft's title and type, or the message the sheet shows instead. */
export function checkNodeDraft(
  draft: CreateNodeInput,
): { ok: true; title: string; nodeType: string } | { ok: false; error: string } {
  const title = draft.title.trim();
  const nodeType = draft.node_type === "custom" ? draft.custom_type.trim() : draft.node_type;
  if (title.length === 0) return { ok: false, error: "Title is required." };
  if (nodeType.length === 0) return { ok: false, error: "Choose a node type or enter a custom type." };
  return { ok: true, title, nodeType };
}

/** A YYYY-MM-DD deadline from the draft, else null. */
export function draftTargetDate(draft: CreateNodeInput): string | null {
  const trimmed = draft.target_date.trim();
  return trimmed.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function draftColor(draft: CreateNodeInput): string {
  return draft.node_type === "custom" ? NODE_COLOR_BY_TYPE.note : NODE_COLOR_BY_TYPE[draft.node_type];
}

/** The `nodes` row the create sheet inserts. */
export function newNodeRow(
  draft: CreateNodeInput,
  checked: { title: string; nodeType: string },
  scope: { userId: string; workspaceId: string },
) {
  return {
    color: draftColor(draft),
    importance: getImportanceLabel(draft.importance_index),
    importance_index: draft.importance_index,
    node_type: checked.nodeType as Node["node_type"],
    raw_text: draft.raw_text.trim() || null,
    summary: draft.summary.trim() || null,
    body: draft.body.trim() || null,
    title: checked.title,
    target_date: draftTargetDate(draft),
    user_id: scope.userId,
    workspace_id: scope.workspaceId,
  };
}

/** The `nodes` update the edit sheet writes. `now` is read per timestamp field. */
export function editedNodeFields(
  draft: CreateNodeInput,
  checked: { title: string; nodeType: string },
  now: () => string = () => new Date().toISOString(),
) {
  return {
    color: draftColor(draft),
    importance: getImportanceLabel(draft.importance_index),
    importance_index: draft.importance_index,
    manual_weight: draft.manual_weight,
    manual_weight_set_at: draft.manual_weight == null ? null : now(),
    node_type: checked.nodeType as Node["node_type"],
    summary: draft.summary.trim() || null,
    body: draft.body.trim() || null,
    target_date: draftTargetDate(draft),
    title: checked.title,
    updated_at: now(),
  };
}
