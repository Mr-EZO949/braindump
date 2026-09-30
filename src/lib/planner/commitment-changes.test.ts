import { describe, expect, it } from "vitest";

import {
  parseClock,
  parseCommitmentChanges,
  parseCommitmentUndo,
  parseDateBound,
  parseDays,
  sameActivity,
} from "./commitment-changes";
import type { Commitment } from "./commitments";

const TODAY = "2026-10-07"; // a Wednesday
const practice: Commitment = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Volleyball practice",
  node_id: null,
  days: [2, 4],
  start_time: "17:00",
  end_time: "18:30",
  starts_on: null,
  ends_on: null,
};

describe("reading the user's days, times and dates", () => {
  it("days", () => {
    expect(parseDays(["mon", "wed", "fri"])).toEqual([1, 3, 5]);
    expect(parseDays("Tuesdays and Thursdays")).toEqual([2, 4]);
    expect(parseDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(["every day"])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseDays([7, 1])).toEqual([1, 7]);
    expect(parseDays(["someday"])).toBeNull();
    expect(parseDays([])).toBeNull();
  });

  it("clock times", () => {
    expect(parseClock("14:00")).toBe("14:00");
    expect(parseClock("14:00:00")).toBe("14:00");
    expect(parseClock("2pm")).toBe("14:00");
    expect(parseClock("2:30 p.m.")).toBe("14:30");
    expect(parseClock("12am")).toBe("00:00");
    expect(parseClock("noon")).toBe("12:00");
    expect(parseClock("9")).toBe("09:00");
    expect(parseClock("3")).toBe("15:00"); // a bare 1–7 is the afternoon
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("soon")).toBeNull();
  });

  it("date bounds", () => {
    expect(parseDateBound("dec 20", TODAY)).toBe("2026-12-20");
    expect(parseDateBound("until friday", TODAY)).toBe("2026-10-09");
    expect(parseDateBound("for 6 weeks", TODAY)).toBe("2026-11-18");
    expect(parseDateBound("", TODAY)).toBeNull();
    expect(parseDateBound("end of term", TODAY)).toBeUndefined();
  });
});

describe("parseCommitmentChanges", () => {
  it("adds with a default hour when no end time is said", () => {
    const parsed = parseCommitmentChanges(
      { changes: [{ action: "add", title: "Stats lecture", days: ["mon", "tue", "wed", "thu", "fri"], start_time: "2pm", until: "dec 20" }] },
      { today: TODAY, existing: [] },
    );
    expect(parsed).toEqual({
      ok: true,
      changes: [
        {
          action: "add",
          fields: {
            title: "Stats lecture",
            node_id: null,
            days: [1, 2, 3, 4, 5],
            start_time: "14:00",
            end_time: "15:00",
            starts_on: null,
            ends_on: "2026-12-20",
          },
        },
      ],
    });
  });

  it("moving the start keeps the length; removing needs a real id", () => {
    const parsed = parseCommitmentChanges(
      { changes: [{ action: "update", commitment_id: practice.id, start_time: "18:00" }] },
      { today: TODAY, existing: [practice] },
    );
    expect(parsed).toEqual({
      ok: true,
      changes: [{ action: "update", commitment_id: practice.id, patch: { start_time: "18:00", end_time: "19:30" } }],
    });
    expect(
      parseCommitmentChanges({ changes: [{ action: "remove", commitment_id: "nope" }] }, { today: TODAY, existing: [practice] }).ok,
    ).toBe(false);
  });

  it("an 'update' that turns one activity into another becomes an add — the old one stays", () => {
    const parsed = parseCommitmentChanges(
      {
        changes: [
          { action: "update", commitment_id: practice.id, title: "Stats lecture", days: ["mon", "tue"], start_time: "14:00", until: "dec 20" },
        ],
      },
      { today: TODAY, existing: [practice] },
    );
    expect(parsed).toMatchObject({
      ok: true,
      changes: [{ action: "add", fields: { title: "Stats lecture", days: [1, 2], start_time: "14:00", ends_on: "2026-12-20" } }],
    });
    // Same activity, new time → a real update; a bare rename stays a rename.
    const moved = parseCommitmentChanges(
      { changes: [{ action: "update", commitment_id: practice.id, title: "Volleyball", start_time: "18:00" }] },
      { today: TODAY, existing: [practice] },
    );
    expect(moved).toMatchObject({ ok: true, changes: [{ action: "update" }] });
    const renamed = parseCommitmentChanges(
      { changes: [{ action: "update", commitment_id: practice.id, title: "Club training" }] },
      { today: TODAY, existing: [practice] },
    );
    expect(renamed).toMatchObject({ ok: true, changes: [{ action: "update", patch: { title: "Club training" } }] });
  });

  it("sameActivity", () => {
    expect(sameActivity("Stats", "Stats lecture")).toBe(true);
    expect(sameActivity("Volleyball practice", "Stats lecture")).toBe(false);
    expect(sameActivity("Practice", "Lecture")).toBe(true); // nothing specific to compare
  });

  it("refuses what it can't save — the model asks instead", () => {
    const check = (row: Record<string, unknown>) =>
      parseCommitmentChanges({ changes: [row] }, { today: TODAY, existing: [practice] });
    expect(check({ action: "add", title: "Stats", days: ["mon"], start_time: "14:00", until: "end of term" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("ask the user"),
    });
    expect(check({ action: "add", title: "Stats", days: ["mon"], start_time: "15:00", end_time: "14:00" }).ok).toBe(false);
    expect(check({ action: "add", title: "Stats", start_time: "14:00" }).ok).toBe(false);
    expect(check({ action: "update", commitment_id: practice.id }).ok).toBe(false);
    expect(check({ action: "reschedule" }).ok).toBe(false);
  });
});

describe("parseCommitmentUndo", () => {
  it("accepts the server's own snapshot and rejects junk", () => {
    const undo = { created: ["22222222-2222-4222-8222-222222222222"], before: [practice] };
    expect(parseCommitmentUndo(undo)).toEqual({ ok: true, undo });
    expect(parseCommitmentUndo({ created: ["x"], before: [] }).ok).toBe(false);
    expect(parseCommitmentUndo({ created: [], before: [{ ...practice, end_time: "16:00" }] }).ok).toBe(false);
    expect(parseCommitmentUndo({}).ok).toBe(false);
  });
});
