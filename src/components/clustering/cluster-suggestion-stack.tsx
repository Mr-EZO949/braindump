"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface ClusterSuggestion {
  id: string;
  suggested_title: string;
  suggested_node_type: string;
  child_count: number;
  children: Array<{ id: string; title: string }>;
}

interface Props {
  workspaceId: string | null;
  /** bumped after a dump-review acceptance to re-poll for new suggestions */
  refreshKey?: number;
  /** called after a successful accept so the parent can reload the graph */
  onAccepted: () => void;
}

export function ClusterSuggestionStack({ workspaceId, refreshKey, onAccepted }: Props) {
  const [items, setItems] = useState<ClusterSuggestion[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/clustering?workspace_id=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d: { suggestions?: ClusterSuggestion[] }) => {
        if (!cancelled) setItems(d.suggestions ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  const decide = useCallback(
    async (id: string, action: "accept" | "dismiss") => {
      setBusyId(id);
      try {
        const r = await fetch(`/api/clustering/${id}/${action}`, { method: "POST" });
        // 404 = already decided elsewhere; drop the card either way.
        if (!r.ok && r.status !== 404) return;
        setItems((prev) => prev.filter((s) => s.id !== id));
        if (action === "accept" && r.ok) onAccepted();
      } finally {
        setBusyId(null);
      }
    },
    [onAccepted],
  );

  if (!workspaceId || items.length === 0) return null;

  return (
    <div className="cluster-suggest-stack">
      <AnimatePresence>
        {items.map((s) => (
          <motion.div
            key={s.id}
            className="ai-notice ai-notice--cluster"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <span>
              Group <strong>{s.suggested_title}</strong> — {s.child_count} related:{" "}
              {s.children
                .slice(0, 3)
                .map((c) => c.title)
                .join(", ")}
              {s.children.length > 3 ? "…" : ""}
            </span>
            <div className="ai-notice-actions">
              <button
                className="ai-notice-action"
                type="button"
                disabled={busyId === s.id}
                onClick={() => void decide(s.id, "accept")}
              >
                Group them
              </button>
              <button
                className="ai-notice-dismiss"
                type="button"
                disabled={busyId === s.id}
                onClick={() => void decide(s.id, "dismiss")}
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
