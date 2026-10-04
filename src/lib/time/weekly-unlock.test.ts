import { afterEach, describe, expect, it, vi } from "vitest";

import { isWeeklyReflectionAvailable } from "./weekly-unlock";

describe("isWeeklyReflectionAvailable", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens on Sunday only", () => {
    expect(isWeeklyReflectionAvailable(new Date(2026, 9, 4))).toBe(true); // a Sunday
    expect(isWeeklyReflectionAvailable(new Date(2026, 9, 5))).toBe(false);
  });

  it("opens any day with the dev flag", () => {
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => (k === "dev:unlock-weekly" ? "1" : null) } });
    expect(isWeeklyReflectionAvailable(new Date(2026, 9, 5))).toBe(true);
  });
});
