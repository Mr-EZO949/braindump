// <<BRAINDUMP_TURN>>…<</BRAINDUMP_TURN>> — what a chat change (the change and
// build_graph tools) applied at once, carried to the browser so the message
// gets the same card a brain dump gets: Added / Marked done / Linked, each
// with an Undo, and the rows that wait shown inside it. Shared by the chat
// route (encode) and the client (parse); no server imports.

import type { DumpTurn, TurnApplied } from "@/types/ai";
import type { TurnCardData } from "@/types/chat";
import { createMarkerParser, type MarkerParser } from "./pause-marker";

const OPEN = "<<BRAINDUMP_TURN>>";
const CLOSE = "<</BRAINDUMP_TURN>>";

export function encodeTurnMarker(turn: TurnApplied): string {
  return `${OPEN}${JSON.stringify(turn)}${CLOSE}`;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Server turn (chat marker, or a dump's `turn`) → card data. */
export function turnCardFromApplied(turn: Partial<TurnApplied | DumpTurn> | null | undefined): TurnCardData | null {
  if (!turn || typeof turn !== "object") return null;
  const undo = turn.undo && typeof turn.undo === "object" ? turn.undo : null;
  return {
    added: list(turn.added).flatMap((raw) => {
      const n = raw as Record<string, unknown>;
      return typeof n?.id === "string"
        ? [
            {
              id: n.id,
              proposalId: typeof n.proposal_id === "string" ? n.proposal_id : null,
              title: text(n.title),
              nodeType: text(n.node_type),
              parentTitle: typeof n.parent_title === "string" ? n.parent_title : null,
            },
          ]
        : [];
    }),
    addedStatus: "applied",
    done: list(turn.done).filter((t): t is string => typeof t === "string"),
    links: list(turn.links).flatMap((raw) => {
      const l = raw as Record<string, unknown>;
      return l && typeof l.source_title === "string" && typeof l.target_title === "string"
        ? [
            {
              sourceTitle: l.source_title,
              targetTitle: l.target_title,
              edgeType: text(l.edge_type),
              ...(l.removed === true ? { removed: true } : {}),
            },
          ]
        : [];
    }),
    ...(undo ? { undo: { added: list(undo.added), done: list(undo.done), links: list(undo.links) } } : {}),
    questions: list(turn.questions)
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => ({ text: q })),
  };
}

function parseTurnPayload(raw: string): TurnCardData | null {
  try {
    return turnCardFromApplied(JSON.parse(raw) as Partial<TurnApplied>);
  } catch {
    return null;
  }
}

export function createTurnMarkerParser(): MarkerParser<TurnCardData> {
  return createMarkerParser({ open: OPEN, close: CLOSE, parse: parseTurnPayload });
}

// ---------------------------------------------------------------------------
// <<BRAINDUMP_UNDO>>…<</BRAINDUMP_UNDO>> — the undo steps for the rows the
// user accepted on a card (sent first by the resume route).
// ---------------------------------------------------------------------------

const UNDO_OPEN = "<<BRAINDUMP_UNDO>>";
const UNDO_CLOSE = "<</BRAINDUMP_UNDO>>";

export function encodeUndoMarker(steps: unknown[]): string {
  return `${UNDO_OPEN}${JSON.stringify(steps)}${UNDO_CLOSE}`;
}

export function createUndoMarkerParser(): MarkerParser<unknown[]> {
  return createMarkerParser({
    open: UNDO_OPEN,
    close: UNDO_CLOSE,
    parse: (raw) => {
      try {
        const steps = JSON.parse(raw) as unknown;
        return Array.isArray(steps) && steps.length > 0 ? steps : null;
      } catch {
        return null;
      }
    },
  });
}
