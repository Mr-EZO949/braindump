import { describe, expect, it } from "vitest";
import { addDaysISO, isISODate, isValidTimeZone, localDateISO } from "./local-date";

describe("localDateISO", () => {
  // 22:30 UTC on Sep 27 = 00:30 on Sep 28 in Milan (CEST, UTC+2) and 18:30 on
  // Sep 27 in New York (EDT, UTC-4). The old toISOString() logic returned
  // Sep 27 for both — wrong for Milan.
  const instant = new Date("2026-09-27T22:30:00Z");

  it("uses the user's zone, not UTC, east of Greenwich", () => {
    expect(localDateISO(instant, "Europe/Rome")).toBe("2026-09-28");
  });

  it("uses the user's zone west of Greenwich", () => {
    expect(localDateISO(instant, "America/New_York")).toBe("2026-09-27");
  });

  it("falls back to UTC on the server when the zone is missing or invalid", () => {
    expect(localDateISO(instant, null)).toBe("2026-09-27");
    expect(localDateISO(instant, "Not/AZone")).toBe("2026-09-27");
  });
});

describe("addDaysISO", () => {
  it("crosses month and year boundaries", () => {
    expect(addDaysISO("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles leap days", () => {
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("validators", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Europe/Rome")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it("recognizes ISO dates", () => {
    expect(isISODate("2026-09-28")).toBe(true);
    expect(isISODate("2026-9-28")).toBe(false);
    expect(isISODate(null)).toBe(false);
  });
});
