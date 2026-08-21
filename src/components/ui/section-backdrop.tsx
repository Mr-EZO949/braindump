// Big, angled, low-contrast line illustration behind the list-style views
// (Lists / Habits / Roadmap / Pomodoro). Purely decorative — it mirrors the
// login scene's treatment: part of the background, angled, faded at the edges,
// never screaming. One glyph per section so each mode reads as its own place.
//
// A single icon stretched across the whole screen, scaled down at tablet /
// mobile widths. All visual tuning (scale, rotation, ink colour, edge fade,
// responsive sizing) lives in globals.css under `.section-backdrop`; this file
// only owns the geometry.
//
// Glyphs are drawn on a 24×24 grid (Lucide-compatible geometry) and blown up by
// CSS. `vector-effect: non-scaling-stroke` keeps the strokes hairline no matter
// how large the icon is scaled.

import type { ReactNode } from "react";

export type SectionBackdropKind = "todos" | "habits" | "roadmap" | "pomodoro";

// Each glyph is a fragment of stroke-only primitives on the 0 0 24 24 canvas.
const GLYPHS: Record<SectionBackdropKind, ReactNode> = {
  // Lists — a clipboard: one bounding shape (so it holds together at full-screen
  // scale) framing a couple of ruled rows.
  todos: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </>
  ),
  // Habits — a streak flame.
  habits: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
  // Roadmap — a winding route between two milestones.
  roadmap: (
    <>
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <circle cx="18" cy="5" r="3" />
    </>
  ),
  // Pomodoro — a timer: top stem, hand, and dial.
  pomodoro: (
    <>
      <path d="M10 2h4" />
      <path d="M12 14 15 11" />
      <circle cx="12" cy="14" r="8" />
    </>
  ),
};

function Glyph({ kind, side }: { kind: SectionBackdropKind; side?: "left" | "right" }) {
  return (
    <svg
      className="section-backdrop-glyph"
      data-side={side}
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid meet"
    >
      {GLYPHS[kind]}
    </svg>
  );
}

export function SectionBackdrop({ kind }: { kind: SectionBackdropKind }) {
  // Pomodoro's controls live in a centred card, so a single full-screen glyph
  // would sit behind it. It keeps the earlier layout: two glyphs staggered in
  // the side gutters. The other sections use one icon stretched across.
  return (
    <div className="section-backdrop" data-kind={kind} aria-hidden="true">
      {kind === "pomodoro" ? (
        <>
          <Glyph kind={kind} side="left" />
          <Glyph kind={kind} side="right" />
        </>
      ) : (
        <Glyph kind={kind} />
      )}
    </div>
  );
}
