// Auto-tidy (owner, R1 "for later"): after a dump, a chat change or a rescore the
// graph used to keep every node's OLD resting place and squeeze the new ones in
// beside their parents, so it drifted into a tangle until "Reset layout" was
// pressed. Now every change gets the fresh tree layout — exactly what Reset
// layout draws — shifted into the frame already on screen (so the camera stays
// put), with each node starting from where it is now so it glides there.

export type TidyPoint = {
  id: string;
  restX: number;
  restY: number;
  x?: number;
  y?: number;
  manual_position?: boolean | null;
};

export type GlideStart = { x: number; y: number };

const finite = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Moves the fresh layout `next` into the frame of the layout on screen `prev`
 * (in place) and returns where each moving node starts its glide.
 *
 * - The offset is the mean rest-position shift of the auto-placed nodes both
 *   layouts share, so the graph as a whole stays where the camera looks.
 * - Manually placed nodes (`manual_position`) keep their saved coordinates.
 * - A new node starts at its nearest ancestor that is already on screen, so it
 *   grows out of its parent; with no such ancestor it simply appears in place.
 * - Every auto-placed node ends up with x/y at its start (or its rest when it
 *   doesn't move), so the first frame matches the previous one.
 */
export function retidyFromPrevious<T extends TidyPoint>(
  next: T[],
  prev: readonly TidyPoint[],
  parentOf: ReadonlyMap<string, string>,
): Map<string, GlideStart> {
  const glide = new Map<string, GlideStart>();
  if (prev.length === 0) return glide;
  const prevById = new Map(prev.map((node) => [node.id, node]));

  let sumX = 0;
  let sumY = 0;
  let shared = 0;
  for (const node of next) {
    if (node.manual_position) continue;
    const before = prevById.get(node.id);
    if (!before || before.manual_position) continue;
    if (!finite(before.restX) || !finite(before.restY)) continue;
    sumX += before.restX - node.restX;
    sumY += before.restY - node.restY;
    shared += 1;
  }
  const dx = shared > 0 ? sumX / shared : 0;
  const dy = shared > 0 ? sumY / shared : 0;

  const onScreen = (id: string): GlideStart | null => {
    const before = prevById.get(id);
    return before && finite(before.x) && finite(before.y) ? { x: before.x, y: before.y } : null;
  };

  for (const node of next) {
    if (node.manual_position) continue;
    node.restX += dx;
    node.restY += dy;

    let start = onScreen(node.id);
    if (!start) {
      // Walk up to the nearest ancestor already drawn (cycle-safe).
      const seen = new Set<string>([node.id]);
      let parent = parentOf.get(node.id);
      while (parent && !seen.has(parent) && !start) {
        seen.add(parent);
        start = onScreen(parent);
        parent = parentOf.get(parent);
      }
    }

    if (start && (Math.abs(start.x - node.restX) > 0.5 || Math.abs(start.y - node.restY) > 0.5)) {
      glide.set(node.id, start);
      node.x = start.x;
      node.y = start.y;
    } else {
      node.x = node.restX;
      node.y = node.restY;
    }
  }
  return glide;
}

/** Glide progress for tick `tick` of `total` (ease in-out, clamped to 0..1). */
export function glideProgress(tick: number, total: number): number {
  const t = total <= 0 ? 1 : Math.min(1, Math.max(0, tick / total));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
