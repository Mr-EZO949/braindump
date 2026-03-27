"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon } from "@/components/ui/icons";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import type { NodeType } from "@/types/graph";
import type { ProposedNode } from "@/types/ai";

const NODE_TYPES: NodeType[] = [
  "task", "project", "goal", "concept", "idea", "class", "journal", "question",
];

interface EditState {
  proposed_title: string;
  proposed_summary: string;
  proposed_node_type: NodeType;
}

interface ProposedNodesReviewProps {
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
}

export function ProposedNodesReview({
  proposals,
  onAccept,
  onClose,
  submitting,
}: ProposedNodesReviewProps) {
  const [checked, setChecked] = useState<Set<string>>(
    new Set(proposals.map((p) => p.id))
  );
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

  const toggle = (id: string) => {
    if (editingId === id) return;
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allChecked = checked.size === proposals.length;
  const acceptCount = checked.size;

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
            {proposals.length} node{proposals.length !== 1 ? "s" : ""} extracted
          </span>
        </div>
        <div className="prn-modal-header-right">
          <button
            className="prn-modal-toggle"
            onClick={() =>
              setChecked(allChecked ? new Set() : new Set(proposals.map((p) => p.id)))
            }
            type="button"
          >
            {allChecked ? "Deselect all" : "Select all"}
          </button>
          <button aria-label="Close" className="prn-modal-close" onClick={onClose} type="button">
            <CloseIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Node list */}
      <div className="prn-modal-list">
        {proposals.map((proposal, i) => {
          const edit = edits[proposal.id];
          const isChecked = checked.has(proposal.id);
          const isEditing = editingId === proposal.id;
          const color = NODE_COLOR_BY_TYPE[edit.proposed_node_type] ?? "#677480";

          return (
            <div key={proposal.id}>
              {i > 0 && <div className="prn-divider" />}

              <div
                className={`prn-node${isChecked ? " prn-node--on" : ""}${isEditing ? " prn-node--editing" : ""}`}
                onClick={() => toggle(proposal.id)}
              >
                {/* Color stripe */}
                <div className="prn-stripe" style={{ background: color }} />

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
          {acceptCount === 0
            ? "None selected"
            : `${acceptCount} of ${proposals.length} selected`}
        </div>
        <div className="prn-modal-actions">
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
        </div>
      </div>
    </motion.div>
  );
}
