// The rows of a change set, each one the user's own call: tick to keep,
// untick to skip. Used by the chat's confirmation card and by the brain-dump
// turn card ("Needs your OK"), so a change looks and behaves the same
// wherever it was asked for (docs/unified-turn.md).

import { useMemo, useState } from "react";

import { blockedBySkips, previewSelection } from "@/lib/ai/turn-policy";
import type { ChangeOp } from "@/lib/graph/change-set";
import {
  CHANGE_KIND_GLYPH,
  describeChange,
  type ChangeOpView,
  type NameOf,
} from "@/lib/chat/change-describe";

export interface ChangeSelection {
  selected: ReadonlySet<number>;
  // The rows as they would land (a new node whose new parent was unticked
  // shows its new home).
  shown: ChangeOpView[];
  // Ticked rows that can't happen without a row that was skipped (a move
  // under a new project the user unticked).
  blocked: ReadonlySet<number>;
  // What Accept sends: ticked and possible.
  accepted: number[];
  toggle: (index: number) => void;
}

// Every row starts ticked — accepting everything stays one tap.
export function useChangeSelection(ops: ChangeOpView[]): ChangeSelection {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(ops.map((_, i) => i)));
  // Every row starts ticked. A card can render before its rows arrive (the
  // stream, a reload), so when the rows change, tick them all again — before
  // this a late card read "Apply 0 of 1".
  const [seenOps, setSeenOps] = useState(ops);
  if (seenOps !== ops && seenOps.length !== ops.length) {
    setSeenOps(ops);
    setSelected(new Set(ops.map((_, i) => i)));
  }
  const blocked = useMemo(
    () => new Set(blockedBySkips(ops as ChangeOp[], [...selected])),
    [ops, selected],
  );
  const accepted = useMemo(
    () => [...selected].filter((i) => !blocked.has(i)).sort((a, b) => a - b),
    [selected, blocked],
  );
  const shown = useMemo(
    () => previewSelection(ops as ChangeOp[], [...selected]) as ChangeOpView[],
    [ops, selected],
  );
  const toggle = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return { selected, shown, blocked, accepted, toggle };
}

interface ChangeChecklistProps {
  ops: ChangeOpView[];
  nameOf: NameOf;
  // "choose": rows toggle. Afterwards the list shows what was kept.
  mode: "choose" | "accepted" | "rejected";
  selection: ChangeSelection;
  // After an Accept: the rows that were applied (absent → all of them).
  keptIndexes?: readonly number[];
  disabled?: boolean;
}

export function ChangeChecklist({ ops, nameOf, mode, selection, keptIndexes, disabled }: ChangeChecklistProps) {
  const kept = keptIndexes ? new Set(keptIndexes) : null;
  return (
    <ul className="change-list">
      {ops.map((op, index) => {
        const kind = typeof op.kind === "string" ? op.kind : "";
        const glyph = CHANGE_KIND_GLYPH[kind] ?? "•";
        const text = describeChange(mode === "choose" ? (selection.shown[index] ?? op) : op, nameOf);
        if (mode !== "choose") {
          const applied = mode === "accepted" && (!kept || kept.has(index));
          return (
            <li className={`change-row change-row--static${applied ? "" : " change-row--off"}`} key={index}>
              <span className={`change-row-box${applied ? " change-row-box--on" : ""}`} aria-hidden="true">
                {applied ? "✓" : ""}
              </span>
              <span className="change-row-glyph" aria-hidden="true">{glyph}</span>
              <span className="change-row-text">{text}</span>
            </li>
          );
        }
        const isBlocked = selection.blocked.has(index);
        const on = selection.selected.has(index) && !isBlocked;
        return (
          <li key={index}>
            <button
              aria-pressed={on}
              className={`change-row${on ? "" : " change-row--off"}`}
              disabled={disabled || isBlocked}
              onClick={() => selection.toggle(index)}
              title={isBlocked ? "Needs a change you skipped above" : undefined}
              type="button"
            >
              <span className={`change-row-box${on ? " change-row-box--on" : ""}`} aria-hidden="true">
                {on ? "✓" : ""}
              </span>
              <span className="change-row-glyph" aria-hidden="true">{glyph}</span>
              <span className="change-row-text">{text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
