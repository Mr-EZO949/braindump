"use client";

import { useEffect, useMemo, useState } from "react";
import type { GraphData, Node } from "@/types/graph";
import { todayLocalISO } from "@/lib/habits/streak";

type HabitsViewProps = {
  graphData: GraphData;
  onSelectNode: (nodeId: string) => void;
  onPlannerInvalidate?: () => void;
};

type HistoryEntry = { date: string; done: boolean };
type StreakSnapshot = { streak: number; doneToday: boolean; atRisk: boolean };
type HabitData = {
  history: HistoryEntry[];
  streak: StreakSnapshot;
  started_on: string | null;
};
type HabitState = { loading: boolean; data: HabitData | null; error: string | null };

const ALLOWED_BACKFILL_DAYS = 1;
// Fetched window — covers ~3 months for back-nav without re-fetching.
const HISTORY_DAYS = 90;
// Stats window — what % done / total reflect. Always 30 days, regardless
// of how much history we fetched for navigation.
const STATS_WINDOW = 30;
const WEEK_START_KEY = "habits.weekStartDay"; // 'mon' | 'sun'

type WeekStart = "mon" | "sun";
type ViewMode = "week" | "month";

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function dayNumOf(iso: string): number {
  return parseInt(iso.slice(8, 10), 10);
}

// Returns the ISO date for the start of the week containing `iso`,
// where the week starts on weekStart ('mon' or 'sun').
function startOfWeek(iso: string, weekStart: WeekStart): string {
  const dow = dayOfWeek(iso); // 0=Sun..6=Sat
  const offset = weekStart === "mon" ? (dow + 6) % 7 : dow;
  return addDaysISO(iso, -offset);
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function daysInMonth(iso: string): number {
  const [y, m] = iso.split("-").map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function formatDateRange(startISO: string, endISO: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const a = new Date(Date.UTC(
    parseInt(startISO.slice(0, 4), 10),
    parseInt(startISO.slice(5, 7), 10) - 1,
    parseInt(startISO.slice(8, 10), 10),
  ));
  const b = new Date(Date.UTC(
    parseInt(endISO.slice(0, 4), 10),
    parseInt(endISO.slice(5, 7), 10) - 1,
    parseInt(endISO.slice(8, 10), 10),
  ));
  return `${a.toLocaleDateString(undefined, opts)} – ${b.toLocaleDateString(undefined, opts)}`;
}

function formatMonth(iso: string): string {
  const [y, m] = iso.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return dt.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

type DayCell = {
  date: string;
  dayNum: number;
  weekday: string;
  isToday: boolean;
  isFuture: boolean;
  isOtherMonth: boolean;
  isBeforeStart: boolean;
  done: boolean;
  toggleable: boolean;
};

function buildWeek(
  history: HistoryEntry[],
  anchor: string,
  today: string,
  weekStart: WeekStart,
  startedOn: string | null,
): DayCell[] {
  const map = new Map(history.map((h) => [h.date, h.done]));
  const start = startOfWeek(anchor, weekStart);
  const out: DayCell[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(start, i);
    out.push({
      date,
      dayNum: dayNumOf(date),
      weekday: WEEKDAY_SHORT[dayOfWeek(date)],
      isToday: date === today,
      isFuture: date > today,
      isOtherMonth: false,
      isBeforeStart: !!startedOn && date < startedOn,
      done: map.get(date) ?? false,
      toggleable: date === today || date === addDaysISO(today, -ALLOWED_BACKFILL_DAYS),
    });
  }
  return out;
}

function buildMonth(
  history: HistoryEntry[],
  anchor: string,
  today: string,
  weekStart: WeekStart,
  startedOn: string | null,
): DayCell[] {
  const map = new Map(history.map((h) => [h.date, h.done]));
  const monthStart = startOfMonth(anchor);
  const monthLen = daysInMonth(monthStart);
  // Pad the leading week with the trailing days of the previous month so the
  // grid aligns by weekday.
  const gridStart = startOfWeek(monthStart, weekStart);
  // 6 weeks × 7 cols = 42 cells covers any month.
  const out: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const date = addDaysISO(gridStart, i);
    const inMonth = date >= monthStart && date < addDaysISO(monthStart, monthLen);
    out.push({
      date,
      dayNum: dayNumOf(date),
      weekday: WEEKDAY_SHORT[dayOfWeek(date)],
      isToday: date === today,
      isFuture: date > today,
      isOtherMonth: !inMonth,
      isBeforeStart: !!startedOn && date < startedOn,
      done: map.get(date) ?? false,
      toggleable: date === today || date === addDaysISO(today, -ALLOWED_BACKFILL_DAYS),
    });
  }
  // Trim trailing all-other-month rows (so a 28-day Feb doesn't render an
  // extra blank week below).
  let lastInMonth = 41;
  for (let i = 41; i >= 0; i--) {
    if (!out[i].isOtherMonth) {
      lastInMonth = i;
      break;
    }
  }
  const trimRow = Math.floor(lastInMonth / 7) + 1;
  return out.slice(0, trimRow * 7);
}

function weekdayHeader(weekStart: WeekStart): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const idx = weekStart === "mon" ? (i + 1) % 7 : i;
    out.push(WEEKDAY_SHORT[idx]);
  }
  return out;
}

function statsFor(
  history: HistoryEntry[],
  startedOn: string | null,
  today: string,
): { done: number; total: number; pct: number } {
  // Locked window: last STATS_WINDOW days through today, gated by started_on.
  // Fixed at 30 so the label always reads "30" regardless of fetch size.
  const earliest = addDaysISO(today, -(STATS_WINDOW - 1));
  const active = history.filter((h) => {
    if (h.date > today) return false;
    if (h.date < earliest) return false;
    if (startedOn && h.date < startedOn) return false;
    return true;
  });
  const total = active.length;
  const done = active.reduce((s, h) => s + (h.done ? 1 : 0), 0);
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export function HabitsView({ graphData, onSelectNode, onPlannerInvalidate }: HabitsViewProps) {
  const habitNodes = useMemo(
    () =>
      graphData.nodes.filter(
        (n) => n.node_type === "habit" && n.status !== "archived",
      ),
    [graphData],
  );

  const [habits, setHabits] = useState<Map<string, HabitState>>(new Map());
  const [today] = useState(() => todayLocalISO());
  const [anchor, setAnchor] = useState(() => todayLocalISO());
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [weekStart, setWeekStart] = useState<WeekStart>(() => {
    if (typeof window === "undefined") return "mon";
    return (window.localStorage.getItem(WEEK_START_KEY) as WeekStart) || "mon";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WEEK_START_KEY, weekStart);
    }
  }, [weekStart]);

  const habitKeys = useMemo(
    () =>
      habitNodes
        .map((n) => n.id)
        .sort()
        .join(","),
    [habitNodes],
  );

  useEffect(() => {
    if (habitNodes.length === 0) {
      setHabits(new Map());
      return;
    }

    setHabits((prev) => {
      const next = new Map(prev);
      for (const n of habitNodes) {
        if (!next.has(n.id)) {
          next.set(n.id, { loading: true, data: null, error: null });
        }
      }
      return next;
    });

    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      await Promise.all(
        habitNodes.map(async (n) => {
          try {
            const res = await fetch(`/api/habits/${n.id}?days=${HISTORY_DAYS}`, {
              signal: ac.signal,
              cache: "no-store",
            });
            if (!res.ok) {
              if (!cancelled) {
                setHabits((prev) => {
                  const next = new Map(prev);
                  next.set(n.id, { loading: false, data: null, error: `HTTP ${res.status}` });
                  return next;
                });
              }
              return;
            }
            const json = (await res.json()) as HabitData;
            if (cancelled) return;
            setHabits((prev) => {
              const next = new Map(prev);
              next.set(n.id, { loading: false, data: json, error: null });
              return next;
            });
          } catch (err) {
            if (cancelled || (err as Error).name === "AbortError") return;
            setHabits((prev) => {
              const next = new Map(prev);
              next.set(n.id, {
                loading: false,
                data: null,
                error: (err as Error).message ?? "Failed to load",
              });
              return next;
            });
          }
        }),
      );
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [habitKeys]);

  const handleSetStartedOn = async (nodeId: string, value: string | null) => {
    try {
      const res = await fetch(`/api/habits/${nodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ started_on: value }),
      });
      if (!res.ok) return;
      const json = (await res.json()) as HabitData;
      setHabits((prev) => {
        const next = new Map(prev);
        next.set(nodeId, { loading: false, data: json, error: null });
        return next;
      });
    } catch {
      // user can re-edit
    }
  };

  const handleToggleDay = async (
    nodeId: string,
    date: string,
    currentlyDone: boolean,
  ) => {
    try {
      const res = currentlyDone
        ? await fetch(`/api/habits/${nodeId}?date=${date}`, { method: "DELETE" })
        : await fetch(`/api/habits/${nodeId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date }),
          });
      if (!res.ok) return;
      const json = (await res.json()) as HabitData & { updated_task_ids?: string[] };
      setHabits((prev) => {
        const next = new Map(prev);
        next.set(nodeId, {
          loading: false,
          data: { history: json.history, streak: json.streak, started_on: json.started_on ?? null },
          error: null,
        });
        return next;
      });
      // If the cascade flipped any planner rows, tell the parent so the
      // planner mode re-fetches its task list.
      if (json.updated_task_ids && json.updated_task_ids.length > 0) {
        onPlannerInvalidate?.();
      }
    } catch {
      // user can re-tap
    }
  };

  const sortedHabits = useMemo(() => {
    const list = [...habitNodes];
    list.sort((a, b) => {
      const aStreak = habits.get(a.id)?.data?.streak.streak ?? 0;
      const bStreak = habits.get(b.id)?.data?.streak.streak ?? 0;
      if (aStreak !== bStreak) return bStreak - aStreak;
      const aScore = a.current_importance_score ?? a.importance_index ?? 0;
      const bScore = b.current_importance_score ?? b.importance_index ?? 0;
      return bScore - aScore;
    });
    return list;
  }, [habitNodes, habits]);

  const navLabel = useMemo(() => {
    if (viewMode === "week") {
      const start = startOfWeek(anchor, weekStart);
      const end = addDaysISO(start, 6);
      return formatDateRange(start, end);
    }
    return formatMonth(anchor);
  }, [viewMode, anchor, weekStart]);

  const shiftAnchor = (delta: number) => {
    if (viewMode === "week") {
      setAnchor((a) => addDaysISO(a, delta * 7));
    } else {
      const [y, m] = anchor.split("-").map((s) => parseInt(s, 10));
      const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      setAnchor(`${yy}-${mm}-01`);
    }
  };

  if (habitNodes.length === 0) {
    return (
      <div className="habits-view">
        <div className="habits-empty">
          <h2 className="habits-empty-title">No habits yet</h2>
          <p className="habits-empty-body">
            Add a habit by creating a node with type <em>habit</em>, or ask the
            assistant — &ldquo;add a daily habit to read for 30 minutes.&rdquo;
            Each habit you tap as done builds a streak you&rsquo;ll see here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="habits-view">
      <div className="habits-header">
        <h2 className="habits-title">Habits</h2>
      </div>

      <div className="habits-toolbar">
        <div className="habits-nav">
          <button
            type="button"
            className="habits-nav-btn"
            onClick={() => shiftAnchor(-1)}
            aria-label={`Previous ${viewMode}`}
          >
            ‹
          </button>
          <span className="habits-nav-label">{navLabel}</span>
          <button
            type="button"
            className="habits-nav-btn"
            onClick={() => shiftAnchor(1)}
            disabled={anchor >= today && viewMode === "week"}
            aria-label={`Next ${viewMode}`}
          >
            ›
          </button>
          <button
            type="button"
            className="habits-nav-today"
            onClick={() => setAnchor(today)}
            disabled={
              viewMode === "week"
                ? startOfWeek(anchor, weekStart) === startOfWeek(today, weekStart)
                : startOfMonth(anchor) === startOfMonth(today)
            }
          >
            Today
          </button>
        </div>

        <div className="habits-toolbar-spacer" />

        <div className="habits-segment" role="tablist" aria-label="View">
          <button
            type="button"
            className="habits-segment-btn"
            data-active={viewMode === "week"}
            onClick={() => setViewMode("week")}
            role="tab"
          >
            Week
          </button>
          <button
            type="button"
            className="habits-segment-btn"
            data-active={viewMode === "month"}
            onClick={() => setViewMode("month")}
            role="tab"
          >
            Month
          </button>
        </div>

        <label className="habits-weekstart">
          <span className="habits-weekstart-label">Starts</span>
          <select
            className="habits-weekstart-select"
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value as WeekStart)}
          >
            <option value="mon">Mon</option>
            <option value="sun">Sun</option>
          </select>
        </label>
      </div>

      <div className="habits-list">
        {sortedHabits.map((node) => (
          <HabitCard
            key={node.id}
            node={node}
            state={habits.get(node.id)}
            today={today}
            anchor={anchor}
            viewMode={viewMode}
            weekStart={weekStart}
            onSelectNode={onSelectNode}
            onToggleDay={handleToggleDay}
            onSetStartedOn={handleSetStartedOn}
          />
        ))}
      </div>
    </div>
  );
}

type HabitCardProps = {
  node: Node;
  state: HabitState | undefined;
  today: string;
  anchor: string;
  viewMode: ViewMode;
  weekStart: WeekStart;
  onSelectNode: (nodeId: string) => void;
  onToggleDay: (nodeId: string, date: string, currentlyDone: boolean) => void;
  onSetStartedOn: (nodeId: string, value: string | null) => void;
};

function HabitCard({
  node,
  state,
  today,
  anchor,
  viewMode,
  weekStart,
  onSelectNode,
  onToggleDay,
  onSetStartedOn,
}: HabitCardProps) {
  const data = state?.data;

  // Render the calendar grid immediately — even before the fetch lands —
  // using whatever history we have (empty if not yet fetched). Stats fall
  // back to "—" until data arrives. Avoids a blocking spinner that makes
  // the view feel slow on first paint.
  const history = data?.history ?? [];
  const startedOn = data?.started_on ?? null;
  const cells = useMemo(() => {
    return viewMode === "week"
      ? buildWeek(history, anchor, today, weekStart, startedOn)
      : buildMonth(history, anchor, today, weekStart, startedOn);
  }, [history, viewMode, anchor, today, weekStart, startedOn]);

  const stats = useMemo(
    () => (data ? statsFor(data.history, startedOn, today) : null),
    [data, startedOn, today],
  );
  const streak = data?.streak.streak ?? 0;
  const atRisk = data?.streak.atRisk ?? false;
  const isLoading = !!state?.loading && !data;

  const headers = useMemo(() => weekdayHeader(weekStart), [weekStart]);

  return (
    <article className="habit-card" data-at-risk={atRisk || undefined}>
      <header className="habit-card-head">
        <div className="habit-card-titlewrap">
          <button
            type="button"
            className="habit-card-title-btn"
            onClick={() => onSelectNode(node.id)}
            title="Open in graph"
          >
            <span className="habit-card-title">{node.title}</span>
            {node.summary ? (
              <span className="habit-card-summary">{node.summary}</span>
            ) : null}
          </button>
          <label className="habit-card-started" title="Start date — stats anchor here">
            <span className="habit-card-started-label">Started</span>
            <input
              type="date"
              className="habit-card-started-input"
              value={startedOn ?? ""}
              max={today}
              onChange={(e) => {
                const v = e.target.value;
                onSetStartedOn(node.id, v === "" ? null : v);
              }}
            />
            {startedOn ? (
              <button
                type="button"
                className="habit-card-started-clear"
                onClick={() => onSetStartedOn(node.id, null)}
                aria-label="Clear start date"
                title="Clear start date"
              >
                ×
              </button>
            ) : null}
          </label>
        </div>
        <div className="habit-card-stats" data-loading={isLoading || undefined}>
          <span className="habit-card-stat" data-zero={streak === 0 || undefined}>
            <span className="habit-card-stat-flame" aria-hidden="true">🔥</span>
            <strong>{isLoading ? "—" : streak}</strong>
            <span className="habit-card-stat-soft">
              day{streak === 1 ? "" : "s"} streak
            </span>
          </span>
          <span className="habit-card-stat-sep" aria-hidden="true">·</span>
          <span className="habit-card-stat">
            <strong>{isLoading ? "—" : `${stats?.pct ?? 0}%`}</strong>
            <span className="habit-card-stat-soft">of last 30 days</span>
          </span>
          {/* "needs today" text removed per request — the card's red outline
              (driven by atRisk) already signals it. */}
        </div>
      </header>

      {state?.error && !data ? (
        <div className="habit-card-error">Failed to load: {state.error}</div>
      ) : (
        viewMode === "week" ? (
          <div className="habit-strip" role="group" aria-label="Week">
            {cells.map((d) => (
              <button
                key={d.date}
                type="button"
                className="habit-strip-day"
                data-today={d.isToday || undefined}
                data-done={d.done || undefined}
                data-future={d.isFuture || undefined}
                data-before-start={d.isBeforeStart || undefined}
                disabled={!d.toggleable}
                onClick={() => d.toggleable && onToggleDay(node.id, d.date, d.done)}
                title={
                  d.toggleable
                    ? d.done
                      ? `${d.date} · done — tap to undo`
                      : `${d.date} · tap to mark done`
                    : `${d.date}${d.done ? " · done" : ""}`
                }
              >
                <span className="habit-strip-weekday">{d.weekday}</span>
                <span className="habit-strip-num">{d.dayNum}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="habit-month" role="group" aria-label="Month">
            <div className="habit-month-header">
              {headers.map((h, i) => (
                <span key={i} className="habit-month-header-cell">
                  {h}
                </span>
              ))}
            </div>
            <div className="habit-month-grid">
              {cells.map((d) => (
                <button
                  key={d.date}
                  type="button"
                  className="habit-month-day"
                  data-today={d.isToday || undefined}
                  data-done={d.done || undefined}
                  data-future={d.isFuture || undefined}
                  data-other-month={d.isOtherMonth || undefined}
                  data-before-start={d.isBeforeStart || undefined}
                  disabled={!d.toggleable}
                  onClick={() => d.toggleable && onToggleDay(node.id, d.date, d.done)}
                  title={
                    d.toggleable
                      ? d.done
                        ? `${d.date} · done — tap to undo`
                        : `${d.date} · tap to mark done`
                      : `${d.date}${d.done ? " · done" : ""}`
                  }
                  aria-label={`${WEEKDAY_FULL[dayOfWeek(d.date)]} ${d.date}${d.done ? " — done" : ""}`}
                >
                  {d.dayNum}
                </button>
              ))}
            </div>
          </div>
        )
      )}
    </article>
  );
}
