// Local-date helpers — the single source of truth for "what day is it for THIS
// user". Pure (no Next.js imports), so client and server share them.
//
// Why this exists: "today" used to be computed as new Date().toISOString()
// .slice(0, 10) all over the codebase. That's the UTC date, not the user's.
// For a user in Milan (UTC+2) it said "yesterday" from 00:00–02:00 local; for a
// US user (UTC-5) it said "tomorrow" for the whole evening. Habits got logged to
// the wrong day, streaks broke, and the planner showed the wrong day's tasks.
//
// Rule: the SERVER never derives "today" from its own clock alone. It uses the
// user's IANA time zone, which the browser sends on every request as the
// TIME_ZONE_COOKIE (see src/lib/time/request-date.ts + the root layout).

export const TIME_ZONE_COOKIE = "bd_tz";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value);
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// YYYY-MM-DD of `date` as seen in `timeZone`. With no/invalid zone:
//   - in the browser → the device's local date (what the user sees)
//   - on the server  → UTC (explicit, never the server's own locale)
export function localDateISO(date: Date = new Date(), timeZone?: string | null): string {
  if (timeZone && isValidTimeZone(timeZone)) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
  if (typeof window !== "undefined") {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return date.toISOString().slice(0, 10);
}

// Calendar arithmetic on a YYYY-MM-DD string (no time zone involved).
export function addDaysISO(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((part) => Number.parseInt(part, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The browser's IANA time zone (client-only; null on the server).
export function browserTimeZone(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}
