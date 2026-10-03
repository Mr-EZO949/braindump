// Inline confirmation card for a paused assistant mutation.
// Renders under the assistant bubble when the chat stream surfaces a
// <<BRAINDUMP_PAUSE>>...<</BRAINDUMP_PAUSE>> marker. Apply/Skip both POST
// to /api/assistant/chat/resume; the streaming response from that endpoint
// is threaded back into the same assistant message by the caller.

import { useMemo } from "react";

import { ChangeChecklist, useChangeSelection } from "@/components/panel/change-checklist";
import { CHANGE_SET_TOOLS, isChangeList, namerFor, type ChangeOpView } from "@/lib/chat/change-describe";
import { describePriorityChange, parsePriorityChanges } from "@/lib/graph/priority-changes";
import type { PendingAction } from "@/types/chat";

interface PendingActionCardProps {
  action: PendingAction;
  disabled: boolean;
  // acceptedIndexes: a change-set card accepted in part — the rows kept.
  onResolve: (decision: "accept" | "reject" | "choice", choice?: string, acceptedIndexes?: number[]) => void;
  // Node id → title, so the card names nodes instead of showing UUIDs.
  nodeTitles?: ReadonlyMap<string, string>;
  // After Apply: puts the applied rows back (action.undo).
  onUndo?: () => void;
}

const TOOL_LABELS: Record<string, { verb: string; noun: string }> = {
  // A change set (tools/change.ts, tools/build.ts): a list of ops.
  change: { verb: "Apply", noun: "changes" },
  build_graph: { verb: "Apply", noun: "changes" },
  // A suggestion the assistant made (source "suggestion") — waits for OK.
  update_priorities: { verb: "Suggested", noun: "priorities" },
  set_commitments: { verb: "Suggested", noun: "weekly times" },
  add_task_to_calendar: { verb: "Schedule", noun: "task" },
  reschedule_task: { verb: "Reschedule", noun: "task" },
  mark_task_done: { verb: "Mark done", noun: "task" },
};


// A suggested direct-tool call, in words: one line per change.
function suggestionLines(action: PendingAction): string[] | null {
  if (action.toolName === "update_priorities") {
    const parsed = parsePriorityChanges(action.toolInput);
    return parsed.ok ? parsed.changes.map(describePriorityChange) : null;
  }
  if (action.toolName === "set_commitments" && Array.isArray(action.toolInput.changes)) {
    return (action.toolInput.changes as Array<Record<string, unknown>>).map((c) => {
      const verb = c.action === "remove" ? "Remove" : c.action === "update" ? "Change" : "Add";
      const days = Array.isArray(c.days) ? ` ${(c.days as unknown[]).join(", ")}` : "";
      const time = typeof c.start_time === "string" ? ` ${c.start_time}${typeof c.end_time === "string" ? `–${c.end_time}` : ""}` : "";
      return `${verb} ${typeof c.title === "string" ? c.title : "a weekly time"}${days}${time}`;
    });
  }
  return null;
}
const EMPTY_OPS: ChangeOpView[] = [];

function labelFor(name: string): { verb: string; noun: string } {
  return TOOL_LABELS[name] ?? { verb: "Run", noun: name };
}

function renderField(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return null; // handled separately for known shapes
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function PendingActionCard({ action, disabled, onResolve, nodeTitles, onUndo }: PendingActionCardProps) {
  // Change-set cards (change, build_graph): every row is the
  // user's own call. Declared before any early return — hooks can't be conditional.
  const changeOps = useMemo(
    () =>
      CHANGE_SET_TOOLS.has(action.toolName) && isChangeList(action.toolInput.changes)
        ? (action.toolInput.changes as ChangeOpView[])
        : EMPTY_OPS,
    [action.toolName, action.toolInput],
  );
  const selection = useChangeSelection(changeOps);

  // ask_choice renders as a forced-choice question rather than an Apply/Skip
  // mutation card. The picked option resumes the loop as the tool result.
  if (action.toolName === "ask_choice") {
    const question =
      typeof action.toolInput.question === "string" ? action.toolInput.question : "Which did you mean?";
    const options = Array.isArray(action.toolInput.options)
      ? (action.toolInput.options as unknown[]).filter((o): o is string => typeof o === "string")
      : [];
    const answered = action.status !== "awaiting";
    return (
      <div className="pending-action-card" role="group" aria-label="Clarifying question">
        <p className="pending-action-question">{question}</p>
        {action.status === "awaiting" ? (
          <div className="pending-action-choices">
            {options.map((opt) => (
              <button
                key={opt}
                className="pending-action-btn pending-action-btn-choice"
                onClick={() => onResolve("choice", opt)}
                disabled={disabled}
                type="button"
              >
                {opt}
              </button>
            ))}
            {/* Malformed options (none usable) must not dead-end the turn —
                always leave a way to dismiss and free the pending run. */}
            {options.length === 0 ? (
              <button
                className="pending-action-btn pending-action-btn-reject"
                onClick={() => onResolve("reject")}
                disabled={disabled}
                type="button"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
        {answered && action.status === "error" ? (
          <div className="pending-action-status pending-action-status-error">
            {action.errorMessage ?? "Could not record your answer."}
          </div>
        ) : answered ? (
          <div className="pending-action-status pending-action-status-accepted">Answered</div>
        ) : null}
      </div>
    );
  }

  const isChangesBatch = CHANGE_SET_TOOLS.has(action.toolName);
  // What the builder wants the user to know before accepting (a new item
  // that looks like an existing one).
  const notes = Array.isArray(action.toolInput.notes)
    ? (action.toolInput.notes as unknown[]).filter((n): n is string => typeof n === "string")
    : [];
  const changes = isChangesBatch && changeOps.length > 0 ? changeOps : null;
  const nameOf = namerFor(changes ?? [], nodeTitles);
  const suggested = suggestionLines(action);
  const { verb, noun } = labelFor(action.toolName);

  const entries =
    isChangesBatch || suggested
      ? [] // these cards render their own lists below
      : Object.entries(action.toolInput)
          .filter(([, value]) => renderField(value) !== null)
          // Ids the graph can name are shown as titles ("node", "parent node").
          .map(([key, value]): [string, unknown] =>
            typeof value === "string" && /_node_id$|^node_id$/.test(key) && nodeTitles?.has(value)
              ? [key.replace(/_id$/, "").replace(/_/g, " "), nodeTitles.get(value)]
              : [key, value],
          );

  const awaiting = action.status === "awaiting";
  const accepted = action.status === "accepted";
  const applying = action.status === "applying";
  const rejected = action.status === "rejected";
  const errored = action.status === "error";

  return (
    <div className="pending-action-card" role="group" aria-label="Proposed assistant action">
      <div className="pending-action-header">
        <span className="pending-action-verb">{verb}</span>
        <span className="pending-action-noun">
          {isChangesBatch && changes ? `${changes.length} ${noun}` : noun}
        </span>
      </div>

      {suggested ? (
        <ul className="pending-action-batch-list">
          {suggested.map((line, idx) => (
            <li className="pending-action-batch-item" key={idx}>
              <span className="pending-action-batch-title">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {isChangesBatch && changes ? (
        <ChangeChecklist
          disabled={disabled}
          keptIndexes={action.acceptedIndexes}
          mode={action.status === "awaiting" ? "choose" : action.status === "rejected" ? "rejected" : "accepted"}
          nameOf={nameOf}
          ops={changes}
          selection={selection}
        />
      ) : null}

      {notes.length > 0 ? (
        <ul className="pending-action-batch-list">
          {notes.map((note, idx) => (
            <li className="pending-action-batch-more" key={idx}>
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {entries.length > 0 ? (
        <div className="pending-action-fields">
          {entries.map(([key, value]) => {
            const rendered = renderField(value);
            if (rendered === null) return null;
            return (
              <div className="pending-action-field" key={key}>
                <span className="pending-action-field-label">{key}</span>
                <span className="pending-action-field-value">{rendered}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {awaiting ? (
        <div className="pending-action-actions">
          {changes ? (
            <button
              className="pending-action-btn pending-action-btn-accept"
              onClick={() =>
                onResolve(
                  "accept",
                  undefined,
                  selection.accepted.length === changes.length ? undefined : selection.accepted,
                )
              }
              disabled={disabled || selection.accepted.length === 0}
              type="button"
            >
              {selection.accepted.length === changes.length
                ? changes.length === 1
                  ? "Apply"
                  : `Apply all ${changes.length}`
                : `Apply ${selection.accepted.length} of ${changes.length}`}
            </button>
          ) : (
            <button
              className="pending-action-btn pending-action-btn-accept"
              onClick={() => onResolve("accept")}
              disabled={disabled}
              type="button"
            >
              Apply
            </button>
          )}
          <button
            className="pending-action-btn pending-action-btn-reject"
            onClick={() => onResolve("reject")}
            disabled={disabled}
            type="button"
          >
            Skip
          </button>
        </div>
      ) : null}

      {applying ? (
        <div className="pending-action-status pending-action-status-busy" role="status">
          Applying…
        </div>
      ) : null}
      {accepted ? (
        <div className="pending-action-status pending-action-status-accepted">
          {/* The same words as the turn card's waiting section. */}
          {action.undoStatus === "undone" ? "Put back" : "Applied"}
          {action.undo && action.undo.length > 0 && onUndo && action.undoStatus !== "undone" ? (
            action.undoStatus === "undoing" ? (
              <span className="applied-card-busy"> · Undoing…</span>
            ) : (
              <button className="applied-card-undo" disabled={disabled} onClick={onUndo} type="button">
                Undo
              </button>
            )
          ) : null}
        </div>
      ) : null}
      {rejected ? (
        <div className="pending-action-status pending-action-status-rejected">Left as it was</div>
      ) : null}
      {errored ? (
        <div className="pending-action-status pending-action-status-error">
          {action.errorMessage ?? "Could not complete the action."}
        </div>
      ) : null}
    </div>
  );
}
