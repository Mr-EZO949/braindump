import { beforeEach, describe, expect, it } from "vitest";

import { AI_ASSISTANT } from "./config";
import { shownImportance } from "./context";
import { clearSnapshotPins, pinSnapshot, snapshotDelta, snapshotText, type Snapshot } from "./snapshot-pin";

const node = (id: string, title: string, importance: number, status = "active") => ({
  id,
  text: `${title} [task] — importance ${importance}/100, status: ${status} — id: ${id}`,
});

const base: Snapshot = {
  scope: "workspace (3 active nodes)",
  items: [
    { id: "ws", text: "Workspace overview: 3 active nodes, 1 goals, 2 connections." },
    node("a", "Pass Stats", 70),
    node("b", "Update CV", 55),
    node("c", "Gym", 40),
    // A real snapshot holds ~35 lines; the delta is measured against its size.
    ...Array.from({ length: 12 }, (_, i) => node(`x${i}`, `Other task ${i}`, 30)),
  ],
};

describe("snapshotDelta", () => {
  it("is empty when nothing changed", () => {
    expect(snapshotDelta(base, base)).toBe("");
  });

  it("lists only the changed and new lines, then what left the overview", () => {
    const fresh: Snapshot = {
      scope: "workspace (3 active nodes)",
      items: [
        ...base.items.filter((i) => i.id !== "b"),
        node("d", "Book flights", 45),
        { id: "b", text: "Recently completed: Update CV (id: b)" },
      ],
    };
    const delta = snapshotDelta(base, fresh);
    expect(delta).toContain("Book flights [task]");
    expect(delta).toContain("Recently completed: Update CV (id: b)");
    expect(delta).not.toContain("Pass Stats");
    expect(delta).not.toContain("No longer in the overview");
  });

  it("names a node that left the overview and a changed scope", () => {
    const fresh: Snapshot = { scope: "workspace (2 active nodes)", items: base.items.filter((i) => i.id !== "c") };
    const delta = snapshotDelta(base, fresh);
    expect(delta).toContain("Scope now: workspace (2 active nodes)");
    expect(delta).toContain('No longer in the overview (done, archived, deleted or ranked out): "Gym [task]"');
  });
});

describe("pinSnapshot", () => {
  beforeEach(() => clearSnapshotPins());
  const key = "user:ws";
  const prefixKey = "assistant-v28:explain:2026-10-03";

  it("pins the first snapshot and sends it as is", () => {
    const out = pinSnapshot({ key, prefixKey, fresh: base, now: 0 });
    expect(out).toMatchObject({ pinned: false, delta: "", items: base.items });
  });

  it("keeps sending the pinned snapshot, with the changes in a delta", () => {
    pinSnapshot({ key, prefixKey, fresh: base, now: 0 });
    const fresh = { ...base, items: base.items.map((i) => (i.id === "c" ? node("c", "Gym", 40, "completed") : i)) };
    const out = pinSnapshot({ key, prefixKey, fresh, now: 60_000 });
    expect(out.pinned).toBe(true);
    expect(snapshotText(out.items)).toBe(snapshotText(base.items)); // the cached bytes
    expect(out.delta).toContain("status: completed");
  });

  it("re-pins once the pin is older than the cache, or the prompt changed", () => {
    pinSnapshot({ key, prefixKey, fresh: base, now: 0 });
    const fresh = { ...base, items: base.items.slice(0, 5) };
    expect(pinSnapshot({ key, prefixKey, fresh, now: AI_ASSISTANT.SNAPSHOT_PIN_TTL_MS + 1 }).pinned).toBe(false);
    expect(pinSnapshot({ key, prefixKey: "assistant-v28:plan:2026-10-03", fresh: base, now: AI_ASSISTANT.SNAPSHOT_PIN_TTL_MS + 2 }).pinned).toBe(false);
  });

  it("each use keeps the pin alive", () => {
    pinSnapshot({ key, prefixKey, fresh: base, now: 0 });
    const step = AI_ASSISTANT.SNAPSHOT_PIN_TTL_MS - 1_000;
    expect(pinSnapshot({ key, prefixKey, fresh: base, now: step }).pinned).toBe(true);
    expect(pinSnapshot({ key, prefixKey, fresh: base, now: 2 * step }).pinned).toBe(true);
  });

  it("re-pins when the changes outgrow a third of the snapshot", () => {
    pinSnapshot({ key, prefixKey, fresh: base, now: 0 });
    const fresh = { ...base, items: base.items.map((i) => (i.id === "ws" ? i : { ...i, text: `${i.text} (moved)` })) };
    const out = pinSnapshot({ key, prefixKey, fresh, now: 1_000 });
    expect(out).toMatchObject({ pinned: false, delta: "", items: fresh.items });
  });

  it("keeps pins per user and workspace", () => {
    pinSnapshot({ key, prefixKey, fresh: base, now: 0 });
    expect(pinSnapshot({ key: "other:ws", prefixKey, fresh: base, now: 1 }).pinned).toBe(false);
  });
});

describe("shownImportance", () => {
  it("shows importance in steps of 5, so a re-score's ±1 doesn't change the line", () => {
    expect([53, 54, 55, 56, 57].map(shownImportance)).toEqual([55, 55, 55, 55, 55]);
    expect(shownImportance(52)).toBe(50);
    expect(shownImportance(99)).toBe(100);
    expect(shownImportance(-3)).toBe(0);
  });
});
