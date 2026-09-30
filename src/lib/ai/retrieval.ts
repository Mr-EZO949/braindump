// Relevance retrieval for ingestion — which existing nodes the extraction model
// should SEE for this particular dump.
//
// Before: the model saw the top 14 nodes by type priority + importance, no
// matter what the dump was about. Dump about a low-importance project and the
// model literally couldn't see it — so it invented a duplicate, and its own
// "don't duplicate existing nodes" rule could never fire. That was the root
// cause of the duplicates complaints (#20).
//
// Now: the dump is split into segments, each segment is embedded (ONE batch
// call) and matched against the workspace's node embeddings (exact per-
// workspace search). Lexical overlap backs that up (it also covers nodes whose
// embedding hasn't landed yet), each hit brings its parent chain (so the model
// can attach at the right level), and a few top Objectives + the root keep the
// overall skeleton visible for genuinely new topics.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NodeType } from "@/types/graph";
import { embedTexts, matchNodesByVector } from "./embeddings";
import { titleTokens } from "./resolution";
import { CONTAINER_TYPES } from "@/lib/graph/node-types";

export const MAX_CONTEXT_NODES = 30;
// Slots kept for structural anchors (top Objectives) after relevance hits.
const STRUCTURAL_RESERVE = 6;
const SEGMENT_TARGET_CHARS = 280;
const MAX_SEGMENTS = 6;
// A restructure needs to see what sits INSIDE the nodes it names ("make X its
// own project" has to move X's steps too): the children of the top hits.
const EXPAND_TOP_HITS = 4;
const EXPAND_CHILDREN_EACH = 6;
// Per-segment nearest neighbours, and a floor that only removes noise.
const SEMANTIC_K = 6;
const SEMANTIC_MIN_SIMILARITY = 0.5;
// How much lexical overlap adds on top of semantic similarity when ranking.
const LEXICAL_WEIGHT = 0.12;

// Title words too generic to signal relevance on their own.
const LEXICAL_IGNORE = new Set([
  "project", "task", "goal", "work", "plan", "new", "thing", "stuff", "get", "make", "do",
]);


export interface RetrievalNode {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  importance_index: number | null;
}

export interface ContextNodeForPrompt {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  parent_title: string | null;
}

// Split a dump into a few topic-sized segments so a multi-topic dump retrieves
// neighbours for EACH topic (one averaged embedding would blur them).
export function segmentDump(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= SEGMENT_TARGET_CHARS) return [trimmed];

  const units = trimmed
    .split(/(?<=[.!?])\s+|\n+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  const pack = (target: number): string[] => {
    const out: string[] = [];
    let current = "";
    for (const unit of units) {
      if (current && current.length + unit.length + 1 > target) {
        out.push(current);
        current = unit;
      } else {
        current = current ? `${current} ${unit}` : unit;
      }
    }
    if (current) out.push(current);
    return out;
  };

  // Grow the target until everything fits in MAX_SEGMENTS — never truncate, or
  // the end of a long dump would get no retrieval at all.
  let target = SEGMENT_TARGET_CHARS;
  let segments = pack(target);
  while (segments.length > MAX_SEGMENTS) {
    target = Math.ceil(target * 1.25);
    segments = pack(target);
  }
  return segments;
}

// Overlap between the dump's words and each node title, normalised by title
// length. Cheap, deterministic, and covers nodes without embeddings.
export function lexicalScores(
  text: string,
  nodes: Array<{ id: string; title: string }>,
): Map<string, number> {
  const dumpTokens = new Set(titleTokens(text).filter((t) => !LEXICAL_IGNORE.has(t)));
  const scores = new Map<string, number>();
  for (const node of nodes) {
    const tokens = [...new Set(titleTokens(node.title))].filter((t) => !LEXICAL_IGNORE.has(t));
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((t) => dumpTokens.has(t)).length;
    if (overlap > 0) scores.set(node.id, overlap / Math.sqrt(tokens.length));
  }
  return scores;
}

export function selectContextNodes(params: {
  nodes: RetrievalNode[];
  parentOf: Map<string, string>;
  semantic: Map<string, number>;
  lexical: Map<string, number>;
  rootNodeId: string | null;
  budget?: number;
  // Also show the children of the most relevant hits (see EXPAND_TOP_HITS).
  expandChildren?: boolean;
}): ContextNodeForPrompt[] {
  const budget = params.budget ?? MAX_CONTEXT_NODES;
  const byId = new Map(params.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  if (params.expandChildren) {
    for (const [child, parent] of params.parentOf) {
      if (!byId.has(child)) continue;
      const list = childrenOf.get(parent);
      if (list) list.push(child);
      else childrenOf.set(parent, [child]);
    }
  }

  const relevance = new Map<string, number>();
  for (const [id, sim] of params.semantic) relevance.set(id, sim);
  for (const [id, lex] of params.lexical) {
    relevance.set(id, (relevance.get(id) ?? 0) + LEXICAL_WEIGHT * Math.min(lex, 2));
  }
  const ranked = [...relevance.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  const selected: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    if (!id || seen.has(id) || !byId.has(id) || selected.length >= budget) return;
    seen.add(id);
    selected.push(id);
  };

  add(params.rootNodeId ?? undefined);

  // Relevance hits first, each followed by its parent + grandparent so the
  // model sees WHERE it lives and can attach new children at the right level.
  const relevantCap = Math.max(budget - STRUCTURAL_RESERVE, 1);
  for (const [rank, id] of ranked.entries()) {
    if (selected.length >= relevantCap) break;
    add(id);
    const parent = params.parentOf.get(id);
    add(parent);
    add(parent ? params.parentOf.get(parent) : undefined);
    if (rank < EXPAND_TOP_HITS && id !== params.rootNodeId) {
      for (const child of (childrenOf.get(id) ?? []).slice(0, EXPAND_CHILDREN_EACH)) {
        if (selected.length >= relevantCap) break;
        add(child);
      }
    }
  }

  // Structural skeleton: the most important Objectives, so a dump about a new
  // area can still attach to the right existing branch.
  const structural = params.nodes
    .filter((n) => CONTAINER_TYPES.has(n.node_type))
    .sort(
      (a, b) =>
        (b.current_importance_score ?? b.importance_index ?? 0) -
        (a.current_importance_score ?? a.importance_index ?? 0),
    );
  for (const node of structural) {
    if (selected.length >= budget) break;
    add(node.id);
  }

  return selected.map((id) => {
    const node = byId.get(id)!;
    const parentId = params.parentOf.get(id);
    return {
      id: node.id,
      title: node.title,
      summary: node.summary,
      node_type: node.node_type,
      parent_title: parentId ? (byId.get(parentId)?.title ?? null) : null,
    };
  });
}

export interface RetrievalStats {
  mode: "semantic+lexical" | "lexical-only";
  segments: number;
  semanticHits: number;
  lexicalHits: number;
  contextNodes: number;
}

// Best-effort: if embeddings are unavailable, retrieval degrades to lexical +
// structural (still strictly better than the old importance-only slice).
export async function retrieveRelevantNodes(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  rawText: string;
  nodes: RetrievalNode[];
  parentOf: Map<string, string>;
  rootNodeId: string | null;
  expandChildren?: boolean;
}): Promise<{ contextNodes: ContextNodeForPrompt[]; stats: RetrievalStats }> {
  const segments = segmentDump(params.rawText);
  const semantic = new Map<string, number>();
  let semanticOk = false;

  if (segments.length > 0 && params.nodes.length > 0) {
    try {
      const vectors = await embedTexts({
        texts: segments,
        userId: params.userId,
        workspaceId: params.workspaceId,
        supabase: params.supabase,
      });
      const lists = await Promise.all(
        vectors.map((vector) =>
          matchNodesByVector({
            vector,
            userId: params.userId,
            workspaceId: params.workspaceId,
            supabase: params.supabase,
            limit: SEMANTIC_K,
          }),
        ),
      );
      for (const list of lists) {
        for (const match of list) {
          if (match.similarity < SEMANTIC_MIN_SIMILARITY) continue;
          semantic.set(match.node_id, Math.max(semantic.get(match.node_id) ?? 0, match.similarity));
        }
      }
      semanticOk = vectors.length > 0;
    } catch (err) {
      console.warn(
        "[retrieval] semantic retrieval unavailable — using lexical + structural:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const lexical = lexicalScores(params.rawText, params.nodes);
  const contextNodes = selectContextNodes({
    nodes: params.nodes,
    parentOf: params.parentOf,
    semantic,
    lexical,
    rootNodeId: params.rootNodeId,
    expandChildren: params.expandChildren,
  });

  return {
    contextNodes,
    stats: {
      mode: semanticOk ? "semantic+lexical" : "lexical-only",
      segments: segments.length,
      semanticHits: semantic.size,
      lexicalHits: lexical.size,
      contextNodes: contextNodes.length,
    },
  };
}
