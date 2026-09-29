// <<BRAINDUMP_APPLIED>>…<</BRAINDUMP_APPLIED>> — a chat change that was applied
// straight away (update_priorities), carried to the browser so it can show the
// change with an Undo. Shared by the chat routes (encode) and the client
// (parse); no server imports.

import type { AppliedAction, AppliedActionItem } from "@/types/chat";
import { createMarkerParser, type MarkerParser } from "./pause-marker";

const OPEN = "<<BRAINDUMP_APPLIED>>";
const CLOSE = "<</BRAINDUMP_APPLIED>>";

/** What the server sends — snake_case, straight from the tool result. */
export interface AppliedMarkerPayload {
  tool_name: string;
  applied: {
    node_id: string;
    title: string;
    action: string;
    detail: string;
    score_before: number | null;
    score_after: number | null;
  }[];
  failed: { title: string; action: string; error: string }[];
  undo: unknown;
}

export function encodeAppliedMarker(payload: AppliedMarkerPayload): string {
  return `${OPEN}${JSON.stringify(payload)}${CLOSE}`;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseAppliedPayload(raw: string): Omit<AppliedAction, "status"> | null {
  try {
    return appliedActionFromPayload(JSON.parse(raw) as Partial<AppliedMarkerPayload>);
  } catch {
    return null;
  }
}

/** Server payload (chat marker, or a dump's priority_update) → card data. */
export function appliedActionFromPayload(
  parsed: Partial<AppliedMarkerPayload> | null | undefined,
): Omit<AppliedAction, "status"> | null {
  try {
    if (!parsed || typeof parsed.tool_name !== "string" || !Array.isArray(parsed.applied)) return null;
    const items: AppliedActionItem[] = parsed.applied
      .filter((row) => row && typeof row.node_id === "string")
      .map((row) => ({
        nodeId: row.node_id,
        title: text(row.title),
        action: text(row.action),
        detail: text(row.detail),
        scoreBefore: num(row.score_before),
        scoreAfter: num(row.score_after),
      }));
    if (items.length === 0) return null;
    const failed = Array.isArray(parsed.failed)
      ? parsed.failed.map((row) => ({ title: text(row?.title), action: text(row?.action), error: text(row?.error) }))
      : [];
    return { toolName: parsed.tool_name, items, failed, undo: parsed.undo ?? null };
  } catch {
    return null;
  }
}

export function createAppliedMarkerParser(): MarkerParser<Omit<AppliedAction, "status">> {
  return createMarkerParser({ open: OPEN, close: CLOSE, parse: parseAppliedPayload });
}

/**
 * The applied change in words, appended to the assistant turn when the thread
 * goes back to the model — history is plain text, and the model must know
 * what already happened (and whether the user undid it).
 */
export function appliedActionNote(action: AppliedAction): string {
  const list = action.items.map((item) => `${item.title} — ${item.detail}`).join("; ");
  const what = isCommitmentAction(action) ? "Fixed commitments" : "Priorities";
  // After an Undo the model kept stating the undone facts ("still on for
  // Friday", e2e 2026-09-29) — say outright that they no longer apply.
  return action.status === "undone"
    ? `[The user UNDID these changes — they no longer apply; the Graph context shows the current state: ${list}]`
    : `[${what} updated: ${list}]`;
}

/** set_commitments cards: a schedule change, not a priority change. */
export function isCommitmentAction(action: Pick<AppliedAction, "toolName">): boolean {
  return action.toolName === "set_commitments";
}

/** Where an applied card's Undo goes. */
export function appliedUndoEndpoint(action: Pick<AppliedAction, "toolName">): string {
  return isCommitmentAction(action) ? "/api/assistant/commitments/undo" : "/api/assistant/priorities/undo";
}
