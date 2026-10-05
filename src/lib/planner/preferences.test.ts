import { describe, expect, it } from "vitest";

import {
  applyToList,
  budgetMinutesOn,
  budgetRequestsFor,
  budgetsBehindToday,
  describePreference,
  describeSuggestedPreference,
  MAX_PREFERENCES,
  parsePreferenceChanges,
  parsePreferenceUndo,
  planningPreferenceLines,
  preferenceLabel,
  preferencesFromMetadata,
  preferencesSnapshotBlock,
  sameTopic,
  undoOnList,
  workdayEndMinute,
  type Preference,
} from "./preferences";

const WED = "2026-10-07";
const SAT = "2026-10-10";
const CODING_NODE = "11111111-1111-4111-8111-111111111111";

function pref(over: Partial<Preference> & Pick<Preference, "id" | "kind">): Preference {
  return {
    title: "",
    minutes: null,
    per: null,
    days: [1, 2, 3, 4, 5, 6, 7],
    node_id: null,
    start_time: null,
    end_time: null,
    part_of_day: null,
    ...over,
  };
}

const coding = pref({ id: "pref-coding", kind: "budget", title: "Coding", minutes: 240, per: "day", node_id: CODING_NODE });
const hours = pref({ id: "pref-hours", kind: "hours", end_time: "22:00" });

let n = 0;
const newId = () => `pref-new-${++n}`;

describe("parsePreferenceChanges", () => {
  it("adds a daily budget", () => {
    const parsed = parsePreferenceChanges(
      { changes: [{ action: "add", kind: "budget", title: "Coding", minutes: 240, node_id: CODING_NODE }] },
      [],
    );
    expect(parsed).toEqual({
      ok: true,
      changes: [
        {
          action: "add",
          fields: {
            kind: "budget",
            title: "Coding",
            minutes: 240,
            per: "day",
            days: [1, 2, 3, 4, 5, 6, 7],
            node_id: CODING_NODE,
            start_time: null,
            end_time: null,
            part_of_day: null,
          },
        },
      ],
    });
  });

  it('"make it 3h" said as a new add updates the saved budget — never a second one', () => {
    const parsed = parsePreferenceChanges({ changes: [{ action: "add", kind: "budget", title: "coding", minutes: 180 }] }, [coding]);
    expect(parsed).toEqual({ ok: true, changes: [{ action: "update", preference_id: "pref-coding", patch: { minutes: 180 } }] });
    // Same node, other words → still the same budget.
    const byNode = parsePreferenceChanges(
      { changes: [{ action: "add", kind: "budget", title: "Programming", minutes: 180, node_id: CODING_NODE }] },
      [coding],
    );
    expect(byNode.ok && byNode.changes[0].action).toBe("update");
  });

  it("a budget for something else is a new one", () => {
    const parsed = parsePreferenceChanges({ changes: [{ action: "add", kind: "budget", title: "Italian", minutes: 120, days: "weekdays" }] }, [coding]);
    expect(parsed.ok && parsed.changes[0]).toMatchObject({ action: "add", fields: { title: "Italian", days: [1, 2, 3, 4, 5] } });
  });

  it("updates and removes by id", () => {
    expect(parsePreferenceChanges({ changes: [{ action: "update", preference_id: "pref-coding", minutes: "3h" }] }, [coding])).toEqual({
      ok: true,
      changes: [{ action: "update", preference_id: "pref-coding", patch: { minutes: 180 } }],
    });
    expect(parsePreferenceChanges({ changes: [{ action: "remove", preference_id: "pref-coding" }] }, [coding])).toEqual({
      ok: true,
      changes: [{ action: "remove", preference_id: "pref-coding" }],
    });
    const unknown = parsePreferenceChanges({ changes: [{ action: "remove", preference_id: "nope-123" }] }, [coding]);
    expect(unknown.ok).toBe(false);
  });

  it("working hours are one row: a second add fills in the other end", () => {
    const parsed = parsePreferenceChanges({ changes: [{ action: "add", kind: "hours", from: "9am" }] }, [hours]);
    expect(parsed).toEqual({ ok: true, changes: [{ action: "update", preference_id: "pref-hours", patch: { start_time: "09:00" } }] });
  });

  it("checks what each kind needs", () => {
    expect(parsePreferenceChanges({ changes: [{ action: "add", kind: "budget", title: "Coding" }] }, []).ok).toBe(false);
    expect(parsePreferenceChanges({ changes: [{ action: "add", kind: "peak", from: "09:00" }] }, []).ok).toBe(false);
    expect(parsePreferenceChanges({ changes: [{ action: "add", kind: "peak", from: "12:00", until: "09:00" }] }, []).ok).toBe(false);
    expect(parsePreferenceChanges({ changes: [{ action: "add", kind: "mood" }] }, []).ok).toBe(false);
    expect(parsePreferenceChanges({ changes: [{ action: "add", kind: "rule", title: "Gym in the mornings" }] }, []).ok).toBe(true);
  });

  it("an add that changes nothing is reported, not saved twice", () => {
    const parsed = parsePreferenceChanges({ changes: [{ action: "add", kind: "hours", until: "22:00" }] }, [hours]);
    expect(parsed.ok).toBe(false);
  });

  it(`keeps at most ${MAX_PREFERENCES}`, () => {
    const full = Array.from({ length: MAX_PREFERENCES }, (_, i) => pref({ id: `pref-rule-${i}`, kind: "rule", title: `Rule ${i}` }));
    expect(parsePreferenceChanges({ changes: [{ action: "add", kind: "rule", title: "One more" }] }, full).ok).toBe(false);
  });
});

describe("applying and undoing", () => {
  it("Undo puts back exactly what changed, leaving later edits alone", () => {
    const parsed = parsePreferenceChanges(
      {
        changes: [
          { action: "update", preference_id: "pref-coding", minutes: 180 },
          { action: "add", kind: "peak", from: "09:00", until: "12:00" },
          { action: "remove", preference_id: "pref-hours" },
        ],
      },
      [coding, hours],
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const { next, applied, undo } = applyToList([coding, hours], parsed.changes, newId);
    expect(applied.map((a) => a.action)).toEqual(["update", "add", "remove"]);
    expect(next.find((p) => p.id === "pref-coding")?.minutes).toBe(180);
    expect(next.some((p) => p.id === "pref-hours")).toBe(false);

    const later = [...next, pref({ id: "pref-later", kind: "rule", title: "No meetings on Fridays" })];
    const restored = undoOnList(later, undo);
    expect(restored.find((p) => p.id === "pref-coding")?.minutes).toBe(240);
    expect(restored.find((p) => p.id === "pref-hours")).toEqual(hours);
    expect(restored.some((p) => p.kind === "peak")).toBe(false);
    expect(restored.some((p) => p.id === "pref-later")).toBe(true);
  });

  it("validates an Undo snapshot from the browser", () => {
    expect(parsePreferenceUndo({ created: ["pref-new-1"], before: [coding] })).toEqual({ ok: true, undo: { created: ["pref-new-1"], before: [coding] } });
    expect(parsePreferenceUndo({ created: [], before: [] }).ok).toBe(false);
    expect(parsePreferenceUndo({ created: ["x"], before: [] }).ok).toBe(false);
    expect(parsePreferenceUndo({ created: [], before: [{ id: "pref-bad", kind: "budget", title: "Coding" }] }).ok).toBe(false);
  });

  it("reads the stored list, dropping bad rows and duplicates", () => {
    expect(preferencesFromMetadata({ standing_preferences: [coding, coding, { id: "x" }, "junk"], auto_add_confident: false })).toEqual([coding]);
    expect(preferencesFromMetadata(null)).toEqual([]);
    expect(preferencesFromMetadata({ standing_preferences: "nope" })).toEqual([]);
  });
});

describe("words", () => {
  it("describes each kind", () => {
    expect(describePreference(coding)).toBe("4h a day");
    expect(describePreference(pref({ id: "p-1234567", kind: "budget", title: "Italian", minutes: 120, per: "day", days: [1, 2, 3, 4, 5], part_of_day: "morning" }))).toBe(
      "2h a day · Mon–Fri · mornings",
    );
    expect(describePreference(hours)).toBe("No work after 22:00");
    expect(describePreference(pref({ id: "p-1234567", kind: "hours", start_time: "09:00", end_time: "22:00" }))).toBe("09:00–22:00");
    expect(preferenceLabel(hours)).toBe("Working hours");
    expect(describePreference(pref({ id: "p-1234567", kind: "peak", start_time: "09:00", end_time: "12:00" }))).toBe("09:00–12:00");
  });

  it("the chat snapshot block is byte-stable whatever the stored order", () => {
    const a = preferencesSnapshotBlock([coding, hours]);
    expect(a).toBe(preferencesSnapshotBlock([hours, coding]));
    expect(a).toContain("- Coding: 4h a day (node 11111111-1111-4111-8111-111111111111) — id: pref-coding");
    expect(preferencesSnapshotBlock([])).toBeNull();
  });

  it("a suggested row in words", () => {
    expect(describeSuggestedPreference({ action: "add", kind: "budget", title: "Coding", minutes: 240 })).toBe("Keep: Coding — 4h a day");
    expect(describeSuggestedPreference({ action: "remove", title: "Coding" })).toBe("Forget Coding");
  });

  it("matches the same activity, not merely the same filler", () => {
    expect(sameTopic("coding", "Coding")).toBe(true);
    expect(sameTopic("stats", "Statistics")).toBe(true);
    expect(sameTopic("deep work coding", "Coding")).toBe(true);
    expect(sameTopic("italian", "coding")).toBe(false);
    expect(sameTopic("practice", "coding")).toBe(false);
  });
});

describe("planning", () => {
  it("a weekly budget spreads over its days; a weekday budget skips the weekend", () => {
    const weekly = pref({ id: "p-week1", kind: "budget", title: "Italian", minutes: 600, per: "week", days: [1, 2, 3, 4, 5] });
    expect(budgetMinutesOn(weekly, WED)).toBe(120);
    expect(budgetMinutesOn(weekly, SAT)).toBeNull();
    expect(budgetMinutesOn(coding, SAT)).toBe(240);
  });

  it("budgets become requests, capped at 60% of the session", () => {
    expect(budgetRequestsFor({ prefs: [coding, hours], dateISO: WED, sessionMinutes: 15 * 60 })).toEqual([
      { text: "Coding — your 4h a day", phrase: "coding", minutes: 240, node_id: CODING_NODE },
    ]);
    // A 5-hour evening: 4h would crowd out everything else.
    expect(budgetRequestsFor({ prefs: [coding], dateISO: WED, sessionMinutes: 300 })[0].minutes).toBe(180);
  });

  it("what the user typed into the plan wins over the budget", () => {
    expect(budgetRequestsFor({ prefs: [coding], dateISO: WED, sessionMinutes: 900, include: "2h of coding, 1h italian" })).toEqual([]);
    expect(budgetRequestsFor({ prefs: [coding], dateISO: WED, sessionMinutes: 900, include: "3h of Italian" })).toHaveLength(1);
  });

  it("working hours end the day; best hours and rules ride along as context", () => {
    expect(workdayEndMinute([coding, hours])).toBe(22 * 60);
    expect(workdayEndMinute([coding])).toBeNull();
    const lines = planningPreferenceLines(
      [
        coding,
        hours,
        pref({ id: "p-peak12", kind: "peak", start_time: "09:00", end_time: "12:00" }),
        pref({ id: "p-rule12", kind: "rule", title: "Gym in the mornings" }),
        pref({ id: "p-rule13", kind: "rule", title: "No meetings", days: [5] }),
      ],
      WED,
    );
    expect(lines).toEqual(["No work after 22:00.", "Sharpest 09:00–12:00: put the hardest deep work there.", "Gym in the mornings."]);
  });
});

describe("Focus lean", () => {
  const nodes = [
    { id: CODING_NODE, title: "Side projects", node_type: "area" },
    { id: "22222222-2222-4222-8222-222222222222", title: "Italian", node_type: "class" },
  ];
  const italian = pref({ id: "p-ital1", kind: "budget", title: "Italian", minutes: 60, per: "day", days: [1, 2, 3, 4, 5] });

  it("a budget nothing was done on today leans its node forward; by link, else by name", () => {
    const behind = budgetsBehindToday({ prefs: [coding, italian], dateISO: WED, nodes, workedToday: () => false });
    expect([...behind.entries()]).toEqual([
      [CODING_NODE, "Your 4h a day on Coding — not started today"],
      ["22222222-2222-4222-8222-222222222222", "Your 1h a day on Italian — not started today"],
    ]);
  });

  it("not once something under it got done today, nor on a day the budget skips", () => {
    expect(budgetsBehindToday({ prefs: [coding], dateISO: WED, nodes, workedToday: (id) => id === CODING_NODE }).size).toBe(0);
    expect(budgetsBehindToday({ prefs: [italian], dateISO: SAT, nodes, workedToday: () => false }).size).toBe(0);
  });
});
