"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { CloseIcon } from "@/components/ui/icons";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import type { NodeType } from "@/types/graph";
import type { ProposedNode } from "@/types/ai";

const NODE_TYPES: NodeType[] = [
  "task", "project", "goal", "habit", "concept", "idea", "class",
];

// ---------------------------------------------------------------------------
// Lightweight client-side duplicate detection
// Normalizes titles and checks for near-matches against existing graph nodes.
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

/** Jaccard similarity between two token sets (0–1). */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

const DUPLICATE_THRESHOLD = 0.6;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

interface DuplicateMatch {
  nodeId: string;
  title: string;
  similarity: number;
}

function findSimilarNodes(
  proposedTitle: string,
  existingNodes: Array<{ id: string; title: string }>,
): DuplicateMatch[] {
  const proposedTokens = tokenSet(proposedTitle);
  const proposedNorm = normalize(proposedTitle);
  if (!proposedNorm) return [];

  const matches: DuplicateMatch[] = [];
  for (const node of existingNodes) {
    const existingNorm = normalize(node.title);
    if (!existingNorm) continue;

    // Exact normalized match
    if (proposedNorm === existingNorm) {
      matches.push({ nodeId: node.id, title: node.title, similarity: 1 });
      continue;
    }

    // Substring containment (one fully contains the other)
    if (proposedNorm.includes(existingNorm) || existingNorm.includes(proposedNorm)) {
      matches.push({ nodeId: node.id, title: node.title, similarity: 0.85 });
      continue;
    }

    // Token-based similarity
    const sim = jaccardSimilarity(proposedTokens, tokenSet(node.title));
    if (sim >= DUPLICATE_THRESHOLD) {
      matches.push({ nodeId: node.id, title: node.title, similarity: sim });
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 2);
}

// ---------------------------------------------------------------------------

interface EditState {
  proposed_title: string;
  proposed_summary: string;
  proposed_node_type: NodeType;
}

// A life-area branch the extractor inferred from the dump (mirrors the
// wizard's step 2). Kept as a local shape so this client file never imports
// the server-only areas module (which pulls in the Anthropic SDK).
export interface SuggestedAreaOption {
  title: string;
  area_type: string;
}

interface ProposedNodesReviewProps {
  existingNodeTitles: Record<string, string>;
  proposals: ProposedNode[];
  // Life-areas inferred from this dump. The modal shows the ones that don't
  // already exist as togglable chips; accepted ones are created as top-level
  // branches via onAddAreas before the node acceptance runs.
  suggestedAreas?: SuggestedAreaOption[];
  onAddAreas?: (areas: SuggestedAreaOption[]) => Promise<void>;
  onAccept: (
    actions: Array<{
      id: string;
      action: "accept" | "reject";
      // When a proposal is rejected because it duplicates an existing
      // canonical node, this carries the canonical node's id so the server
      // can re-parent any proposed children to it (instead of orphaning
      // them when their proposed parent is rejected).
      replaced_by_node_id?: string;
      edits?: { proposed_title: string; proposed_summary: string | null; proposed_node_type: string };
    }>
  ) => Promise<void>;
  onClose: () => void;
  submitting: boolean;
  // Questions the extractor raised about vague or ambiguous fragments — shown
  // above the node list. Each gets an inline reply input; answered ones
  // hand a Q→A pair to the chat rail in the background. Unanswered ones
  // get auto-dispatched to chat after the modal closes.
  clarifyingQuestions?: string[];
  // Called the first time the user submits an inline answer to a question.
  // The parent records which question/answer pairs have already been sent
  // to chat so unanswered ones can be dispatched on close.
  onAnswerInline?: (question: string, answer: string) => void;
}

export function ProposedNodesReview({
  existingNodeTitles,
  proposals,
  suggestedAreas = [],
  onAddAreas,
  onAccept,
  onClose,
  submitting,
  clarifyingQuestions = [],
  onAnswerInline,
}: ProposedNodesReviewProps) {
  const hasQuestions = clarifyingQuestions.length > 0;
  const hasProposals = proposals.length > 0;

  // Only offer areas that don't already exist as a node (case-insensitive) —
  // no point proposing a "Fitness" branch when one is already there.
  const newAreas = useMemo(() => {
    const existing = new Set(
      Object.values(existingNodeTitles).map((t) => t.trim().toLowerCase()),
    );
    const seen = new Set<string>();
    return suggestedAreas.filter((a) => {
      const key = a.title.trim().toLowerCase();
      if (!key || existing.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [suggestedAreas, existingNodeTitles]);
  // Areas start selected — they're high-signal branches from this dump.
  const [areaOn, setAreaOn] = useState<Set<string>>(
    () => new Set(newAreas.map((a) => a.title.toLowerCase())),
  );
  const toggleArea = (title: string) => {
    const key = title.toLowerCase();
    setAreaOn((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Per-question answer state. Each question's draft + submitted state is
  // tracked separately; once submitted we collapse the input into a small
  // "→ answer" stub so the user knows it landed in chat.
  const [answerDrafts, setAnswerDrafts] = useState<Record<number, string>>({});
  const [answeredAt, setAnsweredAt] = useState<Record<number, string>>({});

  function submitAnswer(idx: number, question: string) {
    const answer = (answerDrafts[idx] ?? "").trim();
    if (!answer) return;
    onAnswerInline?.(question, answer);
    setAnsweredAt((prev) => ({ ...prev, [idx]: answer }));
    setAnswerDrafts((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  }
  // Build list of existing nodes for duplicate checking
  const existingNodeList = useMemo(
    () => Object.entries(existingNodeTitles).map(([id, title]) => ({ id, title })),
    [existingNodeTitles],
  );

  // Compute initial duplicate matches for each proposal
  const initialDuplicates = useMemo(() => {
    const result: Record<string, DuplicateMatch[]> = {};
    for (const proposal of proposals) {
      result[proposal.id] = findSimilarNodes(proposal.proposed_title, existingNodeList);
    }
    return result;
  }, [proposals, existingNodeList]);

  // Auto-uncheck proposals with high-confidence duplicates
  const [checked, setChecked] = useState<Set<string>>(() => {
    const initial = new Set(proposals.map((p) => p.id));
    for (const proposal of proposals) {
      const dupes = initialDuplicates[proposal.id] ?? [];
      if (dupes.some((d) => d.similarity >= HIGH_CONFIDENCE_THRESHOLD)) {
        initial.delete(proposal.id);
      }
    }
    return initial;
  });

  const [edits, setEdits] = useState<Record<string, EditState>>(() =>
    Object.fromEntries(
      proposals.map((p) => [
        p.id,
        {
          proposed_title: p.proposed_title,
          proposed_summary: p.proposed_summary ?? "",
          proposed_node_type: p.proposed_node_type as NodeType,
        },
      ])
    )
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  // Recompute duplicates when edits change
  const duplicatesByProposal = useMemo(() => {
    const result: Record<string, DuplicateMatch[]> = {};
    for (const proposal of proposals) {
      const edit = edits[proposal.id];
      if (edit) {
        result[proposal.id] = findSimilarNodes(edit.proposed_title, existingNodeList);
      }
    }
    return result;
  }, [proposals, edits, existingNodeList]);

  const toggle = (id: string) => {
    if (editingId === id) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const allChecked = checked.size === proposals.length;
  const acceptCount = checked.size;
  const selectedAreaCount = newAreas.filter((a) => areaOn.has(a.title.toLowerCase())).length;
  const dupCount = proposals.filter(
    (p) => (duplicatesByProposal[p.id]?.length ?? 0) > 0,
  ).length;

  const handleSubmit = async (mode: "accept-checked" | "reject-all") => {
    if (submitting) return;
    if (mode === "reject-all") {
      await onAccept(proposals.map((p) => ({ id: p.id, action: "reject" })));
      return;
    }
    // Create the selected life-area branches first (so they exist as anchors
    // before connection analysis links the accepted nodes to them).
    const areasToAdd = newAreas.filter((a) => areaOn.has(a.title.toLowerCase()));
    if (areasToAdd.length > 0 && onAddAreas) {
      await onAddAreas(areasToAdd);
    }
    const actions = proposals.map((p) => {
      const isAccept = checked.has(p.id);
      // For rejects, if the modal auto-unchecked this proposal because it
      // duplicates an existing node, pass the canonical node id so the
      // server re-parents any proposed children to it instead of orphaning
      // them (the long-standing merge desync).
      const replacement = !isAccept
        ? (duplicatesByProposal[p.id] ?? [])
            .filter((d) => d.similarity >= HIGH_CONFIDENCE_THRESHOLD)
            .sort((a, b) => b.similarity - a.similarity)[0]?.nodeId
        : undefined;
      return {
        id: p.id,
        action: (isAccept ? "accept" : "reject") as "accept" | "reject",
        replaced_by_node_id: replacement,
        edits: isAccept
          ? {
              proposed_title: edits[p.id].proposed_title,
              proposed_summary: edits[p.id].proposed_summary || null,
              proposed_node_type: edits[p.id].proposed_node_type,
            }
          : undefined,
      };
    });
    await onAccept(actions);
  };

  return (
    <motion.div
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="prn-modal"
      exit={{ opacity: 0, y: 8, scale: 0.99 }}
      initial={{ opacity: 0, y: 16, scale: 0.99 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Header */}
      <div className="prn-modal-header">
        <div className="prn-modal-header-left">
          <span className="prn-modal-label">From your brain dump</span>
          <span className="prn-modal-sub">
            {hasProposals
              ? `${proposals.length} node${proposals.length !== 1 ? "s" : ""} extracted`
              : hasQuestions
                ? `${clarifyingQuestions.length} question${clarifyingQuestions.length !== 1 ? "s" : ""} to clarify`
                : "Nothing to review"}
            {hasProposals && hasQuestions
              ? ` · ${clarifyingQuestions.length} question${clarifyingQuestions.length !== 1 ? "s" : ""}`
              : ""}
          </span>
        </div>
        <div className="prn-modal-header-right">
          {hasProposals && (
            <button
              className="prn-modal-toggle"
              onClick={() =>
                setChecked(allChecked ? new Set() : new Set(proposals.map((p) => p.id)))
              }
              type="button"
            >
              {allChecked ? "Deselect all" : "Select all"}
            </button>
          )}
          <button aria-label="Close" className="prn-modal-close" onClick={onClose} type="button">
            <CloseIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Suggested life-areas — top-level branches inferred from this dump.
          Toggle the ones to add; selected areas are created as branches when
          you accept, then the dump's nodes get linked under them. */}
      {newAreas.length > 0 && (
        <div className="prn-areas">
          <div className="prn-areas-header">
            <span className="prn-areas-label">Life-areas to branch under</span>
            <span className="prn-areas-hint">tap to include</span>
          </div>
          <div className="prn-areas-chips">
            {newAreas.map((a) => {
              const on = areaOn.has(a.title.toLowerCase());
              return (
                <button
                  key={a.title}
                  type="button"
                  className={`prn-area-chip${on ? " prn-area-chip--on" : ""}`}
                  onClick={() => toggleArea(a.title)}
                  aria-pressed={on}
                >
                  <span className="prn-area-chip-check" aria-hidden="true">
                    {on ? "✓" : "+"}
                  </span>
                  {a.title}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Clarifying questions — the extractor asks back for vague bits */}
      {hasQuestions && (
        <div className="prn-questions">
          <div className="prn-questions-header">
            <span className="prn-questions-icon">?</span>
            <span className="prn-questions-label">
              {hasProposals
                ? "A few bits were too vague to capture cleanly:"
                : "Nothing here was specific enough to capture yet:"}
            </span>
          </div>
          <ul className="prn-questions-list">
            {clarifyingQuestions.map((q, i) => {
              const submitted = answeredAt[i];
              return (
                <li key={i} className="prn-question">
                  <span className="prn-question-text">{q}</span>
                  {submitted ? (
                    <span className="prn-question-answer" title="Sent to chat">
                      <span className="prn-question-answer-arrow" aria-hidden="true">→</span>
                      {submitted}
                    </span>
                  ) : (
                    <div className="prn-question-replyrow">
                      <input
                        className="prn-question-input"
                        type="text"
                        placeholder="answer here…"
                        value={answerDrafts[i] ?? ""}
                        onChange={(e) =>
                          setAnswerDrafts((prev) => ({ ...prev, [i]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            submitAnswer(i, q);
                          }
                        }}
                        maxLength={400}
                      />
                      <button
                        type="button"
                        className="prn-question-send"
                        onClick={() => submitAnswer(i, q)}
                        disabled={!(answerDrafts[i] ?? "").trim()}
                        aria-label="Send answer to chat"
                      >
                        ↵
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="prn-questions-hint">
            Type a quick answer and hit enter — it threads into chat in the
            background. Anything you skip surfaces in chat after you&rsquo;re
            done reviewing.
          </p>
        </div>
      )}

      {/* Duplicate warning banner */}
      {dupCount > 0 && (
        <div className="prn-dup-banner">
          <span className="prn-dup-banner-icon">!</span>
          <span>
            {dupCount} node{dupCount !== 1 ? "s" : ""} may already exist in your graph.
            High-confidence matches have been unchecked.
          </span>
        </div>
      )}

      {/* Node list */}
      <div className="prn-modal-list">
        {proposals.map((proposal, i) => {
          const edit = edits[proposal.id];
          const isChecked = checked.has(proposal.id);
          const isEditing = editingId === proposal.id;
          const color = NODE_COLOR_BY_TYPE[edit.proposed_node_type] ?? "#677480";
          const existingParentTitle = proposal.existing_parent_node_id
            ? existingNodeTitles[proposal.existing_parent_node_id] ?? null
            : null;
          const dupes = duplicatesByProposal[proposal.id] ?? [];
          const hasHighConfDupe = dupes.some((d) => d.similarity >= HIGH_CONFIDENCE_THRESHOLD);

          return (
            <div key={proposal.id}>
              {i > 0 && <div className="prn-divider" />}

              <div
                className={`prn-node${isChecked ? " prn-node--on" : ""}${isEditing ? " prn-node--editing" : ""}${hasHighConfDupe ? " prn-node--dup" : ""}`}
                onClick={() => toggle(proposal.id)}
              >
                {/* Color stripe */}
                <div className="prn-stripe" style={{ background: hasHighConfDupe ? "rgb(234, 179, 8)" : color }} />

                {/* Checkbox */}
                <div className={`prn-check${isChecked ? " prn-check--on" : ""}`}>
                  {isChecked && (
                    <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                      <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>

                {/* Content */}
                {isEditing ? (
                  <div className="prn-edit-form" onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      className="prn-field"
                      onChange={(e) =>
                        setEdits((p) => ({ ...p, [proposal.id]: { ...p[proposal.id], proposed_title: e.target.value } }))
                      }
                      placeholder="Title"
                      value={edit.proposed_title}
                    />
                    <textarea
                      className="prn-field prn-field--area"
                      onChange={(e) =>
                        setEdits((p) => ({ ...p, [proposal.id]: { ...p[proposal.id], proposed_summary: e.target.value } }))
                      }
                      placeholder="Summary"
                      rows={2}
                      value={edit.proposed_summary}
                    />
                    <div className="prn-edit-row">
                      <select
                        className="prn-field prn-field--select"
                        onChange={(e) =>
                          setEdits((p) => ({ ...p, [proposal.id]: { ...p[proposal.id], proposed_node_type: e.target.value as NodeType } }))
                        }
                        value={edit.proposed_node_type}
                      >
                        {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button className="prn-done" onClick={() => setEditingId(null)} type="button">
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="prn-body">
                    <div className="prn-body-top">
                      <span className="prn-node-name">{edit.proposed_title}</span>
                      <span className="prn-type-label" style={{ color }}>{edit.proposed_node_type}</span>
                    </div>
                    {edit.proposed_summary && (
                      <p className="prn-desc">{edit.proposed_summary}</p>
                    )}
                    {existingParentTitle && (
                      <div className="prn-attach-hint">Attach under {existingParentTitle}</div>
                    )}
                    {dupes.length > 0 && (
                      <div className={`prn-dup-box${hasHighConfDupe ? " prn-dup-box--high" : ""}`}>
                        <div className="prn-dup-box-header">
                          <span className="prn-dup-box-icon">!</span>
                          <span className="prn-dup-box-label">
                            {hasHighConfDupe ? "Likely duplicate" : "Possible duplicate"}
                          </span>
                        </div>
                        <div className="prn-dup-box-matches">
                          {dupes.map((d) => (
                            <div key={d.nodeId} className="prn-dup-match">
                              <span className="prn-dup-match-title">{d.title}</span>
                              <span className="prn-dup-match-score">
                                {Math.round(d.similarity * 100)}% match
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="prn-body-bottom">
                      <span className="prn-conf">{Math.round(proposal.extraction_confidence * 100)}% confidence</span>
                      <button
                        className="prn-edit-link"
                        onClick={(e) => { e.stopPropagation(); setEditingId(proposal.id); }}
                        type="button"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="prn-modal-footer">
        <div className="prn-selected-hint">
          {hasProposals
            ? acceptCount === 0
              ? "None selected"
              : `${acceptCount} of ${proposals.length} selected`
            : hasQuestions
              ? "Answer a question above to continue"
              : ""}
        </div>
        <div className="prn-modal-actions">
          {hasProposals ? (
            <>
              <button
                className="prn-btn-ghost"
                disabled={submitting}
                onClick={() => void handleSubmit("reject-all")}
                type="button"
              >
                Reject all
              </button>
              <button
                className="prn-btn-primary"
                disabled={submitting || (acceptCount === 0 && selectedAreaCount === 0)}
                onClick={() => void handleSubmit("accept-checked")}
                type="button"
              >
                {submitting
                  ? "Saving…"
                  : acceptCount > 0
                    ? `Add ${acceptCount} node${acceptCount !== 1 ? "s" : ""}`
                    : `Add ${selectedAreaCount} branch${selectedAreaCount !== 1 ? "es" : ""}`}
              </button>
            </>
          ) : selectedAreaCount > 0 ? (
            <button
              className="prn-btn-primary"
              disabled={submitting}
              onClick={() => void handleSubmit("accept-checked")}
              type="button"
            >
              {submitting
                ? "Saving…"
                : `Add ${selectedAreaCount} branch${selectedAreaCount !== 1 ? "es" : ""}`}
            </button>
          ) : (
            <button
              className="prn-btn-ghost"
              disabled={submitting}
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
