// Server-only: resolve the requesting user's time zone / local date from the
// TIME_ZONE_COOKIE the browser sets on every page load (root layout). Route
// handlers call getRequestToday() instead of new Date().toISOString().

import { cookies } from "next/headers";
import { TIME_ZONE_COOKIE, isValidTimeZone, localDateISO } from "./local-date";

export async function getRequestTimeZone(): Promise<string | null> {
  try {
    const store = await cookies();
    const raw = store.get(TIME_ZONE_COOKIE)?.value;
    if (!raw) return null;
    const tz = decodeURIComponent(raw);
    return isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

// The user's local calendar date right now (UTC if the zone is unknown).
export async function getRequestToday(): Promise<string> {
  return localDateISO(new Date(), await getRequestTimeZone());
}
