// What a chat thread sends back to the server as history, and how a second
// turn card in one reply joins the first (moved out of AppShell, 2026-10-04).

import type { ChatMessage, TurnCardData } from "@/types/chat";

import { appliedActionNote } from "./applied-marker";
import { connectionsNote, turnNote } from "./turn-note";

/**
 * Prior turns for /api/assistant/chat, as plain {role, body} so the server can
 * compress old ones. A card has no text of its own: its note tells the model
 * what changed (or that the user undid it).
 */
export function chatHistoryForModel(
  messages: ChatMessage[],
  nodeTitles: ReadonlyMap<string, string>,
): Array<{ role: ChatMessage["role"]; body: string }> {
  return messages
    .filter((m) => m.status !== "error")
    .map((m) => ({
      role: m.role,
      // A brain dump's card has no text either: its note lists what was
      // added, finished, linked, asked and what still waits (turn-note.ts).
      body: m.connections
        ? connectionsNote(m.connections)
        : m.turn
          ? `${m.body ?? ""}\n\n${turnNote(m, nodeTitles)}`.trim()
          : m.appliedAction
            ? `${m.body ?? ""}\n\n${appliedActionNote(m.appliedAction)}`.trim()
            : (m.body ?? ""),
    }))
    .filter((m) => m.body.trim().length > 0);
}

/** The last few turns a dump typed in chat sends along, so its reply sees the conversation. */
export function dumpHistoryForEntries(messages: ChatMessage[]): Array<{ role: ChatMessage["role"]; body: string }> {
  return messages
    .filter((m) => m.status !== "error" && m.body.trim().length > 0)
    .slice(-6)
    .map((m) => ({ role: m.role, body: m.body.slice(0, 600) }));
}

/** A second change in the same reply: one card, sections joined. */
export function mergeTurnCards(existing: TurnCardData, card: TurnCardData): TurnCardData {
  const undo = existing.undo ?? { added: [], done: [], links: [] };
  return {
    ...existing,
    added: [...existing.added, ...card.added],
    done: [...existing.done, ...card.done],
    links: [...existing.links, ...card.links],
    questions: [...existing.questions, ...card.questions],
    undo: {
      added: [...undo.added, ...(card.undo?.added ?? [])],
      done: [...undo.done, ...(card.undo?.done ?? [])],
      links: [...undo.links, ...(card.undo?.links ?? [])],
    },
  };
}
