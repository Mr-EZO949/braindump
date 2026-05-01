"use client";

import { useEffect, useState } from "react";
import type { NodeType } from "@/types/graph";

const STORAGE_KEY = "braindump:type-explorer-collapsed";

type TypeExplorerProps = {
  counts: Array<{ type: NodeType; label: string; count: number }>;
  total: number;
  activeType: string;
  onSelect: (typeValue: string) => void;
};

export function TypeExplorer({ counts, total, activeType, onSelect }: TypeExplorerProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
  }, []);

  if (counts.length === 0) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    }
  };

  const activeChip = counts.find((c) => c.type === activeType);
  const summaryLabel = activeType === "all" ? "All" : (activeChip?.label ?? "All");
  const summaryCount = activeType === "all" ? total : (activeChip?.count ?? total);

  return (
    <div className="type-explorer" role="toolbar" aria-label="Filter by type" data-collapsed={collapsed}>
      <button
        className="type-explorer-toggle"
        onClick={toggle}
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Show type filters" : "Hide type filters"}
        title={collapsed ? "Show type filters" : "Hide type filters"}
      >
        <span className="type-explorer-toggle-caret" aria-hidden="true">▾</span>
        {collapsed ? (
          <>
            {activeChip ? (
              <span
                className="type-explorer-dot"
                aria-hidden="true"
                data-type={activeChip.type}
              />
            ) : null}
            <span className="type-explorer-label">{summaryLabel}</span>
            <span className="type-explorer-count">{summaryCount}</span>
          </>
        ) : (
          <span className="type-explorer-label">Types</span>
        )}
      </button>

      {!collapsed && (
        <>
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
        </>
      )}
    </div>
  );
}
