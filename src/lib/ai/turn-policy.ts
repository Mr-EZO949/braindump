// One policy for what a turn's change set does next (docs/unified-turn.md):
// an op is either applied at once — and can be undone — or waits for the user
// on the card. The same rule whichever box the words were typed in.
//
//   apply now   completions · a new node this user reliably accepts
//               (auto-apply.ts decides which) · a link between nodes that are
//               there
//   wait        move · rename / retype · archive · a new node the calibration
//               holds back · everything that belongs to a reorganization
//
// A reorganization is reviewed as ONE unit: the new parent it moves things
// under, that parent's other new children, and the links to the nodes it
// touches all wait with the moves — never an empty new project sitting in the
// graph while the user is still deciding.
//
// Pure functions; the routes do the reading and writing.

import type { ChangeOp } from "@/lib/graph/change-set";

const UUID = /^[0-9a-fA-F-]{36}$/;

type CreateOp = Extract<ChangeOp, { kind: "create_node" }>;

function createRef(op: ChangeOp): string | null {
  return op.kind === "create_node" && typeof op.local_ref === "string" && op.local_ref ? op.local_ref : null;
}

// A copy of an op without some of its fields.
function without<T extends object, K extends keyof T>(op: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...op };
  for (const key of keys) delete copy[key];
  return copy;
}

function moveTarget(op: Extract<ChangeOp, { kind: "move" }>): string {
  return op.new_parent_local_ref ?? op.new_parent_node_id ?? "";
}

export function splitByPolicy(
  ops: ChangeOp[],
  // local_refs of new nodes cleared to apply without asking.
  autoCreateRefs: ReadonlySet<string>,
): { now: ChangeOp[]; ask: ChangeOp[] } {
  const creates = new Map<string, CreateOp>();
  for (const op of ops) {
    const ref = createRef(op);
    if (ref) creates.set(ref, op as CreateOp);
  }

  // New nodes that wait: held by the calibration, or the parent of a move.
  const askRefs = new Set<string>();
  // Existing nodes an edit touches.
  const editedIds = new Set<string>();
  for (const [ref] of creates) if (!autoCreateRefs.has(ref)) askRefs.add(ref);
  for (const op of ops) {
    if (op.kind === "move") {
      editedIds.add(op.node_id);
      const target = moveTarget(op);
      if (creates.has(target)) askRefs.add(target);
    } else if (op.kind === "update" || op.kind === "archive") {
      editedIds.add(op.node_id);
    }
  }
  // A new node under a waiting new node waits too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [ref, op] of creates) {
      if (askRefs.has(ref)) continue;
      const parent = op.parent_local_ref ?? op.parent_node_id ?? "";
      if (askRefs.has(parent)) {
        askRefs.add(ref);
        grew = true;
      }
    }
  }

  const waits = (ref: string | undefined) => !!ref && (askRefs.has(ref) || editedIds.has(ref));
  const now: ChangeOp[] = [];
  const ask: ChangeOp[] = [];
  for (const op of ops) {
    let wait: boolean;
    switch (op.kind) {
      case "create_node":
        // No local_ref → nothing can vouch for it.
        wait = !createRef(op) || askRefs.has(createRef(op)!);
        break;
      case "create_edge":
        wait = waits(op.source_node_id) || waits(op.target_node_id);
        break;
      case "complete":
        wait = askRefs.has(op.node_id);
        break;
      default:
        wait = true;
    }
    (wait ? ask : now).push(op);
  }
  return { now, ask };
}

// After the first half is applied, its new nodes have real ids: point the
// waiting ops at them, so the set that waits stands on its own.
export function resolveRefs(ops: ChangeOp[], refToId: ReadonlyMap<string, string>): ChangeOp[] {
  const id = (ref: string | undefined) => (ref ? refToId.get(ref) : undefined);
  return ops.map((op): ChangeOp => {
    switch (op.kind) {
      case "create_node": {
        const parentId = id(op.parent_local_ref);
        if (!parentId) return op;
        return { ...without(op, "parent_local_ref"), parent_node_id: parentId };
      }
      case "move": {
        const parentId = id(op.new_parent_local_ref) ?? id(op.new_parent_node_id);
        if (!parentId) return op;
        return { ...without(op, "new_parent_local_ref"), new_parent_node_id: parentId };
      }
      case "create_edge":
        return {
          ...op,
          source_node_id: id(op.source_node_id) ?? op.source_node_id,
          target_node_id: id(op.target_node_id) ?? op.target_node_id,
        };
      case "update":
      case "complete":
      case "archive":
        return { ...op, node_id: id(op.node_id) ?? op.node_id };
    }
  });
}

// The ops the user kept, out of the ones on the card (by position). What
// depended on a skipped new node is handled the way the user would expect:
//   • a new node that was going under it goes one level up instead — to the
//     skipped node's own parent (the root when it had none);
//   • a move under it, a link to it, a completion of it are dropped.
export function selectOps(ops: ChangeOp[], acceptedIndexes: readonly number[]): ChangeOp[] {
  return resolveSelection(ops, acceptedIndexes).kept;
}

// Rows the user ticked that cannot happen without a row they skipped — the
// card shows them as unavailable instead of letting them fail quietly.
export function blockedBySkips(ops: ChangeOp[], acceptedIndexes: readonly number[]): number[] {
  return resolveSelection(ops, acceptedIndexes).blocked;
}

// The card's rows as they would land with this selection: a new node whose
// new parent was unticked shows where it goes instead.
export function previewSelection(ops: ChangeOp[], acceptedIndexes: readonly number[]): ChangeOp[] {
  return resolveSelection(ops, acceptedIndexes).shown;
}

function resolveSelection(
  ops: ChangeOp[],
  acceptedIndexes: readonly number[],
): { kept: ChangeOp[]; blocked: number[]; shown: ChangeOp[] } {
  const accepted = new Set(acceptedIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < ops.length));
  const skipped = new Map<string, CreateOp>();
  ops.forEach((op, index) => {
    const ref = createRef(op);
    if (ref && !accepted.has(index)) skipped.set(ref, op as CreateOp);
  });
  const gone = (ref: string | undefined) => !!ref && skipped.has(ref);

  // Where a node lands when the new parent it was meant for was skipped.
  const homeAbove = (ref: string): Pick<CreateOp, "parent_node_id" | "parent_local_ref"> => {
    const seen = new Set<string>();
    let current: CreateOp | undefined = skipped.get(ref);
    while (current) {
      if (current.parent_node_id && UUID.test(current.parent_node_id)) {
        return { parent_node_id: current.parent_node_id };
      }
      const up = current.parent_local_ref ?? current.parent_node_id;
      if (!up || seen.has(up)) return {};
      seen.add(up);
      if (!skipped.has(up)) return { parent_local_ref: up };
      current = skipped.get(up);
    }
    return {};
  };

  const kept: ChangeOp[] = [];
  const blocked: number[] = [];
  // Every op as it would land, by position — what the card shows.
  const shown = ops.slice();
  ops.forEach((op, index) => {
    if (!accepted.has(index)) return;
    let ok: boolean;
    switch (op.kind) {
      case "create_node": {
        const parentRef = gone(op.parent_local_ref)
          ? op.parent_local_ref
          : gone(op.parent_node_id)
            ? op.parent_node_id
            : undefined;
        if (!parentRef) {
          kept.push(op);
          return;
        }
        const rehomed = { ...without(op, "parent_local_ref", "parent_node_id"), ...homeAbove(parentRef) };
        kept.push(rehomed);
        shown[index] = rehomed;
        return;
      }
      case "move":
        ok = !gone(moveTarget(op));
        break;
      case "create_edge":
        ok = !gone(op.source_node_id) && !gone(op.target_node_id);
        break;
      default:
        ok = !gone(op.node_id);
    }
    if (ok) kept.push(op);
    else blocked.push(index);
  });
  return { kept, blocked, shown };
}
