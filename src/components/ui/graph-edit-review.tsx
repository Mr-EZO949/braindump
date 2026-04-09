"use client";

import { useState } from "react";
import type { GraphEditOperation } from "@/types/graph";

interface Props {
  operations: GraphEditOperation[];
  onConfirm: (ops: GraphEditOperation[]) => void | Promise<void>;
  onDismiss: () => void;
}

function describeOp(op: GraphEditOperation): string {
  switch (op.op) {
    case "move":
      return `Move "${op.node}" under "${op.new_parent}"`;
    case "remove_edge":
      return `Remove connection between "${op.source}" and "${op.target}"`;
    case "rename":
      return `Rename "${op.node}" to "${op.new_title}"`;
    case "archive":
      return `Archive "${op.node}"`;
  }
}

function opIcon(op: GraphEditOperation): string {
  switch (op.op) {
    case "move": return "↗";
    case "remove_edge": return "✕";
    case "rename": return "✎";
    case "archive": return "▣";
  }
}

export function GraphEditReview({ operations, onConfirm, onDismiss }: Props) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(operations.map((_, i) => i))
  );
  const [submitting, setSubmitting] = useState(false);

  function toggle(idx: number) {
    if (submitting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    const ops = operations.filter((_, i) => selected.has(i));
    try {
      await onConfirm(ops);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="per-backdrop">
      <div className="per-modal" onClick={(e) => e.stopPropagation()}>
        <div className="per-header">
          <span className="per-modal-label">Graph edits</span>
          <span className="per-modal-sub">{operations.length} operation{operations.length === 1 ? "" : "s"}</span>
        </div>

        <div className="per-list">
          {operations.map((op, i) => (
            <button
              key={i}
              className={`ger-row ${selected.has(i) ? "ger-row--selected" : ""}`}
              onClick={() => toggle(i)}
              type="button"
            >
              <span className="ger-check">{selected.has(i) ? "✓" : ""}</span>
              <span className="ger-icon">{opIcon(op)}</span>
              <span className="ger-desc">{describeOp(op)}</span>
            </button>
          ))}
        </div>

        <div className="per-footer">
          <button className="per-btn-ghost" onClick={onDismiss} disabled={submitting} type="button">
            Cancel
          </button>
          <button
            className="per-btn-primary"
            disabled={selected.size === 0 || submitting}
            onClick={handleConfirm}
            type="button"
          >
            {submitting ? "Applying..." : `Apply ${selected.size} edit${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
