// Semantic duplicate resolution — "is this new item the SAME thing as an
// existing node?"
//
// Calibrated on 9,746 real node pairs from the live database (2026-09-28,
// gemini-embedding-001, 3072-d). Finding: cosine similarity ALONE cannot
// separate duplicates from siblings. The single most similar pair was
// "TA Shift Wednesday" / "TA Shift Thursday" (0.954 — two different shifts);
// "Pass Machine Learning" / "Pass Deep Learning" scored 0.948 (two courses).
// Meanwhile a real duplicate scored LOWER: "Interview Readiness" / "Maintain
// Interview Readiness" 0.927 (and "Stripe Online Assessment" twins 0.857–0.892).
// No threshold works.
//
// What does separate them is CONTRAST — over each node's PATH (parent › title),
// not just its title:
//   • distinct items differ on BOTH sides — each has a word the other lacks
//     (Wednesday vs Thursday, Machine vs Deep);
//   • duplicates differ on ONE side only — one just adds qualifiers ("Maintain …");
//   • a container and an item inside it are never duplicates ("Stats 302" the
//     class vs "Stats 302 Midterm Review" the task, 0.936).
// Why the PATH: "Choose Gym App Stack and Set Up Repo" vs "Choose Stack and Set
// Up Repo" (0.899) looks one-sided by title — but they sit under "Gym App" and
// "Student Tracker App": the same kind of task for two different projects. With
// parents included the difference is two-sided (gym vs student/tracker), so they
// stay separate. A real end-to-end replay caught this; title-only would have
// merged them.
// So embeddings GENERATE candidates and this rule DECIDES. It is deliberately
// conservative: abbreviations ("DL" vs "Deep Learning") are left to the
// extraction model, which now sees the relevant existing nodes (retrieval), and
// get flagged as "possible duplicates" so they're never auto-applied.

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts, matchNodesByVector } from "./embeddings";

// Candidates below this can't be duplicates (p99 of all pairs is 0.860).
export const DEDUP_SIMILARITY_FLOOR = 0.85;
// Same-level candidates at/above this that the rule DIDN'T call "same" are
// surfaced as possible duplicates (held for review, never auto-applied).
export const POSSIBLE_DUPLICATE_FLOOR = 0.9;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "at", "by", "with", "and", "or",
  "my", "this", "that", "from", "into", "about", "is", "be", "it", "its",
]);

// Words that change WHICH instance/scope is meant. If the only difference
// between two titles includes one of these, they're different items
// ("Week 4 Long Run" ≠ "Long Run", "Monday standup" ≠ "standup").
const DISCRIMINATING_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "first", "second", "third", "fourth", "fifth", "last", "next", "final", "midterm",
]);

type Level = "container" | "leaf" | "either";

// Containers hold work; leaves are the work. A container and a leaf are never
// the same item, however similar the words. A big task sits between the two —
// it is one deliverable that holds its steps — and the same item is often a
// task or a project in older graphs ("Pass ML Exam"), so it can match either.
// ("concept" is the legacy grouping type.)
export function nodeLevel(nodeType: string): Level {
  if (nodeType === "big_task") return "either";
  return nodeType === "goal" ||
    nodeType === "project" ||
    nodeType === "class" ||
    nodeType === "area" ||
    nodeType === "concept"
    ? "container"
    : "leaf";
}

function levelsCanMatch(a: string, b: string): boolean {
  const la = nodeLevel(a);
  const lb = nodeLevel(b);
  return la === lb || la === "either" || lb === "either";
}

function stem(token: string): string {
  // Light plural folding ("papers" → "paper") without mangling "class"/"readiness".
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok))
    .map(stem);
}

function isDiscriminating(token: string): boolean {
  return /\d/.test(token) || DISCRIMINATING_WORDS.has(token);
}

// `certainlyDistinct`: the rule is SURE these are different items (so a close
// score must not even flag them as a possible duplicate) — e.g. both titles
// name a different day/number ("TA Shift Wednesday" vs "… Thursday").
export type SameItemVerdict = { same: boolean; certainlyDistinct: boolean; reason: string };

export interface ComparableItem {
  title: string;
  node_type: string;
  // Title of the node's parent (null/absent when top-level). Part of identity.
  parent_title?: string | null;
}

function sameTokenSet(x: string | null | undefined, y: string | null | undefined): boolean {
  if (!x || !y) return false;
  const a = new Set(titleTokens(x));
  const b = new Set(titleTokens(y));
  return a.size > 0 && a.size === b.size && [...a].every((t) => b.has(t));
}

// Two checks, in order — titles first, then parents (NOT merged into one token
// set: a parent like "Work, Study & Hockey" would then hide that "Study 5 Days
// Per Week" and "Work 5 Days Per Week" differ — a false merge the real-data scan
// caught).
export function judgeSameItem(
  a: ComparableItem,
  b: ComparableItem,
  similarity: number,
): SameItemVerdict {
  if (similarity < DEDUP_SIMILARITY_FLOOR) {
    return { same: false, certainlyDistinct: true, reason: "not similar enough" };
  }
  // Different levels are different items — unless the titles are the same
  // words: then it's one item typed differently by an older graph ("Pass ML
  // Exam" as a task then, a goal now).
  if (!levelsCanMatch(a.node_type, b.node_type) && !sameTokenSet(a.title, b.title)) {
    return { same: false, certainlyDistinct: true, reason: "a container and an item inside it" };
  }

  // 1. Titles, contrastively.
  const tokensA = new Set(titleTokens(a.title));
  const tokensB = new Set(titleTokens(b.title));
  if (tokensA.size === 0 || tokensB.size === 0) {
    return { same: false, certainlyDistinct: false, reason: "empty title" };
  }
  const onlyA = [...tokensA].filter((t) => !tokensB.has(t));
  const onlyB = [...tokensB].filter((t) => !tokensA.has(t));
  if (onlyA.length > 0 && onlyB.length > 0) {
    // Both name a different day/number → different instances, certainly.
    // One sits directly under the other (a class and the project inside it)
    // with different words → a node and its child, certainly different.
    // Otherwise it may be an abbreviation ("DL" vs "Deep Learning") — not sure.
    const bothScoped = onlyA.some(isDiscriminating) && onlyB.some(isDiscriminating);
    const parentAndChild =
      sameTokenSet(a.parent_title, b.title) || sameTokenSet(b.parent_title, a.title);
    return {
      same: false,
      certainlyDistinct: bothScoped || parentAndChild,
      reason: bothScoped
        ? "different instances (each names its own day, date or number)"
        : parentAndChild
          ? "one sits inside the other"
          : "each title has its own distinguishing words",
    };
  }
  const extra = onlyA.length > 0 ? onlyA : onlyB;
  if (extra.length > 0) {
    const sharedCount = [...tokensA].filter((t) => tokensB.has(t)).length;
    if (sharedCount < 2) {
      return { same: false, certainlyDistinct: false, reason: "too little shared wording to be sure" };
    }
    if (extra.some(isDiscriminating)) {
      return {
        same: false,
        certainlyDistinct: true,
        reason: "the extra words change the scope (a date, day or number)",
      };
    }
  }

  // 2. Parents. The same kind of item under two DIFFERENT parents is two items
  // ("Choose Stack and Set Up Repo" under Gym App vs under Student Tracker).
  // Exceptions: one side is top-level (attaching context doesn't change what
  // it is), or one is nested inside its own twin (the parent IS the other item).
  const nestedInTwin = sameTokenSet(a.parent_title, b.title) || sameTokenSet(b.parent_title, a.title);
  if (
    a.parent_title &&
    b.parent_title &&
    !nestedInTwin &&
    !sameTokenSet(a.parent_title, b.parent_title)
  ) {
    return {
      same: false,
      certainlyDistinct: true,
      reason: "the same kind of item under different parents",
    };
  }

  return {
    same: true,
    certainlyDistinct: false,
    reason: extra.length === 0 ? "same wording" : "one title only adds qualifiers to the other",
  };
}

export interface ProposalForResolution {
  local_ref: string;
  proposed_title: string;
  proposed_summary?: string | null;
  proposed_node_type: string;
  // Title of the parent it will attach under (same-dump or existing), if any.
  parent_title?: string | null;
}

export interface ResolutionMatch {
  existingId: string;
  existingTitle: string;
  similarity: number;
  reason: string;
}

export interface ResolutionOutcome {
  // local_ref → the existing node it duplicates (drop it; re-home its children).
  duplicates: Map<string, ResolutionMatch>;
  // local_ref → a close same-level node the rule wasn't sure about (review only).
  possibleDuplicates: Map<string, ResolutionMatch>;
  // dropped local_ref → kept local_ref, for the same item emitted twice in ONE
  // dump (drop the later copy; point its references at the kept one).
  intraDuplicates: Map<string, string>;
  // Embedded text → its vector: the new nodes reuse them (node-intake.ts).
  vectors: Map<string, number[]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

// The same dump sometimes emits one item twice. In the live data this was HALF
// of all real duplicates ("Interview Readiness" + "Maintain Interview
// Readiness"; "Choose Gym App Stack and Set Up Repo" + "Choose Stack and Set Up
// Repo" — each pair came out of a single dump), and retrieval can't help there
// because neither node existed yet. Same contrastive rule, applied pairwise.
// The EARLIER proposal is kept — the prompt lists parents before children, so
// the survivor is the one other items hang under.
export function findIntraDumpDuplicates(
  proposals: ProposalForResolution[],
  vectors: number[][],
): Map<string, string> {
  const droppedToKept = new Map<string, string>();
  const resolveKept = (ref: string) => {
    let current = ref;
    while (droppedToKept.has(current)) current = droppedToKept.get(current)!;
    return current;
  };
  for (let j = 1; j < proposals.length; j++) {
    for (let i = 0; i < j; i++) {
      if (droppedToKept.has(proposals[j].local_ref)) break;
      const a = proposals[i];
      const b = proposals[j];
      const similarity = cosineSimilarity(vectors[i] ?? [], vectors[j] ?? []);
      const verdict = judgeSameItem(
        { title: a.proposed_title, node_type: a.proposed_node_type, parent_title: a.parent_title },
        { title: b.proposed_title, node_type: b.proposed_node_type, parent_title: b.parent_title },
        similarity,
      );
      if (verdict.same) {
        droppedToKept.set(b.local_ref, resolveKept(a.local_ref));
      }
    }
  }
  return droppedToKept;
}

// Best-effort: one batch embedding for all proposals, then an exact per-
// workspace similarity search each. Callers wrap this in try/catch and fall
// back to exact-title dedup if embeddings are unavailable.
export async function resolveProposalsAgainstGraph(params: {
  proposals: ProposalForResolution[];
  userId: string;
  workspaceId: string;
  supabase: SupabaseClient;
  // Parent title of an EXISTING node (from the workspace tree), for paths.
  existingParentTitle?: (nodeId: string) => string | null;
}): Promise<ResolutionOutcome> {
  const outcome: ResolutionOutcome = {
    duplicates: new Map(),
    possibleDuplicates: new Map(),
    intraDuplicates: new Map(),
    vectors: new Map(),
  };
  const { proposals } = params;
  if (proposals.length === 0) return outcome;

  const texts = proposals.map((p) => [p.proposed_title, p.proposed_summary].filter(Boolean).join("\n"));
  const vectors = await embedTexts({
    texts,
    userId: params.userId,
    workspaceId: params.workspaceId,
    supabase: params.supabase,
  });
  if (vectors.length !== proposals.length) return outcome;
  texts.forEach((text, index) => outcome.vectors.set(text, vectors[index]));

  // Free: the proposals are already embedded.
  outcome.intraDuplicates = findIntraDumpDuplicates(proposals, vectors);

  const candidateLists = await Promise.all(
    vectors.map((vector) =>
      matchNodesByVector({
        vector,
        userId: params.userId,
        workspaceId: params.workspaceId,
        supabase: params.supabase,
        limit: 5,
      }),
    ),
  );

  proposals.forEach((proposal, index) => {
    const self: ComparableItem = {
      title: proposal.proposed_title,
      node_type: proposal.proposed_node_type,
      parent_title: proposal.parent_title,
    };
    for (const candidate of candidateLists[index] ?? []) {
      const existing: ComparableItem = {
        title: candidate.title,
        node_type: candidate.node_type,
        parent_title: params.existingParentTitle?.(candidate.node_id) ?? null,
      };
      const verdict = judgeSameItem(self, existing, candidate.similarity);
      if (verdict.same) {
        outcome.duplicates.set(proposal.local_ref, {
          existingId: candidate.node_id,
          existingTitle: candidate.title,
          similarity: candidate.similarity,
          reason: verdict.reason,
        });
        outcome.possibleDuplicates.delete(proposal.local_ref);
        return;
      }
      if (
        candidate.similarity >= POSSIBLE_DUPLICATE_FLOOR &&
        !verdict.certainlyDistinct &&
        !outcome.possibleDuplicates.has(proposal.local_ref)
      ) {
        outcome.possibleDuplicates.set(proposal.local_ref, {
          existingId: candidate.node_id,
          existingTitle: candidate.title,
          similarity: candidate.similarity,
          reason: verdict.reason,
        });
      }
    }
  });

  return outcome;
}
