"use client";

import { useEffect, useState } from "react";
import { motion, type Variants } from "framer-motion";
import { CloseIcon, TargetIcon } from "@/components/ui/icons";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  minutesToHHMM,
  nowMinutesFloor,
  parseHHMM,
  planSchedule,
  todayIsoDate,
} from "@/lib/planner/auto-schedule";
import { describeFreeTime, freeTimeInBusy, type BusyInterval } from "@/lib/planner/commitments";
import { clientDayHints } from "@/lib/habits/streak";
import type { NodeType } from "@/types/graph";
import type { Nudge } from "@/types/chat";

type TopNode = {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
  current_importance_score: number | null;
  planning_signals: string[];
  // A waiting item whose check-back day arrived — a decision, not a work block.
  check_back?: boolean;
};

type LockInData = {
  headline: string | null;
  top: TopNode[];
  nudges: Nudge[];
  // Today's fixed commitments (class, shift) as minutes from local midnight.
  busy_today?: BusyInterval[];
};

// Focus is a $0 SQL brief, but pressing Focus still fired the endpoint on every
// open. We now cache the result and only re-fetch when the cache is STALE:
// older than FOCUS_CACHE_TTL_MS, or the graph changed since (signature mismatch
// — a node/edge added/removed or a task completed). This honors the ask in the
// testing journal (#9): cache "for some time or until a task is done / the
// graph changes." Stale cache is still shown instantly (no flash) while a fresh
// fetch runs behind it.
const FOCUS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

type FocusCacheEnvelope = {
  data: LockInData;
  cachedAt: number;
  sig: string;
};

function focusCacheKey(workspaceId: string) {
  return `braindump:focus-cache:${workspaceId}`;
}

function readFocusEnvelope(workspaceId: string | null): FocusCacheEnvelope | null {
  if (!workspaceId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(focusCacheKey(workspaceId));
    if (!raw) return null;
    const cached = JSON.parse(raw) as FocusCacheEnvelope;
    if (!cached || typeof cached !== "object" || !cached.data) return null;
    return Array.isArray(cached.data.top) && Array.isArray(cached.data.nudges)
      ? cached
      : null;
  } catch {
    return null;
  }
}

// Any cached brief, fresh or stale — used to paint instantly without a flash.
function readFocusCache(workspaceId: string | null): LockInData | null {
  return readFocusEnvelope(workspaceId)?.data ?? null;
}

// True only when the cache is still trustworthy: within the TTL AND the graph
// hasn't changed since (same signature). A fresh cache lets us skip the fetch.
function isFocusCacheFresh(workspaceId: string | null, sig: string): boolean {
  const env = readFocusEnvelope(workspaceId);
  if (!env) return false;
  return env.sig === sig && Date.now() - env.cachedAt < FOCUS_CACHE_TTL_MS;
}

/** Drop the cached brief — e.g. busy time changed, which the graph signature can't see. */
export function clearFocusCache(workspaceId: string) {
  try {
    window.sessionStorage.removeItem(focusCacheKey(workspaceId));
  } catch {
    // Storage unavailable — there was no cache either.
  }
}

function writeFocusCache(workspaceId: string, data: LockInData, sig: string) {
  try {
    const envelope: FocusCacheEnvelope = { data, cachedAt: Date.now(), sig };
    window.sessionStorage.setItem(focusCacheKey(workspaceId), JSON.stringify(envelope));
  } catch {
    // Cached Focus data is an optimization; storage may be unavailable.
  }
}

// Mount choreography: the card settles in, then its contents stagger up just
// behind it. Framer-variants keep the timing declarative; the parent wrapper in
// app-shell still owns the outer fade/slide + exit, so this is purely the
// "premium settle" on top. Respects prefers-reduced-motion via the transition
// being trivially small — the values themselves are subtle by design.
const CARD_VARIANTS: Variants = {
  hidden: { opacity: 0, scale: 0.985 },
  show: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.22,
      ease: [0.16, 1, 0.3, 1],
      when: "beforeChildren",
      staggerChildren: 0.05,
      delayChildren: 0.04,
    },
  },
};

const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] },
  },
};

type WhatNowDialogProps = {
  workspaceId: string | null;
  userId: string | null;
  // A cheap fingerprint of the current graph (node/edge/completed counts). When
  // it changes, the Focus cache is treated as stale and re-fetched.
  graphSignature?: string;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onScheduledToPlanner?: () => void;
  onSelectNudge?: (nudge: Nudge) => void;
  // A waiting item whose check-back day came: one tap settles it ($0).
  onCheckBack?: (nodeId: string, decision: "done" | "still_waiting") => Promise<void>;
};

// "Check back: waiting for exam result" → "Waiting for exam result" (the
// eyebrow already says Check back).
function checkBackLine(node: TopNode): string {
  const signal = node.planning_signals[0] ?? "";
  const rest = signal.replace(/^Check back:\s*/i, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "On hold — any news?";
}

export function WhatNowDialog({
  workspaceId,
  userId,
  graphSignature = "",
  onClose,
  onFocusNode,
  onScheduledToPlanner,
  onSelectNudge,
  onCheckBack,
}: WhatNowDialogProps) {
  const [loading, setLoading] = useState(() => !readFocusCache(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LockInData | null>(() => readFocusCache(workspaceId));
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [checkBackBusy, setCheckBackBusy] = useState<"done" | "still_waiting" | null>(null);
  const [checkBackError, setCheckBackError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    const cached = readFocusCache(workspaceId);
    setData(cached);
    setError(null);

    // Fresh cache (within TTL + graph unchanged) → skip the round-trip entirely.
    if (isFocusCacheFresh(workspaceId, graphSignature)) {
      setLoading(false);
      return;
    }

    const ac = new AbortController();
    setLoading(!cached);

    fetch("/api/assistant/daily-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, ...clientDayHints() }),
      signal: ac.signal,
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error ?? "Could not load focus");
        return json as LockInData;
      })
      .then((nextData) => {
        setData(nextData);
        writeFocusCache(workspaceId, nextData, graphSignature);
      })
      .catch((err) => {
        if (ac.signal.aborted || cached) return;
        setError(err instanceof Error ? err.message : "Could not load focus");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [workspaceId, graphSignature]);

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
    const top = (data?.top ?? []).filter((node) => !node.check_back);
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
        .filter((x): x is { start: number; end: number } => x !== null)
        // Fixed commitments (class, shift) are busy too.
        .concat((data?.busy_today ?? []).map(({ start, end }) => ({ start, end })));

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
  const backups = top.slice(1, 3);
  const hero = top[0];
  // "45 min free · Stats at 14:00" — from the clock at render, so a cached
  // brief never shows a stale countdown.
  const timeLine = describeFreeTime(freeTimeInBusy(data?.busy_today ?? [], nowMinutesFloor()));

  const settleCheckBack = async (decision: "done" | "still_waiting") => {
    if (!hero || !onCheckBack || checkBackBusy) return;
    setCheckBackBusy(decision);
    setCheckBackError(null);
    try {
      // The graph refresh that follows changes graphSignature → Focus refetches.
      await onCheckBack(hero.id, decision);
    } catch {
      setCheckBackError("Couldn't update that — try again.");
    } finally {
      setCheckBackBusy(null);
    }
  };

  return (
    <motion.div
      className="lockin-card"
      animate="show"
      initial="hidden"
      variants={CARD_VARIANTS}
    >
      <div className="lockin-glow" aria-hidden="true" />

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
          {timeLine ? (
            <motion.div className="lockin-time" variants={ITEM_VARIANTS}>
              <span className="lockin-time-dot" aria-hidden="true" />
              {timeLine}
            </motion.div>
          ) : null}
          {hero.check_back && onCheckBack ? (
            /* A waiting item whose day came — a decision, not a work block:
               two taps settle it, no chat needed. */
            <motion.div className="lockin-hero lockin-hero--checkback" variants={ITEM_VARIANTS}>
              <span className="lockin-hero-eyebrow">
                <span className="lockin-hero-pip lockin-hero-pip--calm" aria-hidden="true" />
                Check back
              </span>
              <button
                className="lockin-hero-title lockin-hero-title-link"
                onClick={() => onFocusNode(hero.id)}
                type="button"
              >
                {hero.title}
              </button>
              <span className="lockin-hero-signal">{checkBackLine(hero)}</span>
              <div className="lockin-checkback-actions">
                <button
                  className="lockin-checkback-btn lockin-checkback-btn--primary"
                  disabled={checkBackBusy !== null}
                  onClick={() => void settleCheckBack("done")}
                  type="button"
                >
                  {checkBackBusy === "done" ? "Saving…" : "It's done ✓"}
                </button>
                <button
                  className="lockin-checkback-btn"
                  disabled={checkBackBusy !== null}
                  onClick={() => void settleCheckBack("still_waiting")}
                  type="button"
                >
                  {checkBackBusy === "still_waiting" ? "Saving…" : "Still waiting"}
                </button>
              </div>
              {checkBackError ? <span className="lockin-foot-note lockin-error">{checkBackError}</span> : null}
            </motion.div>
          ) : (
            /* The one thing — pick #1, the obvious move. Whole card is the action. */
            <motion.button
              className="lockin-hero"
              onClick={() => onFocusNode(hero.id)}
              type="button"
              variants={ITEM_VARIANTS}
            >
              <span className="lockin-hero-eyebrow">
                <span className="lockin-hero-pip" aria-hidden="true" />
                Start here
              </span>
              <span className="lockin-hero-title">{hero.title}</span>
              {hero.planning_signals[0] ? (
                <span className="lockin-hero-signal">{hero.planning_signals[0]}</span>
              ) : null}
              <span className="lockin-hero-go">
                Focus this
                <span className="lockin-hero-go-arrow" aria-hidden="true">
                  →
                </span>
              </span>
            </motion.button>
          )}

          {/* Quiet backups — only if there are any */}
          {backups.length > 0 ? (
            <motion.div className="lockin-backups" variants={ITEM_VARIANTS}>
              <span className="lockin-or">or</span>
              {backups.map((node, i) => (
                <button
                  className="lockin-backup"
                  key={node.id}
                  onClick={() => onFocusNode(node.id)}
                  type="button"
                >
                  <span className="lockin-backup-index" aria-hidden="true">
                    {i + 2}
                  </span>
                  <span className="lockin-backup-title">{node.title}</span>
                  {node.check_back ? <span className="lockin-backup-tag">check back</span> : null}
                </button>
              ))}
            </motion.div>
          ) : null}

          {/* Quiet footer — plan the day, and at most one nudge */}
          <motion.div className="lockin-footer" variants={ITEM_VARIANTS}>
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
          </motion.div>
        </>
      )}
    </motion.div>
  );
}
