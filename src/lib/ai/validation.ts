// Runtime output validation for AI provider responses.
// Every structured AI response is validated here before being written to the DB.
// If validation fails the caller catches the error, logs the failure, and does not write.

import { resolveRelativeDay } from "@/lib/time/relative-day";
import { titleCoversRequest } from "@/lib/planner/plan-requests";
import type {
  BuilderChange,
  ExtractionOutput,
  EdgeInferenceOutput,
  PlanOutput,
  PlanRequestInput,
  PlanTimeBlockInput,
  EmbeddingOutput,
  RerankOutput,
  MergeCheckOutput,
} from "@/types/ai";
import { isNodeType } from "@/lib/graph/node-types";
import {
  LINK_KINDS,
  isLegacyLinkType,
  isReversedEdgeType,
  normalizeEdgeType,
  type LateralLinkKind,
} from "@/lib/graph/edge-types";
import { MERGE_CHECK_PROMPT_VERSION } from "./prompts/merge-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

// ---------------------------------------------------------------------------
// Extraction output
// ---------------------------------------------------------------------------


// Lateral links are the three non-parent kinds (lib/graph/edge-types.ts); a
// retired name a model still sends (useful_for, prerequisite_for…) is read as
// its kind.
function lateralLinkKind(raw: unknown): LateralLinkKind | null {
  if (!isString(raw)) return null;
  const type = raw.trim().toLowerCase();
  if (!(LINK_KINDS as readonly string[]).includes(type) && !isLegacyLinkType(type)) return null;
  if (isReversedEdgeType(type)) return null; // depends_on: wrong way round for a soft link
  const kind = normalizeEdgeType(type);
  return kind === "belongs_to" ? null : kind;
}

const EXTRACTION_SOFT_LINK_PRIORITY: Record<LateralLinkKind, number> = {
  required_for: 3,
  supports: 2,
  related_to: 1,
};
const UUID = /^[0-9a-fA-F-]{36}$/;
const MAX_BUILDER_CHANGES = 20;
const MAX_SOFT_LINKS_PER_NODE = 2;
const MAX_EDIT_REQUESTS = 6;
const MAX_EDIT_REQUEST_CHARS = 600;

const LOCAL_REF = /^[A-Za-z][\w-]{0,15}$/;

// Edits to existing nodes. Best-effort like soft links: a malformed entry is
// dropped, never a reason to discard the nodes around it. A target may be an
// existing node id or a local_ref; the node being moved or updated must be an
// existing one. Whether an id is in the workspace — and whether a local_ref
// names a node this output actually proposes — is judged later, against the
// graph (builder-ops.ts resolveBuilderChanges), which also knows what to do
// when a move points at a parent the model forgot to create.
export function parseBuilderChanges(raw: unknown): BuilderChange[] {
  if (!Array.isArray(raw)) return [];
  const ref = (value: unknown): string | null => {
    if (!isString(value)) return null;
    const trimmed = value.trim();
    return UUID.test(trimmed) || LOCAL_REF.test(trimmed) ? trimmed : null;
  };
  const existing = (value: unknown): string | null =>
    isString(value) && UUID.test(value.trim()) ? value.trim() : null;

  const changes: BuilderChange[] = [];
  for (const entry of raw) {
    if (changes.length >= MAX_BUILDER_CHANGES) break;
    if (!isObject(entry)) continue;
    const before = changes.length;
    if (entry.kind === "move") {
      const nodeId = existing(entry.node_id);
      const newParent = ref(entry.new_parent);
      if (nodeId && newParent && nodeId !== newParent) {
        changes.push({ kind: "move", node_id: nodeId, new_parent: newParent });
      }
    } else if (entry.kind === "update") {
      const nodeId = existing(entry.node_id);
      const title = isString(entry.title) && entry.title.trim() ? entry.title.trim().slice(0, 120) : undefined;
      const rawType = entry.node_type === "concept" ? "note" : entry.node_type;
      const nodeType = isNodeType(rawType) ? rawType : undefined;
      const summary = isString(entry.summary) && entry.summary.trim() ? entry.summary.trim() : undefined;
      if (nodeId && (title || nodeType || summary)) {
        changes.push({
          kind: "update",
          node_id: nodeId,
          ...(title ? { title } : {}),
          ...(nodeType ? { node_type: nodeType } : {}),
          ...(summary ? { summary } : {}),
        });
      }
    } else if (entry.kind === "link") {
      const source = ref(entry.source);
      const target = ref(entry.target);
      const edgeType = lateralLinkKind(entry.edge_type);
      if (source && target && source !== target && edgeType) {
        changes.push({
          kind: "link",
          source,
          target,
          edge_type: edgeType,
          rationale: isString(entry.rationale) && entry.rationale.trim() ? entry.rationale.trim() : null,
        });
      }
    }
    if (changes.length === before) {
      console.warn("[validation] dropped a malformed builder change:", JSON.stringify(entry).slice(0, 300));
    }
  }
  return changes;
}

// The model no longer echoes ids or the prompt version (extract v20) — the
// server already knows them, so they come from the call instead.
export interface ExtractionSession {
  workspace_id: string;
  user_id: string;
  prompt_version: string;
  // The user's local date — resolves the date words a node carries.
  today?: string;
}

// One bad reference must never cost the whole output. Until 2026-09-30 a soft
// link to an unknown local_ref threw here, the caller retried the full Sonnet
// call, and a dump took 54 s instead of 21 (and paid twice). Now: a malformed
// NODE is dropped, a malformed REFERENCE is dropped, and only an output with no
// usable shape at all is rejected.
export function validateExtractionOutput(raw: unknown, session: ExtractionSession): ExtractionOutput {
  if (!isObject(raw)) throw new Error("Extraction output must be an object");
  // An update with nothing new may leave the (empty) array out entirely.
  if (raw.proposed_nodes === undefined || raw.proposed_nodes === null) raw.proposed_nodes = [];
  if (!Array.isArray(raw.proposed_nodes))
    throw new Error("Extraction output proposed_nodes is not an array");

  const seenLocalRefs = new Set<string>();
  const dropped: string[] = [];
  const drop = (i: number, why: string) => {
    dropped.push(`proposed_nodes[${i}] ${why}`);
    return [];
  };

  const nodes = raw.proposed_nodes.flatMap((n: unknown, i: number) => {
    if (!isObject(n)) return drop(i, "is not an object");
    if (!isString(n.proposed_title) || !n.proposed_title.trim()) return drop(i, "missing proposed_title");
    if (!isString(n.proposed_node_type)) return drop(i, "missing proposed_node_type");
    // Legacy "concept" from a model that slips into the old taxonomy → note.
    if (n.proposed_node_type === "concept") n.proposed_node_type = "note";
    if (!isNodeType(n.proposed_node_type)) return drop(i, `unknown node type: ${n.proposed_node_type}`);
    if (!isString(n.local_ref) || !n.local_ref.trim()) return drop(i, "missing local_ref");

    const localRef = n.local_ref.trim();
    if (seenLocalRefs.has(localRef)) return drop(i, `duplicate local_ref: ${localRef}`);
    seenLocalRefs.add(localRef);

    let primaryParentLocalRef =
      isString(n.primary_parent_local_ref) && n.primary_parent_local_ref.trim()
        ? n.primary_parent_local_ref.trim()
        : null;
    if (primaryParentLocalRef === localRef) primaryParentLocalRef = null;

    let existingParentNodeId =
      isString(n.existing_parent_node_id) && n.existing_parent_node_id.trim()
        ? n.existing_parent_node_id.trim()
        : null;
    // A node has one parent; the one created in the same dump is the closer.
    if (primaryParentLocalRef && existingParentNodeId) existingParentNodeId = null;

    const dependsOnLocalRefs = Array.isArray(n.depends_on_local_refs)
      ? n.depends_on_local_refs
          .filter(isString)
          .map((ref) => ref.trim())
          .filter((ref) => ref && ref !== localRef)
      : [];

    // Soft links are best-effort: drop malformed entries silently rather than
    // failing the whole extraction. A single broken cross-link must not
    // discard the valid proposed nodes around it.
    const softLinks: Array<{
      target_local_ref: string;
      edge_type: ExtractionOutput["proposed_nodes"][number]["soft_links"][number]["edge_type"];
      rationale: string | null;
    }> = [];
    if (Array.isArray(n.soft_links)) {
      for (const rawLink of n.soft_links) {
        if (!isObject(rawLink)) continue;
        if (!isString(rawLink.target_local_ref) || !rawLink.target_local_ref.trim()) continue;
        const linkKind = lateralLinkKind(rawLink.edge_type);
        if (!linkKind) continue;
        const targetLocalRef = rawLink.target_local_ref.trim();
        if (targetLocalRef === localRef) continue;

        softLinks.push({
          target_local_ref: targetLocalRef,
          edge_type: linkKind,
          rationale:
            isString(rawLink.rationale) && rawLink.rationale.trim()
              ? rawLink.rationale.trim()
              : null,
        });
      }
    }

    const dedupedSoftLinks = Array.from(
      softLinks.reduce((map, link) => {
        const existing = map.get(link.target_local_ref);
        if (!existing) {
          map.set(link.target_local_ref, link);
          return map;
        }

        const existingPriority =
          EXTRACTION_SOFT_LINK_PRIORITY[existing.edge_type] ?? 0;
        const nextPriority =
          EXTRACTION_SOFT_LINK_PRIORITY[link.edge_type] ?? 0;

        if (nextPriority > existingPriority) {
          map.set(link.target_local_ref, link);
        }

        return map;
      }, new Map<string, typeof softLinks[number]>()).values()
    ).slice(0, MAX_SOFT_LINKS_PER_NODE);

    // target_date — optional ISO date deadline. Drop anything that doesn't
    // match YYYY-MM-DD rather than rejecting the whole node, since the model
    // sometimes returns "Aug 1" or other shapes despite the prompt.
    // The user's own words for the date ("friday", "oct 20") beat the model's
    // arithmetic: on a Friday, "by friday" came back as the next Tuesday. The
    // same resolver the priority read and chat tools use; target_date only when
    // the words don't resolve ("end of Q3").
    const fromWords =
      isString(n.date_words) && n.date_words.trim() && session.today
        ? resolveRelativeDay(n.date_words, session.today)
        : null;
    const proposedTargetDate =
      fromWords ??
      (isString(n.target_date) && /^\d{4}-\d{2}-\d{2}$/.test(n.target_date) ? n.target_date : null);

    return [{
      local_ref: localRef,
      workspace_id: session.workspace_id,
      user_id: session.user_id,
      proposed_title: (n.proposed_title as string).trim(),
      proposed_summary: isString(n.proposed_summary)
        ? n.proposed_summary
        : null,
      // Body is capped at 400 chars at validation time. The prompt asks for
      // ≤400; anything longer gets trimmed rather than rejected so a
      // slightly-runaway response doesn't fail the whole extraction.
      proposed_body: isString(n.proposed_body)
        ? n.proposed_body.trim().slice(0, 400) || null
        : null,
      proposed_node_type: n.proposed_node_type as ExtractionOutput["proposed_nodes"][number]["proposed_node_type"],
      primary_parent_local_ref: primaryParentLocalRef,
      existing_parent_node_id: existingParentNodeId,
      // A step can't wait on the very node it sits under: the dependency would
      // block it until its own parent is finished ("market it after the build"
      // came back as the build project required_for its own child). The tree
      // already says they belong together, so the link is dropped.
      depends_on_local_refs: Array.from(new Set(dependsOnLocalRefs))
        .filter((ref) => ref !== primaryParentLocalRef)
        .slice(0, 2),
      soft_links: dedupedSoftLinks.filter(
        (link) => link.target_local_ref !== primaryParentLocalRef,
      ),
      accepted_node_id: null,
      proposed_target_date: proposedTargetDate,
      extraction_confidence: isNumber(n.extraction_confidence)
        ? Math.min(1, Math.max(0, n.extraction_confidence))
        : 0.5,
      source_span: isString(n.source_span) ? n.source_span : null,
      proposal_status: "pending_review" as const,
    }];
  });

  if (dropped.length > 0) {
    console.warn("[validation] dropped malformed proposed nodes:", dropped.join("; "));
    // Nothing usable in a non-empty list → that is a malformed answer.
    if (nodes.length === 0) throw new Error(dropped[0]);
  }

  const knownLocalRefs = new Set(nodes.map((node) => node.local_ref));
  // A link from a NEW node to a node that already EXISTS ("the ML project could
  // be the portfolio piece for the internship"): soft_links could only name a
  // node from the same dump, so the model invented a copy of the existing goal
  // to point at and the link died with the copy. It may now give the existing
  // node's id; that becomes a "link" change, which can cross the two.
  const linkChanges: BuilderChange[] = [];

  for (const node of nodes) {
    const parentRef = node.primary_parent_local_ref;
    if (parentRef && !knownLocalRefs.has(parentRef)) {
      console.warn(`[validation] "${node.proposed_title}": unknown parent ref ${parentRef} dropped`);
      node.primary_parent_local_ref = null;
      // The model put an existing node's id in the same-dump field.
      if (UUID.test(parentRef) && !node.existing_parent_node_id) node.existing_parent_node_id = parentRef;
    }
    node.depends_on_local_refs = node.depends_on_local_refs.filter((ref) => knownLocalRefs.has(ref));
    node.soft_links = node.soft_links.filter((link) => {
      if (knownLocalRefs.has(link.target_local_ref)) return true;
      if (UUID.test(link.target_local_ref)) {
        linkChanges.push({
          kind: "link",
          source: node.local_ref,
          target: link.target_local_ref,
          edge_type: link.edge_type,
          rationale: link.rationale,
        });
      } else {
        console.warn(
          `[validation] "${node.proposed_title}": soft link to unknown ref ${link.target_local_ref} dropped`,
        );
      }
      return false;
    });
  }

  // clarifying_questions is optional; drop malformed entries silently instead
  // of failing the whole extraction. Cap at 3 to keep the UI compact.
  const clarifyingQuestions: string[] = [];
  if (Array.isArray(raw.clarifying_questions)) {
    for (const q of raw.clarifying_questions) {
      if (!isString(q)) continue;
      const trimmed = q.trim();
      if (!trimmed) continue;
      if (trimmed.length > 400) continue;
      clarifyingQuestions.push(trimmed);
      if (clarifyingQuestions.length >= 3) break;
    }
  }

  // complete_existing_node_ids — list of existing workspace node UUIDs the
  // user reported as DONE in this dump. Validated as well-formed uuid
  // strings; the entries route will further check ownership/workspace
  // before applying the completion.
  const completeExistingNodeIds: string[] = [];
  if (Array.isArray(raw.complete_existing_node_ids)) {
    for (const id of raw.complete_existing_node_ids) {
      if (!isString(id)) continue;
      const trimmed = id.trim();
      if (!/^[0-9a-fA-F-]{36}$/.test(trimmed)) continue;
      completeExistingNodeIds.push(trimmed);
    }
  }

  // auto_complete_local_refs — local_refs of newly-proposed nodes that
  // should be created as already-completed. Validated against the
  // accepted nodes list (must match an existing local_ref).
  const validLocalRefs = new Set(
    nodes.map((n) => n.local_ref).filter((r): r is string => typeof r === "string"),
  );
  const autoCompleteLocalRefs: string[] = [];
  if (Array.isArray(raw.auto_complete_local_refs)) {
    for (const ref of raw.auto_complete_local_refs) {
      if (!isString(ref)) continue;
      if (!validLocalRefs.has(ref)) continue;
      autoCompleteLocalRefs.push(ref);
    }
  }

  return {
    proposed_nodes: nodes,
    changes: [...parseBuilderChanges(raw.changes), ...linkChanges].slice(0, MAX_BUILDER_CHANGES),
    edit_requests: normalizeEditRequests(raw.edit_requests),
    clarifying_questions: clarifyingQuestions,
    complete_existing_node_ids: completeExistingNodeIds,
    auto_complete_local_refs: autoCompleteLocalRefs,
    prompt_version: session.prompt_version,
  };
}

// edit_requests — the dump's own sentences about reorganizing existing nodes
// (extract-v26 quotes them instead of acting on them). Also read from the
// output while it streams (extraction.ts), so both see the same list.
export function normalizeEditRequests(raw: unknown): string[] {
  const editRequests: string[] = [];
  if (!Array.isArray(raw)) return editRequests;
  for (const entry of raw) {
    if (!isString(entry)) continue;
    const trimmed = entry.trim();
    if (!trimmed || editRequests.includes(trimmed)) continue;
    editRequests.push(trimmed.slice(0, MAX_EDIT_REQUEST_CHARS));
    if (editRequests.length >= MAX_EDIT_REQUESTS) break;
  }
  return editRequests;
}

// ---------------------------------------------------------------------------
// Edge inference output
// ---------------------------------------------------------------------------

const VALID_EDGE_TYPES = new Set([
  "supports",
  "related_to",
  "prerequisite_for",
  "required_for",
  "belongs_to",
  "useful_for",
  "blocks",
  "inspired_by",
  "depends_on",
]);

export function validateEdgeInferenceOutput(
  raw: unknown
): EdgeInferenceOutput {
  if (!isObject(raw))
    throw new Error("Edge inference output must be an object");
  if (!Array.isArray(raw.results))
    throw new Error("Edge inference output missing results array");
  if (!isString(raw.prompt_version))
    throw new Error("Edge inference output missing prompt_version");

  const results: EdgeInferenceOutput["results"] = [];
  for (const entry of raw.results) {
    if (!isObject(entry)) continue;
    if (!isString(entry.candidate_id) || !entry.candidate_id.trim()) continue;
    if (!isBoolean(entry.related)) continue;
    if (!isString(entry.explanation) || !entry.explanation.trim()) continue;

    const confidence = isNumber(entry.confidence)
      ? Math.min(1, Math.max(0, entry.confidence))
      : 0;

    let edge_type: EdgeInferenceOutput["results"][number]["edge_type"] = null;
    if (entry.related) {
      if (!isString(entry.edge_type) || !VALID_EDGE_TYPES.has(entry.edge_type)) {
        edge_type = "related_to";
      } else {
        edge_type = entry.edge_type as EdgeInferenceOutput["results"][number]["edge_type"];
      }
    }

    results.push({
      candidate_id: entry.candidate_id.trim(),
      related: entry.related,
      edge_type,
      // Anything but an explicit "candidate" reads source → candidate, which
      // is also what prompts before v5 (no "from" field) meant.
      from: entry.from === "candidate" ? "candidate" : "source",
      confidence,
      explanation: entry.explanation.trim(),
    });
  }

  return {
    results,
    prompt_version: raw.prompt_version as string,
  };
}

// ---------------------------------------------------------------------------
// Plan output
// ---------------------------------------------------------------------------

const VALID_BLOCK_TYPES = new Set(["focus", "admin", "break", "buffer"]);

const normalizeTitle = (title: string) => title.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").trim();

/** What a plan was given beyond its work items (PlanInput.time_blocks / requests). */
export interface PlanBlockContext {
  timeBlocks?: Pick<PlanTimeBlockInput, "id" | "start_with" | "step_ids">[];
  requests?: Pick<PlanRequestInput, "node_id" | "title" | "minutes" | "label" | "related">[];
}

// A requested item the model left out still gets its time; an hour when they
// gave no length (45 min for one that names nothing in the graph).
const REQUEST_DEFAULT_MINUTES = 60;
const REQUEST_UNMATCHED_DEFAULT_MINUTES = 45;
const REQUEST_UNMATCHED_MIN_MINUTES = 30;
// A request planned shorter than asked by more than this is topped up.
const REQUEST_SLACK_MINUTES = 15;
const REQUEST_BLOCK_MAX_MINUTES = 180;

/**
 * `busyTitles`: the fixed commitments inside the session. An unlinked block
 * with one of their titles only restates busy time — on a 15-hour day with a
 * lecture, Sonnet wrote a 4-hour "Stats lecture" placeholder that used up the
 * free minutes, and every block after it (dinner, the evening) was dropped.
 *
 * `context` (plan-v8, time blocks): a step inside a time block that is also in
 * the plan is double-booked and dropped; a requested item the plan left out is
 * put first; a time block's reason starts with its next open steps.
 */
export function validatePlanOutput(
  raw: unknown,
  totalMinutes?: number,
  busyTitles: string[] = [],
  context: PlanBlockContext = {},
): PlanOutput {
  if (!isObject(raw)) throw new Error("Plan output must be an object");
  if (!Array.isArray(raw.blocks))
    throw new Error("Plan output missing blocks array");
  if (!isString(raw.prompt_version))
    throw new Error("Plan output missing prompt_version");

  const parsed = raw.blocks.map((b: unknown, i: number) => {
    if (!isObject(b)) throw new Error(`blocks[${i}] is not an object`);
    if (!isString(b.title) || !b.title.trim())
      throw new Error(`blocks[${i}] missing title`);
    if (!isNumber(b.start_offset))
      throw new Error(`blocks[${i}] missing start_offset`);
    if (!isNumber(b.duration_minutes) || b.duration_minutes <= 0)
      throw new Error(`blocks[${i}] missing or invalid duration_minutes`);
    if (!isString(b.block_type) || !VALID_BLOCK_TYPES.has(b.block_type))
      throw new Error(`blocks[${i}] invalid block_type: ${b.block_type}`);

    return {
      // A break is time off, never work on a node: in a live "plan my day
      // from 8am" (2026-10-03) a Lunch break came back tied to a task, shown
      // as "task · BrainDump Future Fixes & Features".
      node_id: b.block_type !== "break" && isString(b.node_id) ? (b.node_id as string) : null,
      title: (b.title as string).trim(),
      start_offset: Math.max(0, b.start_offset as number),
      duration_minutes: Math.max(1, Math.round(b.duration_minutes as number)),
      reason: isString(b.reason) ? b.reason : null,
      block_type: b.block_type as PlanOutput["blocks"][number]["block_type"],
      completion_status: "pending" as const,
    };
  });

  const busy = new Set(busyTitles.map(normalizeTitle).filter(Boolean));
  const { blocks: planned, requested } = withRequests(
    mergeRepeats(
      dropCoveredSteps(
        parsed.filter((block) => !(block.node_id === null && busy.has(normalizeTitle(block.title)))),
        context.timeBlocks ?? [],
      ),
    ),
    context.requests ?? [],
  );
  if (requested.size > 0 && typeof totalMinutes === "number" && totalMinutes > 0) {
    makeRoomForRequests(planned, requested, totalMinutes);
  }

  // Re-sequence so blocks NEVER overlap or overflow. The LLM uses start_offset
  // as an intended ORDER but sometimes collides blocks (e.g. a break and a
  // buffer both at offset 50 in a 1h plan) or overruns the window. Sort by the
  // intended start, then pack contiguously from 0, trimming/dropping anything
  // that won't fit the session window. Result: gap-free, overlap-free, in-window.
  planned.sort((a, b) => a.start_offset - b.start_offset);
  const blocks: typeof planned = [];
  let cursor = 0;
  for (const block of planned) {
    let durationMinutes = block.duration_minutes;
    if (typeof totalMinutes === "number" && totalMinutes > 0) {
      const room = totalMinutes - cursor;
      if (room <= 0) continue; // window already full — drop the remainder
      durationMinutes = Math.min(durationMinutes, room);
    }
    blocks.push({ ...block, start_offset: cursor, duration_minutes: durationMinutes });
    cursor += durationMinutes;
  }

  return { blocks: withStartSteps(blocks, context.timeBlocks ?? []), prompt_version: raw.prompt_version as string };
}

type ParsedBlock = Omit<PlanOutput["blocks"][number], "id" | "plan_session_id">;

// Over this, one item may take two blocks with a break between (a 3h request).
const SPLIT_MIN_MINUTES = 120;

/**
 * One item, one block: the model split "Look into the selectives" into 5 + 20
 * minutes to fill the gap before a lecture (owner e2e 10-06). Repeats of a
 * work block (same node, or same title with none) fold into the first — unless
 * together they run over 2 hours, the one split the prompt allows.
 */
export function mergeRepeats<T extends ParsedBlock>(blocks: T[]): T[] {
  const key = (b: T) =>
    b.block_type === "break" || b.block_type === "buffer" ? null : (b.node_id ?? `t:${normalizeTitle(b.title)}`);
  const total = new Map<string, number>();
  for (const b of blocks) {
    const k = key(b);
    if (k) total.set(k, (total.get(k) ?? 0) + b.duration_minutes);
  }
  const first = new Map<string, T>();
  const out: T[] = [];
  for (const b of blocks) {
    const k = key(b);
    if (!k || (total.get(k) ?? 0) > SPLIT_MIN_MINUTES) {
      out.push(b);
      continue;
    }
    const kept = first.get(k);
    if (kept) {
      kept.duration_minutes += b.duration_minutes;
      continue;
    }
    first.set(k, b);
    out.push(b);
  }
  return out;
}

/** A block on a step inside a time block that is ALSO in this plan: the time block covers it. */
export function dropCoveredSteps<T extends Pick<ParsedBlock, "node_id">>(
  blocks: T[],
  timeBlocks: Pick<PlanTimeBlockInput, "id" | "step_ids">[],
): T[] {
  if (timeBlocks.length === 0) return blocks;
  const planned = new Set(blocks.map((b) => b.node_id).filter((id): id is string => Boolean(id)));
  const coveredBy = new Map<string, string[]>();
  for (const tb of timeBlocks) {
    if (!planned.has(tb.id)) continue;
    for (const step of tb.step_ids) coveredBy.set(step, [...(coveredBy.get(step) ?? []), tb.id]);
  }
  return blocks.filter((b) => !b.node_id || !(coveredBy.get(b.node_id) ?? []).some((owner) => owner !== b.node_id));
}

/**
 * Every request is in the plan, at about the length asked (owner 10-06: the
 * model dropped "clean room" and "look into the electives" twice and gave a
 * 90-min mealprep 20 min). A request is covered by blocks on its node or its
 * related tasks, or whose title names it ("Clean room" for "clean room
 * fully"); one left out goes first, titled with the user's words when it
 * names nothing in the graph; one planned short is topped up. `requested`:
 * the blocks that carry a request, which room is made for.
 */
export function withRequests<T extends ParsedBlock>(
  blocks: T[],
  requests: Pick<PlanRequestInput, "node_id" | "title" | "minutes" | "label" | "related">[],
): { blocks: T[]; requested: Set<ParsedBlock> } {
  const requested = new Set<ParsedBlock>();
  const missing: ParsedBlock[] = [];
  const add = (block: ParsedBlock) => {
    missing.push(block);
    requested.add(block);
  };
  for (const request of requests) {
    const ids = new Set([request.node_id, ...(request.related ?? []).map((r) => r.id)].filter(Boolean));
    const words = request.label || request.title || "";
    const covering = [...blocks, ...(missing as T[])].filter(
      (b) =>
        b.block_type !== "break" &&
        b.block_type !== "buffer" &&
        !requested.has(b) &&
        ((b.node_id !== null && ids.has(b.node_id)) || (words !== "" && titleCoversRequest(b.title, words))),
    );
    for (const b of covering) requested.add(b);
    const title = request.title ?? request.label ?? "";
    if (covering.length === 0) {
      if (!title) continue;
      add({
        node_id: request.node_id,
        title,
        start_offset: -1, // sorts first; packing starts it at 0
        duration_minutes: request.minutes ?? (request.node_id ? REQUEST_DEFAULT_MINUTES : REQUEST_UNMATCHED_DEFAULT_MINUTES),
        reason: "You asked for this",
        block_type: "focus",
        completion_status: "pending",
      });
      continue;
    }
    // Something not in the graph with no length asked gets a real block: the
    // model gave "look into the selectives" 10 minutes twice (owner 10-06).
    const wanted = request.minutes ?? (request.node_id ? null : REQUEST_UNMATCHED_MIN_MINUTES);
    if (!wanted) continue;
    let deficit = wanted - covering.reduce((sum, b) => sum + b.duration_minutes, 0);
    if (deficit <= REQUEST_SLACK_MINUTES) continue;
    for (const b of covering) {
      const more = Math.min(deficit, Math.max(0, REQUEST_BLOCK_MAX_MINUTES - b.duration_minutes));
      b.duration_minutes += more;
      deficit -= more;
      if (deficit <= 0) break;
    }
    if (deficit > REQUEST_SLACK_MINUTES) {
      // Over 3 hours on one item: a second block of it, as the prompt allows.
      add({ ...covering[0], start_offset: covering[0].start_offset + 0.5, duration_minutes: deficit, reason: "The rest of the time you asked for" });
    }
  }
  return { blocks: [...(missing as T[]), ...blocks], requested };
}

/**
 * A plan longer than its window after the requests went in: "Free time"
 * shrinks first, then work nobody asked for is shortened or leaves, from the
 * end of the day — so the packer never cuts a request off.
 */
export function makeRoomForRequests<T extends ParsedBlock>(blocks: T[], requested: Set<ParsedBlock>, totalMinutes: number): void {
  let over = blocks.reduce((sum, b) => sum + b.duration_minutes, 0) - totalMinutes;
  if (over <= 0) return;
  const byLatest = [...blocks].sort((a, b) => b.start_offset - a.start_offset);
  for (const b of byLatest) {
    if (over <= 0) return;
    if (b.block_type !== "break" || !/free time/i.test(b.title)) continue;
    const cut = Math.min(over, b.duration_minutes);
    b.duration_minutes -= cut;
    over -= cut;
  }
  for (const b of byLatest) {
    if (over <= 0) break;
    if (requested.has(b) || b.block_type === "break" || b.block_type === "buffer") continue;
    // Shortened when a real block is left (30+ min), else it goes.
    const cut = b.duration_minutes - over >= 30 ? over : b.duration_minutes;
    b.duration_minutes -= cut;
    over -= cut;
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) if (blocks[i].duration_minutes <= 0) blocks.splice(i, 1);
}

/** A time block's reason starts with where to begin: its next open steps (its first block only). */
export function withStartSteps<T extends Pick<ParsedBlock, "node_id" | "reason" | "block_type">>(
  blocks: T[],
  timeBlocks: Pick<PlanTimeBlockInput, "id" | "start_with">[],
): T[] {
  const startWith = new Map(timeBlocks.map((tb) => [tb.id, tb.start_with]));
  const started = new Set<string>();
  return blocks.map((block) => {
    const steps = block.node_id && block.block_type !== "break" ? startWith.get(block.node_id) : undefined;
    if (!steps || steps.length === 0 || started.has(block.node_id!)) return block;
    started.add(block.node_id!);
    const start = `Start with ${steps.map((t) => `“${t}”`).join(", then ")}`;
    return { ...block, reason: block.reason ? `${start} · ${block.reason}` : start };
  });
}

// ---------------------------------------------------------------------------
// Merge-check output
// ---------------------------------------------------------------------------

export function validateMergeCheckOutput(raw: unknown): MergeCheckOutput {
  if (!isObject(raw)) throw new Error("Merge-check output must be an object");
  if (!isBoolean(raw.same_entity))
    throw new Error("Merge-check output missing same_entity");
  if (!isNumber(raw.confidence))
    throw new Error("Merge-check output missing confidence");
  if (!isString(raw.reason))
    throw new Error("Merge-check output missing reason");

  return {
    same_entity: raw.same_entity,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    reason: raw.reason.trim(),
    prompt_version:
      isString(raw.prompt_version) && raw.prompt_version.trim()
        ? raw.prompt_version
        : MERGE_CHECK_PROMPT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Embedding output
// ---------------------------------------------------------------------------

export function validateEmbeddingOutput(raw: unknown): EmbeddingOutput {
  if (!isObject(raw)) throw new Error("Embedding output must be an object");
  if (!Array.isArray(raw.embedding) || raw.embedding.length === 0)
    throw new Error("Embedding output missing embedding array");
  if (!raw.embedding.every(isNumber))
    throw new Error("Embedding values must all be numbers");

  return {
    embedding: raw.embedding as number[],
    token_count: isNumber(raw.token_count) ? (raw.token_count as number) : null,
  };
}

// ---------------------------------------------------------------------------
// Rerank output
// ---------------------------------------------------------------------------

export function validateRerankOutput(raw: unknown): RerankOutput {
  if (!isObject(raw)) throw new Error("Rerank output must be an object");
  if (!Array.isArray(raw.ranked))
    throw new Error("Rerank output missing ranked array");

  const ranked = raw.ranked.map((r: unknown, i: number) => {
    if (!isObject(r)) throw new Error(`ranked[${i}] is not an object`);
    if (!isString(r.id)) throw new Error(`ranked[${i}] missing id`);
    if (!isNumber(r.score)) throw new Error(`ranked[${i}] missing score`);
    return { id: r.id as string, score: r.score as number };
  });

  return { ranked };
}
