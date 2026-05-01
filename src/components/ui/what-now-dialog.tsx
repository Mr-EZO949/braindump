"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon, InfoIcon, TargetIcon } from "@/components/ui/icons";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  BREAK_MINUTES,
  minutesToHHMM,
  parseHHMM,
  planSchedule,
  todayIsoDate,
} from "@/lib/planner/auto-schedule";
import { getQuoteOfTheDay } from "@/lib/planner/quotes";
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

type WeeklyPulse = {
  completed: number;
  created: number;
  scheduled: number;
  scheduled_done: number;
  completion_rate: number | null;
};

type LockInData = {
  headline: string | null;
  top: TopNode[];
  weekly_pulse: WeeklyPulse;
  nudges: Nudge[];
};

type WhatNowDialogProps = {
  workspaceId: string | null;
  userId: string | null;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onScheduledToPlanner?: () => void;
  onSelectNudge?: (nudge: Nudge) => void;
};

export function WhatNowDialog({
  workspaceId,
  userId,
  onClose,
  onFocusNode,
  onScheduledToPlanner,
  onSelectNudge,
}: WhatNowDialogProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LockInData | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const quote = getQuoteOfTheDay();

  useEffect(() => {
    if (!workspaceId) return;

    const ac = new AbortController();
    setLoading(true);
    setError(null);

    fetch("/api/assistant/daily-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
      signal: ac.signal,
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error ?? "Could not load focus");
        return json as LockInData;
      })
      .then(setData)
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load focus");
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

  const handleAddToPlanner = async () => {
    if (scheduling) return;
    if (!workspaceId || !userId) {
      setScheduleError("Not signed in.");
      return;
    }
    const top = data?.top ?? [];
    if (top.length === 0) return;

    setScheduling(true);
    setScheduleError(null);

    try {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        setScheduleError("Database connection unavailable.");
        setScheduling(false);
        return;
      }

      const today = todayIsoDate();

      const { data: existingRaw, error: existingError } = await supabase
        .from("plan_tasks")
        .select("start_time, duration_minutes, scheduled_date")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("scheduled_date", today);

      if (existingError) {
        setScheduleError("Could not read today's plan.");
        setScheduling(false);
        return;
      }

      const busy = (existingRaw ?? [])
        .map((row) => {
          const start = parseHHMM(row.start_time as string | null);
          const dur = (row.duration_minutes as number | null) ?? 0;
          if (start === null || dur <= 0) return null;
          return { start, end: start + dur };
        })
        .filter((x): x is { start: number; end: number } => x !== null);

      // AI duration estimation — endpoint always returns a complete map.
      let durationByNodeId: Record<string, number> | undefined;
      try {
        const durRes = await fetch("/api/assistant/estimate-durations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodes: top.map((n) => ({
              id: n.id,
              title: n.title,
              summary: n.summary,
              node_type: n.node_type,
            })),
          }),
        });
        if (durRes.ok) {
          const j = (await durRes.json()) as { durations?: Record<string, number> };
          if (j.durations && typeof j.durations === "object") {
            durationByNodeId = j.durations;
          }
        }
      } catch {
        // fall back to type defaults
      }

      const plan = planSchedule(top, busy, { durationByNodeId });
      if (!plan) {
        setScheduleError("Not enough free time today. Try clearing a slot first.");
        setScheduling(false);
        return;
      }

      const inserts = plan.map(({ node, startMinute, durationMinutes }) => ({
        user_id: userId,
        workspace_id: workspaceId,
        title: node.title,
        node_id: node.id,
        scheduled_date: today,
        start_time: minutesToHHMM(startMinute),
        duration_minutes: durationMinutes,
        done: false,
        created_at: new Date().toISOString(),
      }));

      const { error: insertError } = await supabase.from("plan_tasks").insert(inserts);
      if (insertError) {
        setScheduleError("Could not add to planner.");
        setScheduling(false);
        return;
      }

      onScheduledToPlanner?.();
    } catch {
      setScheduleError("Could not add to planner.");
    } finally {
      setScheduling(false);
    }
  };

  const top = data?.top ?? [];
  const nudges = data?.nudges ?? [];

  return (
    <motion.div
      className="lockin-card"
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.14 }}
    >
      <div className="lockin-header">
        <div className="lockin-title">
          <TargetIcon className="h-[14px] w-[14px]" />
          Focus
        </div>
        <button
          className="lockin-close"
          aria-label="Close"
          onClick={onClose}
          type="button"
        >
          <CloseIcon className="h-[12px] w-[12px]" />
        </button>
      </div>

      {/* Productivity quote — stable per day */}
      <blockquote className="lockin-quote">
        <p className="lockin-quote-text">&ldquo;{quote.text}&rdquo;</p>
        <footer className="lockin-quote-author">— {quote.author}</footer>
      </blockquote>

      {loading ? (
        <div className="lockin-state">Loading your focus…</div>
      ) : error ? (
        <div className="lockin-state lockin-error">{error}</div>
      ) : (
        <>
          {/* AI summary headline */}
          {data?.headline ? (
            <p className="lockin-summary">{data.headline}</p>
          ) : null}

          {/* Plan-rate pulse — only render if there's any scheduled history */}
          {data && data.weekly_pulse.scheduled > 0 ? (
            <div className="lockin-pulse">
              <span className="lockin-pulse-label">Plan rate this week</span>
              <span className="lockin-pulse-value">
                {data.weekly_pulse.completion_rate !== null
                  ? `${Math.round(data.weekly_pulse.completion_rate * 100)}%`
                  : "—"}
                <span className="lockin-pulse-sub">
                  {" "}
                  ({data.weekly_pulse.scheduled_done}/{data.weekly_pulse.scheduled})
                </span>
              </span>
              <span
                className="lockin-pulse-info"
                tabIndex={0}
                aria-label="Resets every Monday. Today's tasks are excluded."
                title="Resets every Monday. Today's tasks are excluded."
              >
                <InfoIcon className="h-[11px] w-[11px]" />
              </span>
            </div>
          ) : null}

          {/* Top 3 — empty state if no candidates */}
          {top.length === 0 ? (
            <div className="lockin-state">
              Nothing active yet. Brain dump some goals or tasks first.
            </div>
          ) : (
            <section className="lockin-section">
              <h3 className="lockin-section-title">
                <TargetIcon className="h-[12px] w-[12px]" />
                Top 3 right now
              </h3>
              <ol className="lockin-list">
                {top.map((node, i) => (
                  <li key={node.id}>
                    <button
                      className="lockin-item"
                      onClick={() => onFocusNode(node.id)}
                      type="button"
                    >
                      <span className="lockin-rank">{i + 1}</span>
                      <span className="lockin-body">
                        <span className="lockin-item-title">{node.title}</span>
                        <span className="lockin-meta">
                          <span className="lockin-type">{node.node_type}</span>
                          {node.planning_signals.slice(0, 2).map((sig) => (
                            <span key={sig} className="lockin-signal">
                              {sig}
                            </span>
                          ))}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Worth a look — nudges */}
          {nudges.length > 0 ? (
            <section className="lockin-section">
              <h3 className="lockin-section-title">Worth a look</h3>
              <div className="lockin-nudge-list">
                {nudges.map((nudge) => (
                  <button
                    className="lockin-nudge"
                    key={nudge.id}
                    onClick={() => onSelectNudge?.(nudge)}
                    type="button"
                  >
                    {nudge.title}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {/* Schedule action */}
          {top.length > 0 ? (
            <div className="lockin-actions">
              <button
                className="lockin-schedule-btn"
                onClick={handleAddToPlanner}
                type="button"
                disabled={scheduling}
              >
                {scheduling ? "Scheduling…" : "Add to planner"}
              </button>
              {scheduleError ? (
                <p className="lockin-schedule-error">{scheduleError}</p>
              ) : (
                <p className="lockin-schedule-hint">
                  Auto-fills the next free slots, with {BREAK_MINUTES}-min breaks. Durations estimated by AI.
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </motion.div>
  );
}
