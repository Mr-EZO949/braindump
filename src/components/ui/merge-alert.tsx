"use client";

// MergeAlert — Phase 11.3
// Side-by-side comparison modal for merge candidates.
// Three actions: Merge (keep existing, absorb new), Keep Both (dismiss), Never (suppress pair).

import type { MergeCandidate } from "@/lib/ai/merge";

interface Props {
  candidates: MergeCandidate[];
  onMerge: (candidate: MergeCandidate) => void;
  onKeepBoth: (candidate: MergeCandidate) => void;
  onNever: (candidate: MergeCandidate) => void;
}

function SimilarityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tier = pct >= 97 ? "merge-sim-bar--high" : pct >= 93 ? "merge-sim-bar--med" : "merge-sim-bar--low";
  return (
    <div className="merge-sim-row">
      <div className={`merge-sim-bar ${tier}`} style={{ width: `${pct}%` }} />
      <span className="merge-sim-label">{pct}% similar</span>
    </div>
  );
}

function NodeCard({
  label,
  title,
  summary,
  type,
}: {
  label: string;
  title: string;
  summary: string | null;
  type: string;
}) {
  return (
    <div className="merge-node-card">
      <p className="merge-node-card-label">{label}</p>
      <p className="merge-node-card-title">{title}</p>
      <p className="merge-node-card-type">{type}</p>
      {summary ? (
        <p className="merge-node-card-summary">{summary}</p>
      ) : (
        <p className="merge-node-card-no-summary">No summary</p>
      )}
    </div>
  );
}

export function MergeAlert({ candidates, onMerge, onKeepBoth, onNever }: Props) {
  if (candidates.length === 0) return null;

  return (
    <div className="merge-alert-stack">
      {candidates.map((c) => (
        <div key={c.new_node_id} className="merge-modal">
          {/* Header */}
          <div className="merge-modal-header">
            <p className="merge-modal-eyebrow">Possible duplicate detected</p>
            <SimilarityBar value={c.similarity} />
          </div>

          {/* Side-by-side */}
          <div className="merge-modal-body">
            <NodeCard
              label="New node"
              title={c.new_node_title}
              summary={c.new_node_summary}
              type={c.new_node_type}
            />
            <div className="merge-modal-divider">
              <span className="merge-modal-vs">vs</span>
            </div>
            <NodeCard
              label="Existing node"
              title={c.existing_node_title}
              summary={c.existing_node_summary}
              type={c.existing_node_type}
            />
          </div>

          {/* AI reason */}
          {c.ai_reason ? (
            <div className="merge-ai-reason">
              <span className="merge-ai-reason-icon">AI</span>
              <p className="merge-ai-reason-text">
                {c.ai_reason}
                {c.ai_confidence != null ? (
                  <span className="merge-ai-confidence">
                    {" "}({Math.round(c.ai_confidence * 100)}% confidence)
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}

          {/* Actions */}
          <div className="merge-modal-actions">
            <button
              className="merge-btn-never"
              onClick={() => onNever(c)}
              title="Never suggest merging this pair again"
              type="button"
            >
              Never suggest
            </button>
            <button
              className="merge-btn-keep"
              onClick={() => onKeepBoth(c)}
              type="button"
            >
              Keep both
            </button>
            <button
              className="merge-btn-merge"
              onClick={() => onMerge(c)}
              title="Keep the existing node, absorb the new one"
              type="button"
            >
              Merge → existing
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
