"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon, TargetIcon } from "@/components/ui/icons";
import type { NodeType } from "@/types/graph";
import type { Nudge } from "@/types/chat";

type TopNode = {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  planning_signals: string[];
};

type DailyBriefProps = {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onSelectNudge: (nudge: Nudge) => void;
};

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function DailyBriefOverlay({
  workspaceId,
  workspaceName,
  onClose,
  onFocusNode,
  onSelectNudge,
}: DailyBriefProps) {
  const [loading, setLoading] = useState(true);
  const [top, setTop] = useState<TopNode[]>([]);
  const [nudges, setNudges] = useState<Nudge[]>([]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);

    Promise.all([
      fetch("/api/assistant/top-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
        signal: ac.signal,
      })
        .then((r) => (r.ok ? r.json() : { top: [] }))
        .catch(() => ({ top: [] })),
      fetch(`/api/assistant/nudges?workspace_id=${encodeURIComponent(workspaceId)}`, {
        cache: "no-store",
        signal: ac.signal,
      })
        .then((r) => (r.ok ? r.json() : { nudges: [] }))
        .catch(() => ({ nudges: [] })),
    ])
      .then(([topRes, nudgeRes]) => {
        if (ac.signal.aborted) return;
        setTop(Array.isArray(topRes?.top) ? topRes.top : []);
        setNudges(Array.isArray(nudgeRes?.nudges) ? nudgeRes.nudges : []);
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
      className="daily-brief-backdrop"
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      onClick={onClose}
    >
      <motion.div
        className="daily-brief-card"
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        initial={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="daily-brief-header">
          <div>
            <p className="daily-brief-kicker">{formatToday()}</p>
            <h2 className="daily-brief-title">Good to see you back, {workspaceName}</h2>
          </div>
          <button
            className="daily-brief-close"
            aria-label="Close"
            onClick={onClose}
            type="button"
          >
            <CloseIcon className="h-[14px] w-[14px]" />
          </button>
        </div>

        <section className="daily-brief-section">
          <h3 className="daily-brief-section-title">
            <TargetIcon className="h-[13px] w-[13px]" />
            Top 3 to focus on
          </h3>
          {loading ? (
            <p className="daily-brief-state">Loading…</p>
          ) : top.length === 0 ? (
            <p className="daily-brief-state">
              Nothing active yet. Brain-dump your goals to get started.
            </p>
          ) : (
            <ol className="daily-brief-list">
              {top.map((n, i) => (
                <li key={n.id}>
                  <button
                    className="daily-brief-item"
                    onClick={() => onFocusNode(n.id)}
                    type="button"
                  >
                    <span className="daily-brief-rank">{i + 1}</span>
                    <span className="daily-brief-body">
                      <span className="daily-brief-item-title">{n.title}</span>
                      <span className="daily-brief-meta">
                        <span className="daily-brief-type">{n.node_type}</span>
                        {n.planning_signals.slice(0, 2).map((sig) => (
                          <span key={sig} className="daily-brief-signal">
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
        </section>

        {nudges.length > 0 ? (
          <section className="daily-brief-section">
            <h3 className="daily-brief-section-title">Worth a look</h3>
            <div className="daily-brief-nudge-list">
              {nudges.map((nudge) => (
                <button
                  className="daily-brief-nudge"
                  key={nudge.id}
                  onClick={() => onSelectNudge(nudge)}
                  type="button"
                >
                  {nudge.title}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="daily-brief-actions">
          <button className="daily-brief-primary" onClick={onClose} type="button">
            Start the day
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
