// What a turn changed (a brain dump, or a chat change), in plain words, for
// the chat model.
//
// A turn's result is a card, and history goes to the model as text — without
// this the next turn would see only the reply sentence and could not follow
// "no, put the second one under Thesis" or "yes, make that a task". The note
// lists what was added, finished, linked, what still waits for the user and
// what was asked (docs/unified-turn.md, "the thread remembers").

import type { ChatMessage, ConnectionsCardData } from "@/types/chat";

import { appliedActionNote } from "./applied-marker";
import { describeChange, edgeLabel, isChangeList, namerFor, typeLabel } from "./change-describe";

const MAX_LISTED = 14;

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join("; ");
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown;
}

export function turnNote(
  message: Pick<ChatMessage, "turn" | "appliedAction" | "pendingAction">,
  nodeTitles?: ReadonlyMap<string, string>,
): string {
  const turn = message.turn;
  if (!turn) return "";
  const lines: string[] = [];

  if (turn.added.length > 0) {
    const items = turn.added.map(
      (n) => `"${n.title}" (${typeLabel(n.nodeType)}${n.parentTitle ? `, under ${n.parentTitle}` : ""})`,
    );
    lines.push(
      turn.addedStatus === "undone"
        ? `Added, then UNDONE by the user — these no longer exist: ${listed(items)}`
        : `Added to the graph: ${listed(items)}`,
    );
  }
  if (turn.done.length > 0) {
    lines.push(
      turn.doneStatus === "undone"
        ? `Marked done, then UNDONE by the user — open again: ${listed(turn.done)}`
        : `Marked done: ${listed(turn.done)}`,
    );
  }
  if (turn.links.length > 0) {
    const words = turn.links.map((l) =>
      l.removed ? `${l.sourceTitle} no longer linked to ${l.targetTitle}` : `${l.sourceTitle} ${edgeLabel(l.edgeType)} ${l.targetTitle}`,
    );
    lines.push(
      turn.linksStatus === "undone" ? `Link changes UNDONE by the user: ${listed(words)}` : `Links: ${listed(words)}`,
    );
  }
  if (message.appliedAction) lines.push(appliedActionNote(message.appliedAction).replace(/^\[|\]$/g, ""));
  if (turn.commitments) lines.push(appliedActionNote(turn.commitments).replace(/^\[|\]$/g, ""));

  const pending = message.pendingAction;
  const ops = pending && isChangeList(pending.toolInput.changes) ? pending.toolInput.changes : [];
  if (pending && ops.length > 0) {
    const nameOf = namerFor(ops, nodeTitles);
    const words = ops.map((op) => describeChange(op, nameOf));
    if (pending.status === "awaiting") {
      lines.push(`Proposed, still waiting for the user's OK on the card (NOT applied yet): ${listed(words)}`);
    } else if (pending.status === "rejected") {
      lines.push(`Proposed and DECLINED by the user: ${listed(words)}`);
    } else if (pending.status === "accepted" || pending.status === "applying") {
      const kept = pending.acceptedIndexes ? new Set(pending.acceptedIndexes) : null;
      const accepted = words.filter((_, i) => !kept || kept.has(i));
      const skipped = kept ? words.filter((_, i) => !kept.has(i)) : [];
      if (accepted.length > 0) {
        lines.push(
          pending.undoStatus === "undone"
            ? `Accepted, then UNDONE by the user — back as before: ${listed(accepted)}`
            : `Accepted by the user and applied: ${listed(accepted)}`,
        );
      }
      if (skipped.length > 0) lines.push(`Skipped by the user: ${listed(skipped)}`);
    }
  }

  for (const q of turn.questions) {
    lines.push(q.answer ? `Asked: "${q.text}" — the user answered: "${q.answer}"` : `Asked the user: "${q.text}"`);
  }

  if (lines.length === 0) return "";
  return `[What this changed — the user saw it as a card under this reply.\n${lines.map((l) => `- ${l}`).join("\n")}]`;
}

// The links card, for the chat model: what was suggested and what the user did.
export function connectionsNote(card: ConnectionsCardData): string {
  const words = (ids?: Set<string>) =>
    card.edges
      .filter((e) => !ids || ids.has(e.id))
      .map((e) => `${e.sourceTitle} ${edgeLabel(e.edgeType)} ${e.targetTitle}`);
  if (card.status === "added") {
    return `[Links suggested after the dump — the user added: ${listed(words(new Set(card.acceptedIds ?? [])))}]`;
  }
  if (card.status === "dismissed") return `[Links suggested after the dump, dismissed by the user: ${listed(words())}]`;
  return `[Links suggested after the dump, not answered yet: ${listed(words())}]`;
}
