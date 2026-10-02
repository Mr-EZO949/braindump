// Inline confirmation card for a paused assistant mutation.
// Renders under the assistant bubble when the chat stream surfaces a
// <<BRAINDUMP_PAUSE>>...<</BRAINDUMP_PAUSE>> marker. Accept/Reject both POST
// to /api/assistant/chat/resume; the streaming response from that endpoint
// is threaded back into the same assistant message by the caller.

import { useMemo } from "react";

import { ChangeChecklist, useChangeSelection } from "@/components/panel/change-checklist";
import {
  edgeLabel,
  hierarchyEnds,
  HIERARCHY_EDGE_TYPES,
  isChangeList,
  namerFor,
  type ChangeOpView,
} from "@/lib/chat/change-describe";
import type { PendingAction } from "@/types/chat";

interface PendingActionCardProps {
  action: PendingAction;
  disabled: boolean;
  // acceptedIndexes: a change-set card accepted in part — the rows kept.
  onResolve: (decision: "accept" | "reject" | "choice", choice?: string, acceptedIndexes?: number[]) => void;
  // Node id → title, so the card names nodes instead of showing UUIDs.
  nodeTitles?: ReadonlyMap<string, string>;
}

const TOOL_LABELS: Record<string, { verb: string; noun: string }> = {
  propose_node: { verb: "Add", noun: "new node" },
  propose_nodes_batch: { verb: "Add", noun: "nodes" },
  propose_changes_batch: { verb: "Apply", noun: "changes" },
  // The graph builder's change set (tools/build.ts) — same list of ops.
  build_graph: { verb: "Apply", noun: "changes" },
  propose_edge: { verb: "Connect", noun: "nodes" },
  propose_merge: { verb: "Merge", noun: "nodes" },
  update_node: { verb: "Edit", noun: "node" },
  archive_node: { verb: "Archive", noun: "node" },
  complete_node: { verb: "Complete", noun: "node" },
  add_task_to_calendar: { verb: "Schedule", noun: "task" },
  reschedule_task: { verb: "Reschedule", noun: "task" },
  mark_task_done: { verb: "Mark done", noun: "task" },
};

const CHANGE_SET_TOOLS = new Set(["propose_changes_batch", "build_graph"]);
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

interface BatchNode {
  title?: unknown;
  node_type?: unknown;
}

function isBatchNodeList(value: unknown): value is BatchNode[] {
  return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null);
}

export function PendingActionCard({ action, disabled, onResolve, nodeTitles }: PendingActionCardProps) {
  // Change-set cards (build_graph, propose_changes_batch): every row is the
  // user's own call. Declared before any early return — hooks can't be conditional.
  const changeOps = useMemo(
    () =>
      CHANGE_SET_TOOLS.has(action.toolName) && isChangeList(action.toolInput.changes)
        ? (action.toolInput.changes as ChangeOpView[])
        : EMPTY_OPS,
    [action.toolName, action.toolInput],
  );
  const selection = useChangeSelection(changeOps);

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

  const isBatch = action.toolName === "propose_nodes_batch";
  const isChangesBatch = CHANGE_SET_TOOLS.has(action.toolName);
  // What the builder wants the user to know before accepting (a new item
  // that looks like an existing one).
  const notes =
    action.toolName === "build_graph" && Array.isArray(action.toolInput.notes)
      ? (action.toolInput.notes as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
  const batchNodes = isBatch && isBatchNodeList(action.toolInput.nodes)
    ? (action.toolInput.nodes as BatchNode[])
    : null;
  const changes = isChangesBatch && changeOps.length > 0 ? changeOps : null;

  const nameOf = namerFor(changes ?? [], nodeTitles);

  // propose_edge with belongs_to / contains moves a node — say so.
  const isEdge = action.toolName === "propose_edge";
  const isMove =
    isEdge &&
    typeof action.toolInput.edge_type === "string" &&
    HIERARCHY_EDGE_TYPES.has(action.toolInput.edge_type);
  const { verb, noun } = isMove ? { verb: "Move", noun: "node" } : labelFor(action.toolName);
  const edgeLine = !isEdge
    ? null
    : isMove
      ? (() => {
          const { child, parent } = hierarchyEnds(action.toolInput);
          return `${nameOf(child)} → under ${nameOf(parent)}`;
        })()
      : `${nameOf(action.toolInput.source_node_id)} ${edgeLabel(action.toolInput.edge_type)} ${nameOf(action.toolInput.target_node_id)}`;

  const entries =
    isBatch || isChangesBatch
      ? [] // batch cards render their own lists below
      : isEdge
        ? Object.entries({ why: action.toolInput.explanation }).filter(
            ([, value]) => renderField(value) !== null,
          )
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

      {edgeLine ? (
        <ul className="pending-action-batch-list">
          <li className="pending-action-batch-item">
            <span className="pending-action-batch-title">{edgeLine}</span>
          </li>
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
                  ? "Accept"
                  : `Accept all ${changes.length}`
                : `Accept ${selection.accepted.length} of ${changes.length}`}
            </button>
          ) : (
            <button
              className="pending-action-btn pending-action-btn-accept"
              onClick={() => onResolve("accept")}
              disabled={disabled}
              type="button"
            >
              Accept
            </button>
          )}
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

      {applying ? (
        <div className="pending-action-status pending-action-status-busy" role="status">
          Applying…
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
