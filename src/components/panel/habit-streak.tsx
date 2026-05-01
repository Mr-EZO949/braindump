"use client";

import { useEffect, useState } from "react";

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

const HISTORY_DISPLAY = 14; // last two weeks of dots in the mini calendar

export function HabitStreak({ nodeId }: HabitStreakProps) {
  const [data, setData] = useState<HabitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/habits/${nodeId}`, { signal: ac.signal, cache: "no-store" })
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

  const recent = data.history.slice(-HISTORY_DISPLAY);

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

      <div className="habit-streak-grid" role="img" aria-label="Last 14 days">
        {recent.map((day) => (
          <span
            key={day.date}
            className="habit-streak-dot"
            data-done={day.done}
            title={`${day.date}: ${day.done ? "done" : "skipped"}`}
          />
        ))}
      </div>
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
