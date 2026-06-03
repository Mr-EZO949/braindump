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
};

type HabitStreakProps = {
  nodeId: string;
};

// How many days of history we pull from the API. Scroll exposes the older
// half — default view still anchors to the most recent ~14 days.
const HISTORY_DAYS_FETCH = 90;

export function HabitStreak({ nodeId }: HabitStreakProps) {
  const [data, setData] = useState<HabitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
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
