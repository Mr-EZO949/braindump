"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon, TargetIcon } from "@/components/ui/icons";
import type { NodeType } from "@/types/graph";

type TopNode = {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  planning_signals: string[];
};

type WhatNowDialogProps = {
  workspaceId: string | null;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
};

export function WhatNowDialog({ workspaceId, onClose, onFocusNode }: WhatNowDialogProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [top, setTop] = useState<TopNode[]>([]);

  useEffect(() => {
    if (!workspaceId) return;

    const ac = new AbortController();
    setLoading(true);
    setError(null);

    fetch("/api/assistant/top-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
      signal: ac.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Could not compute focus");
        setTop(Array.isArray(data.top) ? data.top : []);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not compute focus");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="what-now-card"
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.14 }}
    >
      <div className="what-now-header">
        <div className="what-now-title">
          <TargetIcon className="h-[14px] w-[14px]" />
          What now
        </div>
        <button
          className="what-now-close"
          aria-label="Close"
          onClick={onClose}
          type="button"
        >
          <CloseIcon className="h-[12px] w-[12px]" />
        </button>
      </div>

      {loading ? (
        <div className="what-now-state">Finding your top 3…</div>
      ) : error ? (
        <div className="what-now-state what-now-error">{error}</div>
      ) : top.length === 0 ? (
        <div className="what-now-state">
          Nothing active yet. Brain dump some goals or tasks first.
        </div>
      ) : (
        <ol className="what-now-list">
          {top.map((node, i) => (
            <li key={node.id}>
              <button
                className="what-now-item"
                onClick={() => onFocusNode(node.id)}
                type="button"
              >
                <span className="what-now-rank">{i + 1}</span>
                <span className="what-now-body">
                  <span className="what-now-item-title">{node.title}</span>
                  <span className="what-now-meta">
                    <span className="what-now-type">{node.node_type}</span>
                    {node.planning_signals.slice(0, 2).map((sig) => (
                      <span key={sig} className="what-now-signal">
                        {sig}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </motion.div>
  );
}
