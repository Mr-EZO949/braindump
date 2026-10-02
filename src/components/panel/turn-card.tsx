// What one turn came to — a brain dump or a chat message that changed the
// graph — as ONE card under the assistant's reply (docs/unified-turn.md):
// what was added, finished and linked (each with its own Undo), what matters
// and the week (each with its own Undo), what still needs the user's OK —
// row by row, with an Undo once applied — and anything that has to be asked.
// Before 2026-09-30 a dump's result was spread over a review modal, a toast,
// three separate chat cards and a second modal; before 2026-10-02 a chat
// change was a different card that waited for Accept on everything.

import { useState } from "react";

import { AppliedActionCard } from "@/components/panel/applied-action-card";
import { ChangeChecklist, useChangeSelection } from "@/components/panel/change-checklist";
import { edgeLabel, isChangeList, namerFor, typeLabel, type ChangeOpView } from "@/lib/chat/change-describe";
import type { AppliedAction, PendingAction, TurnAddedStatus, TurnCardData, TurnSection } from "@/types/chat";

interface TurnCardProps {
  turn: TurnCardData;
  // What the dump changed about existing priorities (the message's appliedAction).
  priorities?: AppliedAction;
  // The changes that wait for the user (the message's pendingAction).
  pending?: PendingAction;
  disabled: boolean;
  nodeTitles?: ReadonlyMap<string, string>;
  onUndoSection: (section: TurnSection) => void;
  // Puts back the rows the user accepted (pending.undo).
  onUndoAccepted: () => void;
  onUndoPriorities: () => void;
  onUndoCommitments: () => void;
  onResolve: (decision: "accept" | "reject", acceptedIndexes?: number[]) => void;
  onAnswer: (questionIndex: number, answer: string) => void;
}

const NO_OPS: ChangeOpView[] = [];
// A long list folds; nobody should have to scroll a chat bubble to find Undo.
const ADDED_PREVIEW = 6;

export function TurnCard({
  turn,
  priorities,
  pending,
  disabled,
  nodeTitles,
  onUndoSection,
  onUndoAccepted,
  onUndoPriorities,
  onUndoCommitments,
  onResolve,
  onAnswer,
}: TurnCardProps) {
  const ops = pending && isChangeList(pending.toolInput.changes) ? pending.toolInput.changes : NO_OPS;
  const selection = useChangeSelection(ops);
  const [showAllAdded, setShowAllAdded] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const undone = turn.addedStatus === "undone";
  const canUndo =
    (turn.addedStatus === "applied" || turn.addedStatus === "error") &&
    ((turn.undo?.added.length ?? 0) > 0 || turn.added.some((n) => n.proposalId));
  const added = showAllAdded ? turn.added : turn.added.slice(0, ADDED_PREVIEW);
  const notes =
    pending && Array.isArray(pending.toolInput.notes)
      ? (pending.toolInput.notes as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
  const awaiting = pending?.status === "awaiting";
  // The assistant's own idea (change with source "suggestion").
  const suggested = pending?.toolInput.suggested === true;

  const submitAnswer = (index: number) => {
    const answer = (drafts[index] ?? "").trim();
    if (!answer || disabled) return;
    onAnswer(index, answer);
  };

  return (
    <div className="turn-card" role="group" aria-label="What this changed">
      {turn.added.length > 0 ? (
        <section className={`turn-section${undone ? " turn-section--undone" : ""}`}>
          <div className="applied-card-head">
            <span className="applied-card-mark" aria-hidden="true">{undone ? "↺" : "+"}</span>
            <span className="applied-card-title">
              {undone ? "Removed again" : `Added ${turn.added.length}`}
            </span>
            {canUndo ? (
              <button className="applied-card-undo" onClick={() => onUndoSection("added")} type="button">
                Undo
              </button>
            ) : turn.addedStatus === "undoing" ? (
              <span className="applied-card-busy">Undoing…</span>
            ) : null}
          </div>
          <ul className="turn-list">
            {added.map((node) => (
              <li className="turn-row" key={node.id}>
                <span className="turn-row-name">{node.title}</span>
                <span className="turn-row-detail">
                  {typeLabel(node.nodeType)}
                  {node.parentTitle ? ` · in ${node.parentTitle}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {turn.added.length > ADDED_PREVIEW ? (
            <button className="turn-more" onClick={() => setShowAllAdded((v) => !v)} type="button">
              {showAllAdded ? "Show fewer" : `Show all ${turn.added.length}`}
            </button>
          ) : null}
          {turn.addedStatus === "error" ? (
            <p className="applied-card-note applied-card-note--error">Couldn&apos;t undo that — try again.</p>
          ) : null}
        </section>
      ) : null}

      {turn.done.length > 0 ? (
        <section className={`turn-section${turn.doneStatus === "undone" ? " turn-section--reverted" : ""}`}>
          <div className="applied-card-head">
            <span className="applied-card-mark" aria-hidden="true">{turn.doneStatus === "undone" ? "↺" : "✓"}</span>
            <span className="applied-card-title">{turn.doneStatus === "undone" ? "Open again" : "Marked done"}</span>
            <SectionUndo
              count={turn.undo?.done.length ?? 0}
              onUndo={() => onUndoSection("done")}
              status={turn.doneStatus}
            />
          </div>
          <ul className="turn-list">
            {turn.done.map((title) => (
              <li className="turn-row" key={title}>
                <span className={`turn-row-name${turn.doneStatus === "undone" ? "" : " turn-row-name--done"}`}>{title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {turn.links.length > 0 ? (
        <section
          className={`turn-section${
            turn.linksStatus === "undone"
              ? turn.links.every((l) => l.removed)
                ? " turn-section--reverted"
                : " turn-section--undone"
              : ""
          }`}
        >
          <div className="applied-card-head">
            <span className="applied-card-mark" aria-hidden="true">{turn.linksStatus === "undone" ? "↺" : "⇄"}</span>
            <span className="applied-card-title">
              {turn.linksStatus === "undone"
                ? "Put back"
                : turn.links.every((l) => l.removed)
                  ? "Unlinked"
                  : "Linked"}
            </span>
            <SectionUndo
              count={turn.undo?.links.length ?? 0}
              onUndo={() => onUndoSection("links")}
              status={turn.linksStatus}
            />
          </div>
          <ul className="turn-list">
            {turn.links.map((link, index) => (
              <li className="turn-row" key={index}>
                <span className={`turn-row-name${link.removed ? " turn-row-name--done" : ""}`}>{link.sourceTitle}</span>
                <span className="turn-row-detail">
                  {link.removed ? "no longer linked to" : edgeLabel(link.edgeType)} {link.targetTitle}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {priorities ? (
        <section className="turn-section">
          <AppliedActionCard action={priorities} embedded heading="What matters" onUndo={onUndoPriorities} />
        </section>
      ) : null}

      {turn.commitments ? (
        <section className="turn-section">
          <AppliedActionCard action={turn.commitments} embedded heading="Your week" onUndo={onUndoCommitments} />
        </section>
      ) : null}

      {pending && ops.length > 0 ? (
        <section className={`turn-section${pending.undoStatus === "undone" ? " turn-section--reverted" : ""}`}>
          <div className="applied-card-head">
            {pending.status === "accepted" || pending.status === "applying" ? (
              <span className="applied-card-mark" aria-hidden="true">✓</span>
            ) : (
              <span className="applied-card-mark applied-card-mark--ask" aria-hidden="true">?</span>
            )}
            <span className="applied-card-title">
              {awaiting
                ? `${suggested ? "Suggested" : "Needs your OK"} · ${ops.length}`
                : pending.status === "applying"
                  ? "Applying…"
                  : pending.status === "rejected"
                  ? "Left as it was"
                  : pending.status === "error"
                    ? "Needs your OK"
                    : pending.undoStatus === "undone"
                      ? "Put back"
                      : "Applied"}
            </span>
            {pending.status === "accepted" ? (
              <SectionUndo count={pending.undo?.length ?? 0} onUndo={onUndoAccepted} status={pending.undoStatus} />
            ) : null}
          </div>
          <ChangeChecklist
            disabled={disabled}
            keptIndexes={pending.acceptedIndexes}
            mode={awaiting || pending.status === "error" ? "choose" : pending.status === "rejected" ? "rejected" : "accepted"}
            nameOf={namerFor(ops, nodeTitles)}
            ops={ops}
            selection={selection}
          />
          {notes.map((note, index) => (
            <p className="applied-card-note" key={index}>{note}</p>
          ))}
          {awaiting ? (
            <div className="pending-action-actions">
              <button
                className="pending-action-btn pending-action-btn-accept"
                disabled={disabled || selection.accepted.length === 0}
                onClick={() =>
                  onResolve("accept", selection.accepted.length === ops.length ? undefined : selection.accepted)
                }
                type="button"
              >
                {selection.accepted.length === ops.length
                  ? ops.length === 1
                    ? "Apply"
                    : `Apply all ${ops.length}`
                  : `Apply ${selection.accepted.length} of ${ops.length}`}
              </button>
              <button
                className="pending-action-btn pending-action-btn-reject"
                disabled={disabled}
                onClick={() => onResolve("reject")}
                type="button"
              >
                Skip
              </button>
            </div>
          ) : null}
          {pending.status === "error" ? (
            <p className="applied-card-note applied-card-note--error">
              {pending.errorMessage ?? "Could not apply that. Try again."}
            </p>
          ) : null}
        </section>
      ) : null}

      {turn.questions.length > 0 ? (
        <section className="turn-section">
          <ul className="turn-questions">
            {turn.questions.map((question, index) => (
              <li className="turn-question" key={index}>
                <span className="turn-question-text">{question.text}</span>
                {question.answer ? (
                  <span className="prn-question-answer">
                    <span className="prn-question-answer-arrow" aria-hidden="true">→</span>
                    {question.answer}
                  </span>
                ) : (
                  <div className="prn-question-replyrow">
                    <input
                      className="prn-question-input"
                      disabled={disabled}
                      maxLength={400}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [index]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitAnswer(index);
                        }
                      }}
                      placeholder="answer here…"
                      type="text"
                      value={drafts[index] ?? ""}
                    />
                    <button
                      aria-label="Send answer"
                      className="prn-question-send"
                      disabled={disabled || !(drafts[index] ?? "").trim()}
                      onClick={() => submitAnswer(index)}
                      type="button"
                    >
                      ↵
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// The Undo on one applied section — only while there is something to undo.
function SectionUndo({
  count,
  status,
  onUndo,
}: {
  count: number;
  status?: TurnAddedStatus;
  onUndo: () => void;
}) {
  if (count === 0 || status === "undone") return null;
  if (status === "undoing") return <span className="applied-card-busy">Undoing…</span>;
  return (
    <button className="applied-card-undo" onClick={onUndo} type="button">
      {status === "error" ? "Undo failed — retry" : "Undo"}
    </button>
  );
}

// Is there anything for the card to show?
export function turnHasCard(turn: TurnCardData, priorities?: AppliedAction, pending?: PendingAction): boolean {
  return (
    turn.added.length > 0 ||
    turn.done.length > 0 ||
    turn.links.length > 0 ||
    turn.questions.length > 0 ||
    !!turn.commitments ||
    !!priorities ||
    !!pending
  );
}
