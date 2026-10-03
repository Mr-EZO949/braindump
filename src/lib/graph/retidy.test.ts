import { describe, expect, it } from "vitest";

import { glideProgress, retidyFromPrevious, type TidyPoint } from "./retidy";

const pt = (id: string, restX: number, restY: number, extra: Partial<TidyPoint> = {}): TidyPoint => ({
  id,
  restX,
  restY,
  x: restX,
  y: restY,
  ...extra,
});

describe("retidyFromPrevious", () => {
  it("does nothing on the first layout (nothing on screen yet)", () => {
    const next = [pt("a", 0, 0), pt("b", 100, 200)];
    const glide = retidyFromPrevious(next, [], new Map());
    expect(glide.size).toBe(0);
    expect(next[1]).toMatchObject({ restX: 100, restY: 200, x: 100, y: 200 });
  });

  it("keeps an unchanged layout exactly where it was, even when the fresh frame is re-centred", () => {
    // Same tree, but buildGraphLayout re-centred it 50px to the left.
    const prev = [pt("root", 0, 0), pt("a", -100, 200), pt("b", 100, 200)];
    const next = [pt("root", -50, 0), pt("a", -150, 200), pt("b", 50, 200)];
    const glide = retidyFromPrevious(next, prev, new Map([["a", "root"], ["b", "root"]]));
    expect(glide.size).toBe(0);
    expect(next.map((n) => [n.restX, n.restY])).toEqual([[0, 0], [-100, 200], [100, 200]]);
  });

  it("moves existing nodes to the tidy layout from where they are drawn now", () => {
    // A third child arrived: the siblings spread out around the root.
    const prev = [pt("root", 0, 0), pt("a", -60, 200, { x: -70, y: 210 }), pt("b", 60, 200)];
    const next = [pt("root", 0, 0), pt("a", -120, 200), pt("b", 0, 200), pt("c", 120, 200)];
    const glide = retidyFromPrevious(next, prev, new Map([["a", "root"], ["b", "root"], ["c", "root"]]));
    // Mean shift of the shared nodes: root 0, a +60, b +60 → +40.
    expect(next.find((n) => n.id === "root")!.restX).toBe(40);
    // "a" starts where it is drawn (incl. the sim's nudge), not at its old rest.
    expect(glide.get("a")).toEqual({ x: -70, y: 210 });
    expect(next.find((n) => n.id === "a")).toMatchObject({ restX: -80, x: -70, y: 210 });
  });

  it("grows a new node out of its nearest ancestor on screen", () => {
    const prev = [pt("root", 0, 0), pt("a", 0, 200)];
    const next = [pt("root", 0, 0), pt("a", 0, 200), pt("b", 0, 400), pt("c", 0, 600)];
    // c's parent b is new too: c starts at a, the nearest one drawn.
    const glide = retidyFromPrevious(next, prev, new Map([["a", "root"], ["b", "a"], ["c", "b"]]));
    expect(glide.get("b")).toEqual({ x: 0, y: 200 });
    expect(glide.get("c")).toEqual({ x: 0, y: 200 });
    expect(next.find((n) => n.id === "c")).toMatchObject({ restY: 600, x: 0, y: 200 });
  });

  it("puts a new node without a drawn ancestor straight at its rest", () => {
    const prev = [pt("root", 0, 0)];
    const next = [pt("root", 0, 0), pt("island", 500, 500)];
    const glide = retidyFromPrevious(next, prev, new Map());
    expect(glide.has("island")).toBe(false);
    expect(next[1]).toMatchObject({ x: 500, y: 500 });
  });

  it("never moves manually placed nodes, and leaves them out of the frame shift", () => {
    const prev = [pt("root", 0, 0), pt("pinned", 900, 900, { manual_position: true })];
    const next = [pt("root", -30, 0), pt("pinned", 900, 900, { manual_position: true })];
    const glide = retidyFromPrevious(next, prev, new Map());
    expect(glide.size).toBe(0);
    expect(next[0].restX).toBe(0);
    expect(next[1]).toMatchObject({ restX: 900, restY: 900 });
  });

  it("survives a parent cycle", () => {
    const prev = [pt("root", 0, 0)];
    const next = [pt("root", 0, 0), pt("a", 0, 200), pt("b", 0, 400)];
    const glide = retidyFromPrevious(next, prev, new Map([["a", "b"], ["b", "a"]]));
    expect(glide.size).toBe(0);
  });
});

describe("glideProgress", () => {
  it("runs 0 → 1 with an eased middle", () => {
    expect(glideProgress(0, 24)).toBe(0);
    expect(glideProgress(12, 24)).toBeCloseTo(0.5);
    expect(glideProgress(24, 24)).toBe(1);
    expect(glideProgress(40, 24)).toBe(1);
    expect(glideProgress(3, 0)).toBe(1);
  });
});
