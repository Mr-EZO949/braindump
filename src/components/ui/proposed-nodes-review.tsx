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

interface ProposedNodesReviewProps {
  existingNodeTitles: Record<string, string>;
  proposals: ProposedNode[];
  onAccept: (
    actions: Array<{
      id: string;
      action: "accept" | "reject";
      edits?: { proposed_title: string; proposed_summary: string | null; proposed_node_type: string };
    }>
  ) => Promise<void>;
  onClose: () => void;
  submitting: boolean;
  // Questions the extractor raised about vague or ambiguous fragments — shown
  // above the node list. Clicking one opens chat seeded with the question.
  clarifyingQuestions?: string[];
  onAnswerQuestion?: (question: string) => void;
}

export function ProposedNodesReview({
  existingNodeTitles,
  proposals,
  onAccept,
  onClose,
  submitting,
  clarifyingQuestions = [],
  onAnswerQuestion,
}: ProposedNodesReviewProps) {
  const hasQuestions = clarifyingQuestions.length > 0;
  const hasProposals = proposals.length > 0;
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
  const dupCount = proposals.filter(
    (p) => (duplicatesByProposal[p.id]?.length ?? 0) > 0,
  ).length;

  const handleSubmit = async (mode: "accept-checked" | "reject-all") => {
    if (submitting) return;
    if (mode === "reject-all") {
      await onAccept(proposals.map((p) => ({ id: p.id, action: "reject" })));
      return;
    }
    const actions = proposals.map((p) => ({
      id: p.id,
      action: (checked.has(p.id) ? "accept" : "reject") as "accept" | "reject",
      edits: checked.has(p.id)
        ? {
            proposed_title: edits[p.id].proposed_title,
            proposed_summary: edits[p.id].proposed_summary || null,
            proposed_node_type: edits[p.id].proposed_node_type,
          }
        : undefined,
    }));
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
            {clarifyingQuestions.map((q, i) => (
              <li key={i} className="prn-question">
                <span className="prn-question-text">{q}</span>
                {onAnswerQuestion && (
                  <button
                    className="prn-question-reply"
                    onClick={() => onAnswerQuestion(q)}
                    type="button"
                  >
                    Answer in chat
                  </button>
                )}
              </li>
            ))}
          </ul>
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
                disabled={submitting || acceptCount === 0}
                onClick={() => void handleSubmit("accept-checked")}
                type="button"
              >
                {submitting ? "Saving…" : `Add ${acceptCount} node${acceptCount !== 1 ? "s" : ""}`}
              </button>
            </>
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
