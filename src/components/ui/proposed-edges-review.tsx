"use client";

import { useState } from "react";
import type { ProposedEdgeWithNodes } from "@/lib/ai/connection";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import type { NodeType } from "@/types/graph";

interface Props {
  edges: ProposedEdgeWithNodes[];
  onConfirm: (actions: { id: string; action: "accept" | "reject" }[]) => void;
  onDismiss: () => void;
}

function nodeColor(type: string): string {
  return NODE_COLOR_BY_TYPE[type as NodeType] ?? "#677480";
}

export function ProposedEdgesReview({ edges, onConfirm, onDismiss }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(edges.map((e) => e.id)));
  const [submitting, setSubmitting] = useState(false);

  function toggle(id: string) {
    if (submitting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    const actions = edges.map((e) => ({
      id: e.id,
      action: selected.has(e.id) ? ("accept" as const) : ("reject" as const),
    }));
    onConfirm(actions);
  }

  const selectedCount = selected.size;

  return (
    <div className="per-backdrop">
      <div className="per-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="per-header">
          <span className="per-modal-label">Suggested connections</span>
          <span className="per-modal-sub">{edges.length} found</span>
        </div>

        {/* Edge list */}
        <div className="per-list">
          {edges.map((edge) => {
            const isChecked = selected.has(edge.id);
            const srcColor = nodeColor(edge.source_node_type);
            const tgtColor = nodeColor(edge.target_node_type);
            const pct = Math.round(edge.confidence * 100);

            return (
              <div
                key={edge.id}
                className={`per-edge${isChecked ? " per-edge--on" : ""}`}
                onClick={() => toggle(edge.id)}
              >
                {/* Checkbox */}
                <div className={`per-check${isChecked ? " per-check--on" : ""}`}>
                  {isChecked && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>

                {/* Content */}
                <div className="per-body">
                  {/* Nodes row */}
                  <div className="per-nodes-row">
                    <span className="per-node-pill" style={{ borderColor: srcColor, color: srcColor }}>
                      {edge.source_title}
                    </span>
                    <span className="per-arrow">→</span>
                    <span className="per-edge-type">{edge.edge_type.replace(/_/g, " ")}</span>
                    <span className="per-arrow">→</span>
                    <span className="per-node-pill" style={{ borderColor: tgtColor, color: tgtColor }}>
                      {edge.target_title}
                    </span>
                  </div>

                  {/* Explanation */}
                  {edge.explanation && (
                    <p className="per-explanation">{edge.explanation}</p>
                  )}

                  {/* Meta */}
                  <div className="per-meta">
                    <span className="per-conf">{pct}% confidence</span>
                    <span className="per-type-tag" style={{ color: srcColor }}>
                      {edge.source_node_type}
                    </span>
                    <span className="per-meta-sep">·</span>
                    <span className="per-type-tag" style={{ color: tgtColor }}>
                      {edge.target_node_type}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="per-footer">
          <span className="per-footer-hint">
            {selectedCount} of {edges.length} selected
          </span>
          <div className="per-footer-actions">
            <button className="per-btn-ghost" onClick={onDismiss} disabled={submitting}>
              Dismiss
            </button>
            <button className="per-btn-primary" onClick={handleConfirm} disabled={submitting}>
              {submitting ? "Adding..." : `Add ${selectedCount} connection${selectedCount !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
