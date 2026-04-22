"use client";

import { useState } from "react";
import type { Node } from "@/types/graph";

type CompletedShelfProps = {
  nodes: Node[];
  onSelect: (nodeId: string) => void;
};

function formatCompletedAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CompletedShelf({ nodes, onSelect }: CompletedShelfProps) {
  const [open, setOpen] = useState(false);

  if (nodes.length === 0) return null;

  const sorted = [...nodes].sort((a, b) => {
    const aIso = a.completed_at ?? "";
    const bIso = b.completed_at ?? "";
    return bIso.localeCompare(aIso);
  });

  return (
    <div className="completed-shelf" data-open={open}>
      <button
        className="completed-shelf-toggle"
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
      >
        <span className="completed-shelf-check" aria-hidden="true">
          ✓
        </span>
        <span className="completed-shelf-count">
          {nodes.length} completed
        </span>
        <span className="completed-shelf-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <ul className="completed-shelf-list">
          {sorted.slice(0, 25).map((n) => (
            <li key={n.id}>
              <button
                className="completed-shelf-item"
                onClick={() => onSelect(n.id)}
                type="button"
              >
                <span className="completed-shelf-title">{n.title}</span>
                <span className="completed-shelf-date">
                  {formatCompletedAt(n.completed_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
