"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon, TargetIcon } from "@/components/ui/icons";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  minutesToHHMM,
  parseHHMM,
  planSchedule,
  todayIsoDate,
} from "@/lib/planner/auto-schedule";
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

      {loading ? (
        <div className="lockin-state">Finding your next move…</div>
      ) : error ? (
        <div className="lockin-state lockin-error">{error}</div>
      ) : top.length === 0 ? (
        <div className="lockin-state">
          Nothing active yet — brain dump a goal or task first.
        </div>
      ) : (
        <>
          {/* The one thing — pick #1, the obvious move. Whole card is the action. */}
          <button
            className="lockin-hero"
            onClick={() => onFocusNode(top[0].id)}
            type="button"
          >
            <span className="lockin-hero-eyebrow">Start here</span>
            <span className="lockin-hero-title">{top[0].title}</span>
            {top[0].planning_signals[0] ? (
              <span className="lockin-hero-signal">{top[0].planning_signals[0]}</span>
            ) : null}
            <span className="lockin-hero-go">Focus this →</span>
          </button>

          {/* Quiet backups — only if there are any */}
          {top.length > 1 ? (
            <div className="lockin-backups">
              <span className="lockin-or">or</span>
              {top.slice(1, 3).map((node) => (
                <button
                  className="lockin-backup"
                  key={node.id}
                  onClick={() => onFocusNode(node.id)}
                  type="button"
                >
                  {node.title}
                </button>
              ))}
            </div>
          ) : null}

          {/* Quiet footer — plan the day, and at most one nudge */}
          <div className="lockin-footer">
            <button
              className="lockin-plan-link"
              onClick={handleAddToPlanner}
              type="button"
              disabled={scheduling}
            >
              {scheduling ? "Planning…" : "Plan my day →"}
            </button>
            {scheduleError ? (
              <span className="lockin-foot-note lockin-error">{scheduleError}</span>
            ) : null}
            {nudges.length > 0 ? (
              <button
                className="lockin-nudge-line"
                onClick={() => onSelectNudge?.(nudges[0])}
                type="button"
              >
                {nudges.length === 1
                  ? nudges[0].title
                  : `${nudges[0].title} · +${nudges.length - 1} more`}
              </button>
            ) : null}
          </div>
        </>
      )}
    </motion.div>
  );
}
