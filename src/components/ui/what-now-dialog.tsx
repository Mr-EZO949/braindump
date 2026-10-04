"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { CloseIcon, TargetIcon } from "@/components/ui/icons";
import { StaleCheckCard } from "@/components/ui/stale-check-card";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  DURATION_BY_TYPE,
  minutesToHHMM,
  nowMinutesFloor,
  parseHHMM,
  planSchedule,
  todayIsoDate,
} from "@/lib/planner/auto-schedule";
import { describeFreeTime, freeTimeInBusy, type BusyInterval } from "@/lib/planner/commitments";
import { clientDayHints } from "@/lib/habits/streak";
import type { StaleItem } from "@/lib/planner/skips";
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
  // Planned and skipped on 2+ days, no deadline: out of `top` until answered.
  stale_check?: StaleItem[];
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

// The brief is SQL only ($0). One fetch path for opening Focus and for the
// warm-up below.
async function fetchFocusBrief(workspaceId: string, signal?: AbortSignal): Promise<LockInData> {
  const res = await fetch("/api/assistant/daily-brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, ...clientDayHints() }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? "Could not load focus");
  return json as LockInData;
}

/**
 * Warm the Focus cache once the graph has loaded, so the FIRST press of Focus
 * paints at once too (R1 #9: "it opens instantly"). Skipped when any cached
 * brief exists: a stale one already paints instantly while Focus refreshes it.
 */
export function prefetchFocusBrief(workspaceId: string, graphSignature: string): void {
  if (readFocusEnvelope(workspaceId)) return;
  fetchFocusBrief(workspaceId)
    .then((data) => writeFocusCache(workspaceId, data, graphSignature))
    .catch(() => {
      // A warm-up only; opening Focus fetches (and reports errors) itself.
    });
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
  // "in Pass Statistics Midterm" under the title — where the step lives
  // (its parent, from the graph already on screen; null hides the line).
  contextFor?: (nodeId: string) => string | null;
  // A cheap fingerprint of the current graph (node/edge/completed counts). When
  // it changes, the Focus cache is treated as stale and re-fetched.
  graphSignature?: string;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onScheduledToPlanner?: () => void;
  onSelectNudge?: (nudge: Nudge) => void;
  // A waiting item whose check-back day came: one tap settles it ($0).
  onCheckBack?: (nodeId: string, decision: "done" | "still_waiting") => Promise<void>;
  // "Does this still matter?" changed a node (can wait / dropped / undone):
  // reload the graph so it shows.
  onGraphChanged?: () => void;
};

// "Check back: waiting for exam result" → "Waiting for exam result" (the
// eyebrow already says Check back).
function checkBackLine(node: TopNode): string {
  const signal = node.planning_signals[0] ?? "";
  const rest = signal.replace(/^Check back:\s*/i, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "On hold — any news?";
}

// About how long a sitting on it takes — the same per-type estimate Focus
// uses to fit work into a free window (lib/ai/planner.ts estimateMinutes).
function estimateMinutes(nodeType: string): number {
  return DURATION_BY_TYPE[nodeType] ?? 30;
}

export function WhatNowDialog({
  workspaceId,
  userId,
  contextFor,
  graphSignature = "",
  onClose,
  onFocusNode,
  onScheduledToPlanner,
  onSelectNudge,
  onCheckBack,
  onGraphChanged,
}: WhatNowDialogProps) {
  const [loading, setLoading] = useState(() => !readFocusCache(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LockInData | null>(() => readFocusCache(workspaceId));
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [checkBackBusy, setCheckBackBusy] = useState<"done" | "still_waiting" | null>(null);
  const [checkBackError, setCheckBackError] = useState<string | null>(null);
  // Which of the ranked picks is showing. ONE next action leads; "Show me
  // another" steps through the rest quietly, in rank order, and wraps.
  const [pickIndex, setPickIndex] = useState(0);

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

    fetchFocusBrief(workspaceId, ac.signal)
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
    // The day plan takes the top three, as before (the brief returns a few
    // more so "Show me another" has somewhere to go).
    const top = (data?.top ?? []).filter((node) => !node.check_back).slice(0, 3);
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
  const heroPosition = top.length > 0 ? pickIndex % top.length : 0;
  const hero = top[heroPosition];
  // "45 min free · Stats at 14:00" — from the clock at render, so a cached
  // brief never shows a stale countdown.
  const free = freeTimeInBusy(data?.busy_today ?? [], nowMinutesFloor());
  const timeLine = describeFreeTime(free);
  const heroMinutes = hero ? estimateMinutes(hero.node_type) : 0;
  const heroFits =
    !free.current && free.next && free.freeMinutes !== null && free.freeMinutes >= 15 && heroMinutes <= free.freeMinutes;
  const heroContext = hero ? contextFor?.(hero.id) ?? null : null;
  const heroReason = hero?.planning_signals[0] ?? null;

  const showAnother = () => {
    setCheckBackError(null);
    setPickIndex((index) => (top.length > 0 ? (index + 1) % top.length : 0));
  };

  // An answer on the "Does this still matter?" card changes the picks: fetch
  // them again (and cache them for this graph), then let the graph reload.
  const refreshAfterStaleAnswer = async (changedGraph: boolean) => {
    if (!workspaceId) return;
    try {
      const nextData = await fetchFocusBrief(workspaceId);
      setData(nextData);
      writeFocusCache(workspaceId, nextData, graphSignature);
    } catch {
      clearFocusCache(workspaceId);
    }
    if (changedGraph) onGraphChanged?.();
  };

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

      {!loading && !error && workspaceId ? (
        <StaleCheckCard
          items={data?.stale_check ?? []}
          key={workspaceId}
          onChanged={({ answer }) => void refreshAfterStaleAnswer(answer !== "still_matters")}
          workspaceId={workspaceId}
        />
      ) : null}

      {loading ? (
        /* First open with no cache: the hero's shape, not a sentence. */
        <div className="lockin-skeleton" aria-busy="true" aria-label="Finding your next step">
          <span className="lockin-skeleton-line lockin-skeleton-line--eyebrow" />
          <span className="lockin-skeleton-line lockin-skeleton-line--title" />
          <span className="lockin-skeleton-line lockin-skeleton-line--meta" />
          <span className="lockin-skeleton-line lockin-skeleton-line--button" />
        </div>
      ) : error ? (
        <div className="lockin-state lockin-error">{error}</div>
      ) : !hero ? (
        <div className="lockin-state">
          {(data?.stale_check ?? []).length > 0
            ? "Answer the question above — then Focus has your next step."
            : "Nothing active yet — brain dump a goal or task first."}
        </div>
      ) : (
        <>
          {timeLine ? (
            <motion.div className="lockin-time" variants={ITEM_VARIANTS}>
              <span className="lockin-time-dot" aria-hidden="true" />
              {timeLine}
            </motion.div>
          ) : null}

          <AnimatePresence mode="wait" initial={false}>
            {hero.check_back && onCheckBack ? (
              /* A waiting item whose day came — a decision, not a work block:
                 two taps settle it, no chat needed. */
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="lockin-hero lockin-hero--checkback"
                exit={{ opacity: 0, y: -6 }}
                initial={{ opacity: 0, y: 6 }}
                key={hero.id}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              >
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
              /* The ONE next action: what it is, where it lives, why now, how
                 big — and one button. The button opens it and sets up the
                 timer PAUSED (R1 #4); nothing here breaks it down or runs AI. */
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="lockin-hero lockin-hero--next"
                exit={{ opacity: 0, y: -6 }}
                initial={{ opacity: 0, y: 6 }}
                key={hero.id}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              >
                <span className="lockin-hero-eyebrow">
                  <span className="lockin-hero-pip" aria-hidden="true" />
                  {heroPosition === 0 ? "Your next step" : "Or this one"}
                </span>
                <span className="lockin-hero-title">{hero.title}</span>
                {heroContext ? <span className="lockin-hero-context">in {heroContext}</span> : null}
                <span className="lockin-hero-facts">
                  {heroReason ? <span className="lockin-fact lockin-fact--why">{heroReason}</span> : null}
                  <span className="lockin-fact">about {heroMinutes} min</span>
                  {heroFits && free.next ? (
                    <span className="lockin-fact lockin-fact--fit">fits before {free.next.title}</span>
                  ) : null}
                </span>
                <button
                  autoFocus
                  className="lockin-start"
                  onClick={() => onFocusNode(hero.id)}
                  type="button"
                >
                  Work on this
                  <span className="lockin-hero-go-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {top.length > 1 ? (
            <motion.button
              className="lockin-another"
              onClick={showAnother}
              type="button"
              variants={ITEM_VARIANTS}
            >
              Not this one — show me another
              <span className="lockin-another-count" aria-label={`${heroPosition + 1} of ${top.length}`}>
                {heroPosition + 1}/{top.length}
              </span>
            </motion.button>
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
