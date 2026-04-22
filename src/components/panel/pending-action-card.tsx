// Inline confirmation card for a paused assistant mutation.
// Renders under the assistant bubble when the chat stream surfaces a
// <<BRAINDUMP_PAUSE>>...<</BRAINDUMP_PAUSE>> marker. Accept/Reject both POST
// to /api/assistant/chat/resume; the streaming response from that endpoint
// is threaded back into the same assistant message by the caller.

import type { PendingAction } from "@/types/chat";

interface PendingActionCardProps {
  action: PendingAction;
  disabled: boolean;
  onResolve: (decision: "accept" | "reject") => void;
}

const TOOL_LABELS: Record<string, { verb: string; noun: string }> = {
  propose_node: { verb: "Add", noun: "new node" },
  propose_nodes_batch: { verb: "Add", noun: "nodes" },
  propose_edge: { verb: "Connect", noun: "nodes" },
  update_node: { verb: "Edit", noun: "node" },
  archive_node: { verb: "Archive", noun: "node" },
  complete_node: { verb: "Complete", noun: "node" },
  add_task_to_calendar: { verb: "Schedule", noun: "task" },
  reschedule_task: { verb: "Reschedule", noun: "task" },
  mark_task_done: { verb: "Mark done", noun: "task" },
};

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
  const { verb, noun } = labelFor(action.toolName);

  const isBatch = action.toolName === "propose_nodes_batch";
  const batchNodes = isBatch && isBatchNodeList(action.toolInput.nodes)
    ? (action.toolInput.nodes as BatchNode[])
    : null;

  const entries = isBatch
    ? [] // batch card renders its own list below
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
          {isBatch && batchNodes ? `${batchNodes.length} ${noun}` : noun}
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
