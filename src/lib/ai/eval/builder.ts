// The builder eval: one fixture through the model calls a dump makes
// (lib/ai/extraction.ts runBuilder) and the pure steps after them, down to the
// change set and the policy split of a dump turn (dump-turn.ts,
// turn-policy.ts). No database and no writes: the fixture's synthetic graph
// stands in for retrieval.
//
// Mirrored from runBuilder: the prompt chosen by length (light ≤700 chars,
// else extract-v26), the edit pass over the sentences the long prompt quotes
// (extract-light on those sentences, merged with mergeEditPass), the
// confidence floor, the existing-parent check, resolveBuilderChanges,
// builderToOps, splitByPolicy.
//
// Not covered (they need the DB or embeddings): relevance retrieval, the
// exact-title and semantic dedup, the auto-apply calibration (here every new
// node counts as trusted, so what waits is what the policy itself holds back),
// the priority read and the reply. A duplicate the model proposes therefore
// counts as a failure here even when the pipeline would drop it — the check is
// on the prompt. scripts/test-e2e-turn.ts runs the whole turn against the DB.

import { ALLOWED_CHILDREN, normalizeNodeType } from "@/lib/graph/node-types";
import type { ChangeOp } from "@/lib/graph/change-set";
import type { AIRun, ExtractionOutput } from "@/types/ai";

import { builderToOps, mergeEditPass, resolveBuilderChanges } from "../builder-ops";
import { AI_CONFIDENCE, AI_INGESTION } from "../config";
import { isMalformedAIResponseError } from "../errors";
import { rehomeResolvedProposals } from "../extraction";
import type { AIProvider } from "../provider";
import { splitByPolicy } from "../turn-policy";

import {
  EVAL_TODAY,
  SYNTHETIC_GRAPH,
  type BuilderFixture,
  type ExpectedOp,
  type NodeName,
  type SyntheticNode,
} from "./fixtures";

export type ModelRun = Omit<AIRun, "id" | "created_at">;

export interface BuilderOutcome {
  variant: "light" | "full";
  // What the long prompt quoted as requests to change existing nodes.
  editRequests: string[];
  editPass: "none" | "ran" | "failed";
  // The model's output after the edit pass was merged in.
  output: ExtractionOutput;
  // The turn's change set, and how the policy splits it.
  ops: ChangeOp[];
  now: ChangeOp[];
  ask: ChangeOp[];
  // Existing nodes whose reorganization was half-planned (asked about instead).
  broken: string[];
  questions: string[];
  runs: ModelRun[];
}

export const BUILDER_CHECKS = [
  "nodes",
  "parents",
  "links",
  "completions",
  "edit_requests",
  "edits",
  "dates",
  "nesting",
  "no_extra",
  "policy",
] as const;
export type BuilderCheckKind = (typeof BUILDER_CHECKS)[number];

export interface CheckItem {
  check: string;
  label: string;
  passed: boolean;
  detail?: string;
}

function graphFor(fixture: BuilderFixture): SyntheticNode[] {
  return fixture.graph === "synthetic" ? SYNTHETIC_GRAPH : [];
}

export function builderVariant(input: string): "light" | "full" {
  return input.trim().length <= AI_INGESTION.LIGHT_DUMP_MAX_CHARS ? "light" : "full";
}

// ---------------------------------------------------------------------------
// Run — the model calls (1, or 2 with the edit pass) and the pure steps after
// ---------------------------------------------------------------------------

export async function runBuilderFixture(
  fixture: BuilderFixture,
  provider: Pick<AIProvider, "extractNodes">,
): Promise<BuilderOutcome> {
  const graph = graphFor(fixture);
  const titleById = new Map(graph.map((n) => [n.id, n.title]));
  const existingNodes = graph.map((n) => ({
    id: n.id,
    title: n.title,
    summary: n.summary ?? null,
    node_type: n.node_type,
    parent_title: n.parent ? (titleById.get(n.parent) ?? null) : null,
  }));
  const call = (rawText: string, variant: "light" | "full") =>
    provider.extractNodes({
      raw_text: rawText,
      workspace_id: "eval",
      user_id: "eval",
      existing_nodes: existingNodes,
      today: EVAL_TODAY,
      rubric_cache_ttl: null,
      variant,
    });

  const runs: ModelRun[] = [];
  const variant = builderVariant(fixture.input);
  const main = await call(fixture.input, variant);
  runs.push(main.run);

  const editRequests = main.output.edit_requests;
  let output = main.output;
  let editPass: BuilderOutcome["editPass"] = "none";
  if (editRequests.length > 0) {
    try {
      const edit = await call(editRequests.join("\n"), "light");
      runs.push(edit.run);
      output = mergeEditPass(output, edit.output);
      editPass = "ran";
    } catch (err) {
      editPass = "failed";
      const paid = runFromError(err);
      if (paid) runs.push(paid);
    }
  }
  return { ...shapeTurn(output, graph), variant, editRequests, editPass, output, runs };
}

// A call that answered with unusable output was still paid for.
export function runFromError(err: unknown): ModelRun | null {
  if (!isMalformedAIResponseError(err)) return null;
  return {
    run_type: err.runType,
    provider: err.provider,
    model_name: err.modelName,
    prompt_version: err.promptVersion,
    input_hash: err.inputHash,
    output_hash: err.outputHash,
    input_tokens: err.inputTokens,
    output_tokens: err.outputTokens,
    latency_ms: err.latencyMs,
    estimated_cost: err.estimatedCost,
    status: "failed",
    error_text: err.message,
  };
}

// The builder's output → the turn's change set, as runBuilder + dump-turn do
// once dedup has run (none here).
export function shapeTurn(
  output: ExtractionOutput,
  graph: SyntheticNode[],
): Pick<BuilderOutcome, "ops" | "now" | "ask" | "broken" | "questions"> {
  const ids = new Set(graph.map((n) => n.id));
  const confident = output.proposed_nodes.filter((n) => n.extraction_confidence >= AI_CONFIDENCE.EXTRACTION_MIN);
  const nodes = rehomeResolvedProposals({
    nodes: confident,
    droppedProposals: [],
    droppedRefToExistingId: new Map(),
    droppedRefToKeptRef: new Map(),
    validExistingParentIds: ids,
  });
  const { changes, broken } = resolveBuilderChanges({
    changes: output.changes,
    activeNodeIds: ids,
    survivingRefs: new Set(nodes.flatMap((n) => (n.local_ref ? [n.local_ref] : []))),
    droppedRefToExistingId: new Map(),
    droppedRefToKeptRef: new Map(),
  });
  const ops = builderToOps({
    nodes,
    changes,
    completeExistingNodeIds: output.complete_existing_node_ids,
    autoCompleteLocalRefs: output.auto_complete_local_refs,
  });
  const trusted = new Set(ops.flatMap((op) => (op.kind === "create_node" && op.local_ref ? [op.local_ref] : [])));
  const { now, ask } = splitByPolicy(ops, trusted, true);
  return { ops, now, ask, broken, questions: output.clarifying_questions };
}

// ---------------------------------------------------------------------------
// Checks — pure, on the outcome
// ---------------------------------------------------------------------------

type CreateOp = Extract<ChangeOp, { kind: "create_node" }>;

const lower = (s: string) => s.trim().toLowerCase();

export function checkBuilder(fixture: BuilderFixture, outcome: Omit<BuilderOutcome, "runs" | "output">): CheckItem[] {
  const graph = graphFor(fixture);
  const expect = fixture.expect;
  const existingByTitle = new Map(graph.map((n) => [lower(n.title), n]));
  const existingById = new Map(graph.map((n) => [n.id, n]));
  const creates = outcome.ops.filter((op): op is CreateOp => op.kind === "create_node");
  const createByRef = new Map(creates.flatMap((op) => (op.local_ref ? [[op.local_ref, op] as const] : [])));

  const titleOf = (ref: string | undefined): string =>
    !ref ? "(top level)" : (createByRef.get(ref)?.title ?? existingById.get(ref)?.title ?? ref);
  const typeOf = (ref: string | undefined): string | null =>
    !ref ? null : (createByRef.get(ref)?.node_type ?? existingById.get(ref)?.node_type ?? null);

  // New nodes a name points at: an exact title wins over a partial one.
  const newNamed = (name: NodeName): CreateOp[] => {
    const exact = creates.filter((op) => lower(op.title) === lower(name));
    return exact.length > 0 ? exact : creates.filter((op) => lower(op.title).includes(lower(name)));
  };
  // Does this op ref (an existing id or a local ref) answer to the name?
  const refIs = (ref: string | undefined, name: NodeName): boolean => {
    if (!ref) return false;
    const existing = existingByTitle.get(lower(name));
    if (existing) return ref === existing.id;
    const created = createByRef.get(ref);
    return !!created && newNamed(name).includes(created);
  };
  const parentOf = (op: CreateOp) => op.parent_local_ref ?? op.parent_node_id;
  const describeNew = (ops: CreateOp[]) =>
    ops.length === 0 ? "none" : ops.map((op) => `"${op.title}" [${op.node_type}] under ${titleOf(parentOf(op))}`).join("; ");
  const opLabel = (op: ChangeOp): string => {
    switch (op.kind) {
      case "create_node":
        return `create "${op.title}"`;
      case "move":
        return `move "${titleOf(op.node_id)}" → "${titleOf(op.new_parent_node_id ?? op.new_parent_local_ref)}"`;
      case "create_edge":
      case "remove_edge":
        return `${op.kind === "create_edge" ? "link" : "unlink"} "${titleOf(op.source_node_id)}" -${op.edge_type ?? "any"}-> "${titleOf(op.target_node_id)}"`;
      case "update":
        return `update "${titleOf(op.node_id)}"${op.title ? ` → "${op.title}"` : ""}${op.node_type ? ` [${op.node_type}]` : ""}`;
      case "merge":
        return `merge "${titleOf(op.node_id)}" into "${titleOf(op.into_node_id)}"`;
      default:
        return `${op.kind} "${titleOf(op.node_id)}"`;
    }
  };
  const opIs = (op: ChangeOp, want: ExpectedOp): boolean => {
    if (op.kind !== want.kind) return false;
    switch (op.kind) {
      case "create_node":
        return newNamed(want.node).includes(op);
      case "create_edge":
        return refIs(op.source_node_id, want.node) || refIs(op.target_node_id, want.node);
      case "move":
      case "update":
      case "complete":
        return refIs(op.node_id, want.node);
      default:
        return false;
    }
  };

  const items: CheckItem[] = [];
  const add = (check: BuilderCheckKind, label: string, passed: boolean, detail?: string) =>
    items.push({ check, label, passed, ...(passed || !detail ? {} : { detail }) });

  // nodes — the new nodes and their types (node types v2)
  for (const want of expect.nodes ?? []) {
    const types = Array.isArray(want.type) ? want.type : [want.type];
    const found = newNamed(want.title);
    add(
      "nodes",
      `new "${want.title}" as ${types.join("|")}`,
      found.some((op) => types.includes(normalizeNodeType(op.node_type))),
      `found: ${describeNew(found)}`,
    );
  }

  // parents — the belongs_to parent a new node gets
  for (const want of expect.parents ?? []) {
    const parents = Array.isArray(want.parent) ? want.parent : [want.parent];
    const found = newNamed(want.child);
    add(
      "parents",
      `"${want.child}" under ${parents.map((p) => `"${p}"`).join(" or ")}`,
      found.some((op) => parents.some((p) => refIs(parentOf(op), p))),
      `found: ${describeNew(found)}`,
    );
  }

  // links — lateral and dependency edges in the change set
  const edges = outcome.ops.filter((op) => op.kind === "create_edge");
  for (const want of expect.links ?? []) {
    add(
      "links",
      `"${want.source}" -${want.types?.join("|") ?? "any"}-> "${want.target}"`,
      edges.some(
        (op) =>
          op.kind === "create_edge" &&
          refIs(op.source_node_id, want.source) &&
          refIs(op.target_node_id, want.target) &&
          (!want.types || want.types.includes(op.edge_type)),
      ),
      `links: ${edges.map(opLabel).join("; ") || "none"}`,
    );
  }

  // completions — the expected ones, and nothing else marked done
  const completes = outcome.ops.filter((op) => op.kind === "complete");
  for (const name of expect.completes ?? []) {
    add("completions", `done: "${name}"`, completes.some((op) => op.kind === "complete" && refIs(op.node_id, name)), `done: ${completes.map(opLabel).join("; ") || "nothing"}`);
  }
  const unexpected = completes.filter(
    (op) => op.kind === "complete" && !(expect.completes ?? []).some((name) => refIs(op.node_id, name)),
  );
  add("completions", "nothing else marked done", unexpected.length === 0, unexpected.map(opLabel).join("; "));

  // edit_requests — the long prompt quotes, word for word, and plans nothing
  if (fixture.prompt === "full") {
    const quoted = outcome.editRequests.map(lower);
    if (expect.edit_requests) {
      for (const needle of expect.edit_requests) {
        add("edit_requests", `quotes "${needle}"`, quoted.some((q) => q.includes(lower(needle))), `quoted: ${JSON.stringify(outcome.editRequests)}`);
      }
      add("edit_requests", "edit pass ran", outcome.editPass === "ran", `edit pass: ${outcome.editPass}`);
    } else {
      add("edit_requests", "quotes nothing", quoted.length === 0, `quoted: ${JSON.stringify(outcome.editRequests)}`);
    }
  }

  // edits — moves and renames of existing nodes (from the light prompt, or
  // the edit pass on a long dump)
  const moves = outcome.ops.filter((op) => op.kind === "move");
  const updates = outcome.ops.filter((op) => op.kind === "update");
  const brokenNote = outcome.broken.length > 0 ? ` (half-planned, asked instead: ${outcome.broken.map(titleOf).join(", ")})` : "";
  for (const want of expect.moves ?? []) {
    add(
      "edits",
      `move "${want.node}" under "${want.parent}"`,
      moves.some(
        (op) => op.kind === "move" && refIs(op.node_id, want.node) && refIs(op.new_parent_node_id ?? op.new_parent_local_ref, want.parent),
      ),
      `moves: ${moves.map(opLabel).join("; ") || "none"}${brokenNote}`,
    );
  }
  for (const want of expect.renames ?? []) {
    add(
      "edits",
      `rename "${want.node}" to …${want.title_contains}…`,
      updates.some(
        (op) => op.kind === "update" && refIs(op.node_id, want.node) && !!op.title && lower(op.title).includes(lower(want.title_contains)),
      ),
      `updates: ${updates.map(opLabel).join("; ") || "none"}${brokenNote}`,
    );
  }
  if (!expect.moves?.length && !expect.renames?.length) {
    const edits = [...moves, ...updates];
    add("edits", "no edits to existing nodes", edits.length === 0 && outcome.broken.length === 0, `${edits.map(opLabel).join("; ")}${brokenNote}`);
  }

  // dates — target_date from the user's date words
  for (const want of expect.dates ?? []) {
    const found = newNamed(want.title);
    add(
      "dates",
      `"${want.title}" due ${want.date}`,
      found.some((op) => op.target_date === want.date),
      `found: ${found.map((op) => `"${op.title}" ${op.target_date ?? "no date"}`).join("; ") || "no such node"}`,
    );
  }

  // nesting — every parent can hold its child (ALLOWED_CHILDREN). One
  // exception, from the prompts: an EXISTING node typed project that groups
  // projects ("Money Projects") acts as an area and may hold a project.
  const badNesting: string[] = [];
  const canHold = (parentRef: string | undefined, childType: string | null) => {
    const parentType = typeOf(parentRef);
    if (!parentRef || !parentType || !childType) return true;
    const parent = normalizeNodeType(parentType);
    const child = normalizeNodeType(childType);
    if (parent === "project" && child === "project" && existingById.has(parentRef)) return true;
    return ALLOWED_CHILDREN[parent].has(child);
  };
  for (const op of creates) {
    if (!canHold(parentOf(op), op.node_type)) badNesting.push(`${op.node_type} "${op.title}" under ${typeOf(parentOf(op))} "${titleOf(parentOf(op))}"`);
  }
  for (const op of moves) {
    if (op.kind !== "move") continue;
    const target = op.new_parent_node_id ?? op.new_parent_local_ref;
    if (!canHold(target, typeOf(op.node_id))) badNesting.push(`${opLabel(op)} (${typeOf(op.node_id)} under ${typeOf(target)})`);
  }
  add("nesting", "every parent can hold its child", badNesting.length === 0, badNesting.join("; "));

  // no_extra — no copies of existing nodes, nothing for venting or fixed
  // times, no more than asked for
  if (graph.length > 0) {
    const copies = creates.filter((op) => existingByTitle.has(lower(op.title)));
    add("no_extra", "no copy of an existing node", copies.length === 0, describeNew(copies));
  }
  for (const needle of expect.absent ?? []) {
    const hits = creates.filter((op) => lower(op.title).includes(lower(needle)));
    add("no_extra", `no new node about "${needle}"`, hits.length === 0, describeNew(hits));
  }
  if (typeof expect.max_new_nodes === "number") {
    add("no_extra", `≤${expect.max_new_nodes} new nodes`, creates.length <= expect.max_new_nodes, `${creates.length}: ${describeNew(creates)}`);
  }
  if (typeof expect.max_questions === "number") {
    add("no_extra", `≤${expect.max_questions} questions`, outcome.questions.length <= expect.max_questions, JSON.stringify(outcome.questions));
  }

  // policy — what applies now (with Undo) and what waits on the card
  const describeSplit = () => `now: ${outcome.now.map(opLabel).join("; ") || "nothing"} | waits: ${outcome.ask.map(opLabel).join("; ") || "nothing"}`;
  for (const want of expect.waits ?? []) {
    add("policy", `waits: ${want.kind} "${want.node}"`, outcome.ask.some((op) => opIs(op, want)) && !outcome.now.some((op) => opIs(op, want)), describeSplit());
  }
  for (const want of expect.applies ?? []) {
    add("policy", `applies now: ${want.kind} "${want.node}"`, outcome.now.some((op) => opIs(op, want)), describeSplit());
  }

  return items;
}
