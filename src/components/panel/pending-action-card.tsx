// Inline confirmation card for a paused assistant mutation.
// Renders under the assistant bubble when the chat stream surfaces a
// <<BRAINDUMP_PAUSE>>...<</BRAINDUMP_PAUSE>> marker. Accept/Reject both POST
// to /api/assistant/chat/resume; the streaming response from that endpoint
// is threaded back into the same assistant message by the caller.

import {
  describePriorityChange,
  parsePriorityChanges,
  PRIORITY_ACTION_GLYPH,
} from "@/lib/graph/priority-changes";
import type { PendingAction } from "@/types/chat";

interface PendingActionCardProps {
  action: PendingAction;
  disabled: boolean;
  onResolve: (decision: "accept" | "reject" | "choice", choice?: string) => void;
}

const TOOL_LABELS: Record<string, { verb: string; noun: string }> = {
  propose_node: { verb: "Add", noun: "new node" },
  propose_nodes_batch: { verb: "Add", noun: "nodes" },
  propose_changes_batch: { verb: "Apply", noun: "changes" },
  propose_edge: { verb: "Connect", noun: "nodes" },
  propose_merge: { verb: "Merge", noun: "nodes" },
  update_node: { verb: "Edit", noun: "node" },
  update_priorities: { verb: "Update", noun: "priorities" },
  archive_node: { verb: "Archive", noun: "node" },
  complete_node: { verb: "Complete", noun: "node" },
  add_task_to_calendar: { verb: "Schedule", noun: "task" },
  reschedule_task: { verb: "Reschedule", noun: "task" },
  mark_task_done: { verb: "Mark done", noun: "task" },
};

// propose_changes_batch carries a `changes` array of heterogeneous ops.
type ChangeOp = {
  kind?: unknown;
  title?: unknown;
  node_type?: unknown;
  node_id?: unknown;
  source_node_id?: unknown;
  target_node_id?: unknown;
  edge_type?: unknown;
};

function isChangeList(value: unknown): value is ChangeOp[] {
  return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null);
}

const CHANGE_KIND_GLYPH: Record<string, string> = {
  create_node: "+",
  create_edge: "⇄",
  complete: "✓",
  archive: "⌫",
};

function shortId(value: unknown): string {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : "node";
}

function describeChange(op: ChangeOp): string {
  const kind = typeof op.kind === "string" ? op.kind : "";
  switch (kind) {
    case "create_node": {
      const title = typeof op.title === "string" ? op.title : "(untitled)";
      const type = typeof op.node_type === "string" ? ` · ${op.node_type}` : "";
      return `${title}${type}`;
    }
    case "create_edge": {
      const type = typeof op.edge_type === "string" ? op.edge_type : "edge";
      return `${shortId(op.source_node_id)} → ${shortId(op.target_node_id)} · ${type}`;
    }
    case "complete":
      return `complete ${shortId(op.node_id)}`;
    case "archive":
      return `archive ${shortId(op.node_id)}`;
    default:
      return kind || "(unknown)";
  }
}

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

interface BatchNode {
  title?: unknown;
  node_type?: unknown;
}

function isBatchNodeList(value: unknown): value is BatchNode[] {
  return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null);
}

export function PendingActionCard({ action, disabled, onResolve }: PendingActionCardProps) {
  // ask_choice renders as a forced-choice question rather than an Accept/Reject
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

  const { verb, noun } = labelFor(action.toolName);

  const isBatch = action.toolName === "propose_nodes_batch";
  const isChangesBatch = action.toolName === "propose_changes_batch";
  const priorityParse =
    action.toolName === "update_priorities" ? parsePriorityChanges(action.toolInput) : null;
  const priorityChanges = priorityParse?.ok ? priorityParse.changes : null;
  const batchNodes = isBatch && isBatchNodeList(action.toolInput.nodes)
    ? (action.toolInput.nodes as BatchNode[])
    : null;
  const changes = isChangesBatch && isChangeList(action.toolInput.changes)
    ? (action.toolInput.changes as ChangeOp[])
    : null;

  const entries =
    isBatch || isChangesBatch || priorityChanges
      ? [] // batch cards render their own lists below
      : Object.entries(action.toolInput).filter(
          ([, value]) => renderField(value) !== null,
        );

  const awaiting = action.status === "awaiting";
  const accepted = action.status === "accepted";
  const rejected = action.status === "rejected";
  const errored = action.status === "error";

  return (
    <div className="pending-action-card" role="group" aria-label="Proposed assistant action">
      <div className="pending-action-header">
        <span className="pending-action-verb">{verb}</span>
        <span className="pending-action-noun">
          {isBatch && batchNodes
            ? `${batchNodes.length} ${noun}`
            : isChangesBatch && changes
              ? `${changes.length} ${noun}`
              : noun}
        </span>
      </div>

      {isBatch && batchNodes ? (
        <ul className="pending-action-batch-list">
          {batchNodes.slice(0, 12).map((node, idx) => {
            const title = typeof node.title === "string" ? node.title : "(untitled)";
            const type = typeof node.node_type === "string" ? node.node_type : "";
            return (
              <li className="pending-action-batch-item" key={idx}>
                <span className="pending-action-batch-title">{title}</span>
                {type ? (
                  <span className="pending-action-batch-type">{type}</span>
                ) : null}
              </li>
            );
          })}
          {batchNodes.length > 12 ? (
            <li className="pending-action-batch-more">
              +{batchNodes.length - 12} more
            </li>
          ) : null}
        </ul>
      ) : null}

      {isChangesBatch && changes ? (
        <ul className="pending-action-batch-list">
          {changes.slice(0, 12).map((op, idx) => {
            const kind = typeof op.kind === "string" ? op.kind : "";
            const glyph = CHANGE_KIND_GLYPH[kind] ?? "•";
            return (
              <li className="pending-action-batch-item" key={idx}>
                <span className="pending-action-batch-type">{glyph}</span>
                <span className="pending-action-batch-title">{describeChange(op)}</span>
              </li>
            );
          })}
          {changes.length > 12 ? (
            <li className="pending-action-batch-more">
              +{changes.length - 12} more
            </li>
          ) : null}
        </ul>
      ) : null}

      {priorityChanges ? (
        <ul className="pending-action-batch-list">
          {priorityChanges.map((change, idx) => (
            <li className="pending-action-batch-item" key={idx}>
              <span className="pending-action-batch-type">{PRIORITY_ACTION_GLYPH[change.action]}</span>
              <span className="pending-action-batch-title">{describePriorityChange(change)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!isBatch && entries.length > 0 ? (
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
          <button
            className="pending-action-btn pending-action-btn-accept"
            onClick={() => onResolve("accept")}
            disabled={disabled}
            type="button"
          >
            Accept
          </button>
          <button
            className="pending-action-btn pending-action-btn-reject"
            onClick={() => onResolve("reject")}
            disabled={disabled}
            type="button"
          >
            Reject
          </button>
        </div>
      ) : null}

      {accepted ? (
        <div className="pending-action-status pending-action-status-accepted">Accepted</div>
      ) : null}
      {rejected ? (
        <div className="pending-action-status pending-action-status-rejected">Declined</div>
      ) : null}
      {errored ? (
        <div className="pending-action-status pending-action-status-error">
          {action.errorMessage ?? "Could not complete the action."}
        </div>
      ) : null}
    </div>
  );
}
