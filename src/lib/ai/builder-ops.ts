// The builder's output as a change set (docs/unified-turn.md).
//
// The builder (prompts/extract*.ts) answers in the extraction schema: new
// nodes with parent / dependency / soft-link refs, completions, and — since
// extract-v25 — `changes` to existing nodes (move / update / link). These pure
// functions turn that into the ops lib/graph/change-set.ts applies, so a
// capture from chat and a restructure asked for in a dump are written by the
// same code as every other AI change.

import type { BuilderChange, ExtractionOutput } from "@/types/ai";
import type { ChangeOp } from "@/lib/graph/change-set";

import { normalizeEditRequests } from "./validation";

export type BuilderNode = ExtractionOutput["proposed_nodes"][number];

const UUID = /^[0-9a-fA-F-]{36}$/;

// After duplicates are dropped, point every ref in `changes` at what survived:
// a proposal dropped as a copy of an EXISTING node → that node; dropped as a
// copy of another proposal → the kept one. A change whose node or target is
// gone (not in the workspace, filtered out) is dropped.
//
// A move whose new parent can't be found breaks the PLAN for that node: on a
// long dump the full prompt has moved a node under "n11" without ever
// proposing n11 (live eval 2026-09-30, twice). Applying the rest — the rename
// to "Test BrainDump" with no project and no "Market BrainDump" — would leave
// the graph worse than before, so every edit to such a node is dropped and the
// node is reported in `broken` for the caller to ask about.
export function resolveBuilderChanges(params: {
  changes: BuilderChange[];
  activeNodeIds: ReadonlySet<string>;
  survivingRefs: ReadonlySet<string>;
  droppedRefToExistingId: ReadonlyMap<string, string>;
  droppedRefToKeptRef: ReadonlyMap<string, string>;
}): { changes: BuilderChange[]; broken: string[] } {
  const resolve = (ref: string): string | null => {
    if (UUID.test(ref)) return params.activeNodeIds.has(ref) ? ref : null;
    const existing = params.droppedRefToExistingId.get(ref);
    if (existing) return existing;
    const kept = params.droppedRefToKeptRef.get(ref) ?? ref;
    return params.survivingRefs.has(kept) ? kept : null;
  };

  const out: BuilderChange[] = [];
  const moved = new Set<string>();
  const linked = new Set<string>();
  const broken = new Set<string>();
  for (const change of params.changes) {
    if (change.kind === "move") {
      if (!params.activeNodeIds.has(change.node_id)) continue;
      const parent = resolve(change.new_parent);
      if (!parent) {
        broken.add(change.node_id);
        continue;
      }
      // One parent per node: the first move of a node wins.
      if (parent === change.node_id || moved.has(change.node_id)) continue;
      moved.add(change.node_id);
      out.push({ ...change, new_parent: parent });
    } else if (change.kind === "update") {
      if (params.activeNodeIds.has(change.node_id)) out.push(change);
    } else {
      const source = resolve(change.source);
      const target = resolve(change.target);
      if (!source || !target || source === target) continue;
      const key = `${source}>${target}>${change.edge_type}`;
      if (linked.has(key)) continue;
      linked.add(key);
      out.push({ ...change, source, target });
    }
  }
  return {
    changes: out.filter((change) => change.kind === "link" || !broken.has(change.node_id)),
    broken: [...broken],
  };
}

// The edit pass's output folded into the main pass's (extraction.ts). On a
// long dump the long prompt only QUOTES the requests to reorganize existing
// nodes; the short prompt then carries them out, and its result — the edits
// plus the new nodes they need — joins the rest here.
//   • its local refs get a prefix, so "n1" from one pass can't be mistaken
//     for "n1" from the other;
//   • its nodes go FIRST: when both passes created the same thing, the
//     deduplication keeps the earlier one — the one the edits point at.
const EDIT_REF_PREFIX = "e_";
const MAX_MERGED_QUESTIONS = 3;

// The edit_requests array read from the builder's output while it is still
// streaming. extract-v26 writes it first, so the edit pass can start seconds
// before the rest of the JSON is in (extraction.ts). null until the array is
// complete — or when the output holds no such array.
export function readStreamedEditRequests(partial: string): string[] | null {
  const key = partial.indexOf('"edit_requests"');
  if (key < 0) return null;
  const open = partial.indexOf("[", key);
  if (open < 0 || !/^"edit_requests"\s*:\s*$/.test(partial.slice(key, open))) return null;
  let inString = false;
  for (let i = open + 1; i < partial.length; i++) {
    const ch = partial[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "]") {
      try {
        return normalizeEditRequests(JSON.parse(partial.slice(open, i + 1)));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function mergeEditPass(main: ExtractionOutput, edit: ExtractionOutput): ExtractionOutput {
  const ref = (value: string) => (UUID.test(value) ? value : `${EDIT_REF_PREFIX}${value}`);
  const nodes = edit.proposed_nodes.map((node) => ({
    ...node,
    local_ref: node.local_ref ? ref(node.local_ref) : node.local_ref,
    primary_parent_local_ref: node.primary_parent_local_ref ? ref(node.primary_parent_local_ref) : null,
    depends_on_local_refs: (node.depends_on_local_refs ?? []).map(ref),
    soft_links: (node.soft_links ?? []).map((link) => ({ ...link, target_local_ref: ref(link.target_local_ref) })),
  }));
  const changes = edit.changes.map((change): BuilderChange => {
    if (change.kind === "move") return { ...change, new_parent: ref(change.new_parent) };
    if (change.kind === "link") return { ...change, source: ref(change.source), target: ref(change.target) };
    return change;
  });
  return {
    ...main,
    proposed_nodes: [...nodes, ...main.proposed_nodes],
    changes: [...changes, ...main.changes],
    edit_requests: [],
    // What the reorganization could not settle comes first.
    clarifying_questions: [...new Set([...edit.clarifying_questions, ...main.clarifying_questions])].slice(
      0,
      MAX_MERGED_QUESTIONS,
    ),
    complete_existing_node_ids: [
      ...new Set([...main.complete_existing_node_ids, ...edit.complete_existing_node_ids]),
    ],
    auto_complete_local_refs: [...main.auto_complete_local_refs, ...edit.auto_complete_local_refs.map(ref)],
  };
}

// A brain dump's new nodes go to the review (proposed_nodes); edits to
// existing nodes go on ONE card. A new node a move depends on has to be on
// that card too — "make BrainDump its own project and move Test under it"
// can't move anything under a proposal that was never accepted — and so does
// everything in the same new subtree, so no parent ref crosses the two.
export function splitRestructureSet(
  nodes: BuilderNode[],
  changes: BuilderChange[],
): { plain: BuilderNode[]; restructure: BuilderNode[] } {
  const byRef = new Map(nodes.flatMap((n) => (n.local_ref ? [[n.local_ref, n] as const] : [])));
  const neighbours = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  };
  for (const node of nodes) {
    const parent = node.primary_parent_local_ref;
    if (node.local_ref && parent && byRef.has(parent)) connect(node.local_ref, parent);
  }

  const inSet = new Set<string>();
  const queue = changes.flatMap((c) => (c.kind === "move" && byRef.has(c.new_parent) ? [c.new_parent] : []));
  while (queue.length > 0) {
    const ref = queue.pop()!;
    if (inSet.has(ref)) continue;
    inSet.add(ref);
    for (const next of neighbours.get(ref) ?? []) queue.push(next);
  }

  return {
    plain: nodes.filter((n) => !n.local_ref || !inSet.has(n.local_ref)),
    restructure: nodes.filter((n) => !!n.local_ref && inSet.has(n.local_ref)),
  };
}

// New nodes (with their parent, dependency and soft links), the edits to
// existing nodes, then completions — as change-set ops. A ref to a new node
// that isn't in `nodes` (it went to the review instead) drops that link.
export function builderToOps(params: {
  nodes: BuilderNode[];
  changes: BuilderChange[];
  completeExistingNodeIds?: string[];
  autoCompleteLocalRefs?: string[];
}): ChangeOp[] {
  const refs = new Set(params.nodes.flatMap((n) => (n.local_ref ? [n.local_ref] : [])));
  const known = (ref: string) => UUID.test(ref) || refs.has(ref);

  const creates: ChangeOp[] = params.nodes.map((node) => ({
    kind: "create_node",
    ...(node.local_ref ? { local_ref: node.local_ref } : {}),
    title: node.proposed_title,
    node_type: node.proposed_node_type,
    ...(node.proposed_summary ? { summary: node.proposed_summary } : {}),
    ...(node.proposed_body ? { body: node.proposed_body } : {}),
    ...(node.proposed_target_date ? { target_date: node.proposed_target_date } : {}),
    ...(node.primary_parent_local_ref && refs.has(node.primary_parent_local_ref)
      ? { parent_local_ref: node.primary_parent_local_ref }
      : node.existing_parent_node_id
        ? { parent_node_id: node.existing_parent_node_id }
        : {}),
  }));

  const edits: ChangeOp[] = [];
  const links: ChangeOp[] = [];
  for (const change of params.changes) {
    if (change.kind === "update") {
      edits.push({
        kind: "update",
        node_id: change.node_id,
        ...(change.title ? { title: change.title } : {}),
        ...(change.node_type ? { node_type: change.node_type } : {}),
        ...(change.summary ? { summary: change.summary } : {}),
      });
    } else if (change.kind === "move") {
      if (known(change.new_parent)) {
        edits.push({ kind: "move", node_id: change.node_id, new_parent_node_id: change.new_parent });
      }
    } else if (known(change.source) && known(change.target)) {
      links.push({
        kind: "create_edge",
        source_node_id: change.source,
        target_node_id: change.target,
        edge_type: change.edge_type,
        ...(change.rationale ? { explanation: change.rationale } : {}),
      });
    }
  }

  for (const node of params.nodes) {
    if (!node.local_ref) continue;
    for (const dependency of node.depends_on_local_refs ?? []) {
      if (!refs.has(dependency)) continue;
      links.push({
        kind: "create_edge",
        source_node_id: dependency,
        target_node_id: node.local_ref,
        edge_type: "required_for",
      });
    }
    for (const link of node.soft_links ?? []) {
      if (!refs.has(link.target_local_ref)) continue;
      links.push({
        kind: "create_edge",
        source_node_id: node.local_ref,
        target_node_id: link.target_local_ref,
        // The soft-link name for an order; chat's edges call it required_for.
        edge_type: link.edge_type === "prerequisite_for" ? "required_for" : link.edge_type,
        ...(link.rationale ? { explanation: link.rationale } : {}),
      });
    }
  }

  const completes: ChangeOp[] = [
    ...(params.completeExistingNodeIds ?? []).map((id): ChangeOp => ({ kind: "complete", node_id: id })),
    ...(params.autoCompleteLocalRefs ?? [])
      .filter((ref) => refs.has(ref))
      .map((ref): ChangeOp => ({ kind: "complete", node_id: ref })),
  ];

  return [...creates, ...edits, ...links, ...completes];
}
