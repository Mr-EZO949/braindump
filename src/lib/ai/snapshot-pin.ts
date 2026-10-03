// Snapshot pinning for the chat prompt cache (fix list #19).
//
// The graph snapshot is the second cached block of every chat call
// (assistant-cache.ts). One changed byte re-writes the whole block at 1.25×,
// and in a burst of chat most messages change the graph (add, done, unlink),
// so most calls re-wrote ~2K tokens to say that one node changed (eval
// 2026-10-03: 4 of 6 calls, ~45% of a warm call's cost). Now the chat route
// keeps sending the snapshot it sent last — still in Anthropic's cache — and
// puts only the lines that changed since into the uncached message block.
//
// Best effort, in memory: a cold server instance, an expired pin or a new
// prompt (version, mode, day) just sends the fresh snapshot, which is what
// every call did before. A pin lives a little under the cache's 5 minutes
// from its last use, and is replaced once the changes outgrow a third of the
// snapshot, so the model never reads a long patch list.

import { AI_ASSISTANT } from "./config";

export interface SnapshotItem {
  id: string;
  text: string;
}

export interface Snapshot {
  scope: string;
  items: SnapshotItem[];
}

interface Pin extends Snapshot {
  // The static prompt the cached snapshot follows (version, mode, day): a
  // different one is a different cache entry, so the pin doesn't apply.
  prefixKey: string;
  usedAt: number;
}

const MAX_PINS = 500;
const pins = new Map<string, Pin>();

export function snapshotText(items: SnapshotItem[]): string {
  return items.map((i) => i.text).join("\n\n");
}

// A short name for an item that left the snapshot: its first line, without
// the id ("Read 'Atomic Habits' [task]").
function label(text: string): string {
  const first = text.split("\n")[0].split(" — ")[0].replace(/\s*\(id: [^)]*\)$/, "");
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

// What changed from `pinned` to `fresh`, as a block that reads on top of the
// pinned snapshot. Pure. Empty when nothing changed.
export function snapshotDelta(pinned: Snapshot, fresh: Snapshot): string {
  const before = new Map(pinned.items.map((i) => [i.id, i.text]));
  const freshIds = new Set(fresh.items.map((i) => i.id));
  const changed = fresh.items.filter((i) => before.get(i.id) !== i.text).map((i) => i.text);
  const gone = pinned.items.filter((i) => !freshIds.has(i.id)).map((i) => `"${label(i.text)}"`);
  if (changed.length === 0 && gone.length === 0 && pinned.scope === fresh.scope) return "";
  return [
    "Graph changes since the Graph context above (newer — these lines replace the matching ones there):",
    pinned.scope !== fresh.scope ? `Scope now: ${fresh.scope}` : null,
    ...changed,
    gone.length > 0 ? `No longer in the overview (done, archived, deleted or ranked out): ${gone.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The snapshot to send this call: the pinned one plus a delta while that's
// cheaper than re-writing it, otherwise the fresh one (which becomes the pin).
export function pinSnapshot(params: {
  key: string;
  prefixKey: string;
  fresh: Snapshot;
  now?: number;
}): Snapshot & { delta: string; pinned: boolean } {
  const now = params.now ?? Date.now();
  const pin = pins.get(params.key);
  if (pin && pin.prefixKey === params.prefixKey && now - pin.usedAt < AI_ASSISTANT.SNAPSHOT_PIN_TTL_MS) {
    const delta = snapshotDelta(pin, params.fresh);
    if (delta.length <= AI_ASSISTANT.SNAPSHOT_PIN_MAX_DELTA_SHARE * snapshotText(pin.items).length) {
      pin.usedAt = now;
      return { scope: pin.scope, items: pin.items, delta, pinned: true };
    }
  }
  pins.delete(params.key);
  if (pins.size >= MAX_PINS) {
    const oldest = pins.keys().next().value;
    if (oldest !== undefined) pins.delete(oldest);
  }
  pins.set(params.key, { ...params.fresh, prefixKey: params.prefixKey, usedAt: now });
  return { ...params.fresh, delta: "", pinned: false };
}

// Tests only.
export function clearSnapshotPins(): void {
  pins.clear();
}
