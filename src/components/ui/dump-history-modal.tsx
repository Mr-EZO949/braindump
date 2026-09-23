"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon, ListIcon } from "@/components/ui/icons";

type DumpStatus = "pending" | "processing" | "completed" | "failed";

type DumpItem = {
  id: string;
  raw_text: string;
  source_type: string;
  status: DumpStatus;
  created_at: string;
};

type DumpHistoryModalProps = {
  workspaceId: string;
  onClose: () => void;
};

const STATUS_LABEL: Record<DumpStatus, string> = {
  completed: "Processed",
  processing: "Processing",
  pending: "Queued",
  failed: "Failed",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

export function DumpHistoryModal({ workspaceId, onClose }: DumpHistoryModalProps) {
  const [entries, setEntries] = useState<DumpItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which dumps are expanded to their full text (collapsed = clamped to 3 lines).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    const ctrl = new AbortController();
    setEntries(null);
    setError(null);
    fetch(`/api/entries?workspace_id=${encodeURIComponent(workspaceId)}`, {
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? "Failed to load history");
        }
        return r.json();
      })
      .then((d) => setEntries(d.entries ?? []))
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
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
      className="dump-history-backdrop"
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      onClick={onClose}
    >
      <motion.div
        className="dump-history-modal"
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        initial={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Brain dump history"
      >
        <header className="dump-history-header">
          <p className="dump-history-kicker">
            <ListIcon className="h-[12px] w-[12px]" />
            Brain dump history
          </p>
          <button className="dump-history-close" type="button" onClick={onClose} aria-label="Close">
            <CloseIcon className="h-[14px] w-[14px]" />
          </button>
        </header>

        <div className="dump-history-body">
          {error ? (
            <p className="dump-history-empty">{error}</p>
          ) : entries === null ? (
            <p className="dump-history-empty">Loading history…</p>
          ) : entries.length === 0 ? (
            <p className="dump-history-empty">
              No brain dumps yet — your past dumps will show up here.
            </p>
          ) : (
            <ul className="dump-history-list">
              {entries.map((e) => {
                const isExpanded = expanded.has(e.id);
                // Only offer the toggle when the text is long enough to be
                // clamped (~3 lines at this width). Short dumps show in full.
                const isLong = e.raw_text.length > 160 || e.raw_text.includes("\n");
                return (
                  <li className="dump-history-item" key={e.id}>
                    <div className="dump-history-item-meta">
                      <span className="dump-history-when">{formatWhen(e.created_at)}</span>
                      <span className="dump-history-status" data-status={e.status}>
                        {STATUS_LABEL[e.status] ?? e.status}
                      </span>
                    </div>
                    <p
                      className={`dump-history-item-text${isExpanded ? " dump-history-item-text--expanded" : ""}`}
                      onClick={isLong ? () => toggleExpanded(e.id) : undefined}
                      style={isLong ? { cursor: "pointer" } : undefined}
                    >
                      {e.raw_text}
                    </p>
                    {isLong ? (
                      <button
                        type="button"
                        className="dump-history-more"
                        onClick={() => toggleExpanded(e.id)}
                      >
                        {isExpanded ? "Show less" : "Show more"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
