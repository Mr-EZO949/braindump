// Streak computation for habit nodes.
// Strict streaks (1 missed day breaks). Date arithmetic uses UTC consistently
// so the server and any test fixtures agree. Client converts to/from the
// user's local date when reading/writing.

export type CompletionDate = string; // YYYY-MM-DD

export function todayLocalISO(now: Date = new Date()): string {
  // Local-date string — used by the client to mark "today" in the user's
  // timezone. The server stores whatever the client sends as `completed_on`.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Day hints to POST to the planner endpoints (top-now / daily-brief / plan) so
 * it computes "today" and "this week" in the USER's timezone — not the server's
 * (UTC on hosted deploys), which would be a day off for non-UTC users. Spread
 * into the request body alongside workspace_id.
 */
export function clientDayHints(now: Date = new Date()): {
  client_today: string;
  client_tz_offset: number;
} {
  return { client_today: todayLocalISO(now), client_tz_offset: now.getTimezoneOffset() };
}

export function yesterdayLocalISO(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(now.getDate() - 1);
  return todayLocalISO(d);
}

function dateMinusOneISO(iso: CompletionDate): CompletionDate {
  // Walks back one calendar day in UTC. Used purely for streak-walking the
  // sorted list of completions; consistent with how completed_on is stored.
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Returns: streak length walking back from `today` while consecutive days
// are present in the completed-set. If today isn't in the set but yesterday
// is, streak counts from yesterday (so a habit not yet done today still
// shows a non-zero streak — it's just at risk).
export function computeStreak(
  completed: Iterable<CompletionDate>,
  today: CompletionDate,
): { streak: number; doneToday: boolean; atRisk: boolean } {
  const set = new Set(completed);
  const doneToday = set.has(today);

  // Pick the cursor: today if done, otherwise yesterday if done. Otherwise
  // the streak is 0.
  let cursor: CompletionDate;
  if (doneToday) {
    cursor = today;
  } else {
    const yesterday = dateMinusOneISO(today);
    if (!set.has(yesterday)) {
      return { streak: 0, doneToday: false, atRisk: false };
    }
    cursor = yesterday;
  }

  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = dateMinusOneISO(cursor);
  }

  return { streak, doneToday, atRisk: !doneToday && streak > 0 };
}

// Returns the last N days as an array of {date, done} pairs ending today,
// for the mini-calendar visualization in the details panel.
export function lastNDays(
  completed: Iterable<CompletionDate>,
  today: CompletionDate,
  n: number,
): Array<{ date: CompletionDate; done: boolean }> {
  const set = new Set(completed);
  const out: Array<{ date: CompletionDate; done: boolean }> = [];
  let cursor = today;
  for (let i = 0; i < n; i++) {
    out.unshift({ date: cursor, done: set.has(cursor) });
    cursor = dateMinusOneISO(cursor);
  }
  return out;
}

// Optimistic tick: what the server will return after marking/unmarking `date`,
// computed locally so the UI flips on tap instead of after the round trip.
// Toggling today adjusts the streak arithmetically (exact for any length);
// any other day re-walks the loaded history, and the server's response
// replaces this a moment later either way.
export function applyHabitDayToggle<
  T extends {
    history: Array<{ date: CompletionDate; done: boolean }>;
    streak: { streak: number; doneToday: boolean; atRisk: boolean };
  },
>(data: T, date: CompletionDate, done: boolean, today: CompletionDate): T {
  const history = data.history.map((day) => (day.date === date ? { ...day, done } : day));
  let streak = data.streak;
  if (date === today) {
    if (done && !streak.doneToday) {
      streak = { streak: streak.streak + 1, doneToday: true, atRisk: false };
    } else if (!done && streak.doneToday) {
      const remaining = Math.max(0, streak.streak - 1);
      streak = { streak: remaining, doneToday: false, atRisk: remaining > 0 };
    }
  } else {
    streak = computeStreak(
      history.filter((day) => day.done).map((day) => day.date),
      today,
    );
  }
  return { ...data, history, streak };
}
