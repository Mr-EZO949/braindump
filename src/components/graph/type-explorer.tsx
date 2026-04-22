"use client";

import type { NodeType } from "@/types/graph";

type TypeExplorerProps = {
  counts: Array<{ type: NodeType; label: string; count: number }>;
  total: number;
  activeType: string;
  onSelect: (typeValue: string) => void;
};

export function TypeExplorer({ counts, total, activeType, onSelect }: TypeExplorerProps) {
  if (counts.length === 0) return null;

  return (
    <div className="type-explorer" role="toolbar" aria-label="Filter by type">
      <button
        className="type-explorer-chip"
        data-active={activeType === "all"}
        onClick={() => onSelect("all")}
        type="button"
      >
        <span className="type-explorer-label">All</span>
        <span className="type-explorer-count">{total}</span>
      </button>

      {counts.map(({ type, label, count }) => (
        <button
          key={type}
          className="type-explorer-chip"
          data-active={activeType === type}
          data-type={type}
          onClick={() => onSelect(activeType === type ? "all" : type)}
          type="button"
        >
          <span className="type-explorer-dot" aria-hidden="true" />
          <span className="type-explorer-label">{label}</span>
          <span className="type-explorer-count">{count}</span>
        </button>
      ))}
    </div>
  );
}
