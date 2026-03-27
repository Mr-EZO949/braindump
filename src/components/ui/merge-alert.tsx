"use client";

import type { MergeCandidate } from "@/lib/ai/merge";

interface Props {
  candidates: MergeCandidate[];
  onKeepBoth: (candidate: MergeCandidate) => void;
  onRemoveNew: (candidate: MergeCandidate) => void;
}

export function MergeAlert({ candidates, onKeepBoth, onRemoveNew }: Props) {
  if (candidates.length === 0) return null;

  return (
    <div className="merge-alert-stack">
      {candidates.map((c) => {
        const pct = Math.round(c.similarity * 100);
        return (
          <div key={c.new_node_id} className="merge-alert">
            <div className="merge-alert-icon">⚠</div>
            <div className="merge-alert-body">
              <p className="merge-alert-msg">
                <strong>{c.new_node_title}</strong> looks like an existing node:{" "}
                <strong>{c.existing_node_title}</strong>
                <span className="merge-alert-pct">{pct}% similar</span>
              </p>
            </div>
            <div className="merge-alert-actions">
              <button
                className="merge-btn-keep"
                onClick={() => onKeepBoth(c)}
              >
                Keep both
              </button>
              <button
                className="merge-btn-remove"
                onClick={() => onRemoveNew(c)}
              >
                Remove new
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
