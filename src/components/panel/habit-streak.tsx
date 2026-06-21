"use client";

import { useEffect, useRef, useState } from "react";

type StreakState = {
  streak: number;
  doneToday: boolean;
  atRisk: boolean;
};

type HistoryDay = {
  date: string;
  done: boolean;
};

type HabitData = {
  streak: StreakState;
  history: HistoryDay[];
  target_per_week: number | null;
};

type HabitStreakProps = {
  nodeId: string;
};

// How often the user wants to do this habit. Maps to nodes.habit_target_per_week
// (completions per ISO week; 7 = daily). Drives the Focus cadence boost.
const CADENCE_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Off", value: null },
  { label: "Daily", value: 7 },
  { label: "3×/wk", value: 3 },
  { label: "Weekly", value: 1 },
];

// How many days of history we pull from the API. Scroll exposes the older
// half — default view still anchors to the most recent ~14 days.
const HISTORY_DAYS_FETCH = 90;

export function HabitStreak({ nodeId }: HabitStreakProps) {
  const [data, setData] = useState<HabitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [savingCadence, setSavingCadence] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/habits/${nodeId}?days=${HISTORY_DAYS_FETCH}`, {
      signal: ac.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json?.error ?? "Could not load streak");
        return json as HabitData;
      })
      .then((d) => {
        if (!ac.signal.aborted) setData(d);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load streak");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [nodeId]);

  const handleToggleToday = async () => {
    if (acting || !data) return;
    setActing(true);
    setError(null);
    try {
      // If today is already done, DELETE it. Otherwise POST.
      const method = data.streak.doneToday ? "DELETE" : "POST";
      const url =
        method === "DELETE"
          ? `/api/habits/${nodeId}?date=${encodeURIComponent(today())}`
          : `/api/habits/${nodeId}`;
      const res = await fetch(url, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify({ date: today() }) : undefined,
      });
      if (res.ok) {
        const json = (await res.json()) as HabitData;
        setData(json);
      } else {
        const json = await res.json().catch(() => ({}));
        setError(json?.error ?? "Action failed");
      }
    } catch {
      setError("Action failed");
    } finally {
      setActing(false);
    }
  };

  const handleSetCadence = async (value: number | null) => {
    if (savingCadence || !data || data.target_per_week === value) return;
    setSavingCadence(true);
    setError(null);
    try {
      const res = await fetch(`/api/habits/${nodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_per_week: value }),
      });
      if (res.ok) {
        setData((await res.json()) as HabitData);
      } else {
        const json = await res.json().catch(() => ({}));
        setError(json?.error ?? "Could not update cadence");
      }
    } catch {
      setError("Could not update cadence");
    } finally {
      setSavingCadence(false);
    }
  };

  if (loading) {
    return <div className="habit-streak-loading">Loading streak…</div>;
  }

  if (error) {
    return <div className="habit-streak-error">{error}</div>;
  }

  if (!data) return null;

  return (
    <div className="habit-streak">
      <div className="habit-streak-header">
        <div className="habit-streak-headline">
          <span className="habit-streak-flame" aria-hidden="true">
            {data.streak.streak > 0 ? "🔥" : "·"}
          </span>
          <span className="habit-streak-count">{data.streak.streak}</span>
          <span className="habit-streak-suffix">
            {data.streak.streak === 1 ? "day" : "days"}
          </span>
          {data.streak.atRisk ? (
            <span className="habit-streak-risk">at risk — finish today</span>
          ) : null}
        </div>
        <button
          type="button"
          className="habit-streak-toggle"
          data-done={data.streak.doneToday}
          onClick={handleToggleToday}
          disabled={acting}
        >
          {data.streak.doneToday ? "Done today ✓" : "Mark today"}
        </button>
      </div>

      <div className="habit-cadence">
        <span className="habit-cadence-label">How often?</span>
        <div className="habit-cadence-options" role="group" aria-label="Habit cadence">
          {CADENCE_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              className="habit-cadence-btn"
              data-active={data.target_per_week === opt.value}
              onClick={() => handleSetCadence(opt.value)}
              disabled={savingCadence}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <HabitStreakHistory history={data.history} />
    </div>
  );
}

// Horizontally scrollable history strip. Anchors to "today" on the right
// edge by default so the most-recent days are visible without scrolling.
// User scrolls left to see older history (up to HISTORY_DAYS_FETCH days).
function HabitStreakHistory({ history }: { history: HistoryDay[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Anchor to the right (most-recent) on mount and whenever the history
    // grows. scrollLeft = scrollWidth places the rightmost item flush right.
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [history.length]);

  return (
    <div
      ref={scrollRef}
      className="habit-streak-grid"
      role="img"
      aria-label={`Last ${history.length} days of activity`}
    >
      {history.map((day) => (
        <span
          key={day.date}
          className="habit-streak-dot"
          data-done={day.done}
          title={`${day.date}: ${day.done ? "done" : "skipped"}`}
        />
      ))}
    </div>
  );
}

function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
