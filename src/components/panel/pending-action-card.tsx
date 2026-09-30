// Inline confirmation card for a paused assistant mutation.
// Renders under the assistant bubble when the chat stream surfaces a
// <<BRAINDUMP_PAUSE>>...<</BRAINDUMP_PAUSE>> marker. Accept/Reject both POST
// to /api/assistant/chat/resume; the streaming response from that endpoint
// is threaded back into the same assistant message by the caller.

import type { PendingAction } from "@/types/chat";

interface PendingActionCardProps {
  action: PendingAction;
  disabled: boolean;
  onResolve: (decision: "accept" | "reject" | "choice", choice?: string) => void;
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

// propose_changes_batch carries a `changes` array of heterogeneous ops.
type ChangeOp = {
  kind?: unknown;
  local_ref?: unknown;
  title?: unknown;
  node_type?: unknown;
  node_id?: unknown;
  parent_node_id?: unknown;
  parent_local_ref?: unknown;
  new_parent_node_id?: unknown;
  new_parent_local_ref?: unknown;
  source_node_id?: unknown;
  target_node_id?: unknown;
  edge_type?: unknown;
};

type NameOf = (ref: unknown) => string;

function isChangeList(value: unknown): value is ChangeOp[] {
  return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null);
}

const CHANGE_KIND_GLYPH: Record<string, string> = {
  create_node: "+",
  move: "↳",
  update: "✎",
  create_edge: "⇄",
  complete: "✓",
  archive: "⌫",
};

const HIERARCHY_EDGE_TYPES = new Set(["belongs_to", "contains"]);

function edgeLabel(edgeType: unknown): string {
  return typeof edgeType === "string" ? edgeType.replace(/_/g, " ") : "linked to";
}

function typeLabel(nodeType: unknown): string {
  return typeof nodeType === "string" ? nodeType.replace(/_/g, " ") : "";
}

// belongs_to / contains are a MOVE: who goes under whom.
function hierarchyEnds(op: {
  edge_type?: unknown;
  source_node_id?: unknown;
  target_node_id?: unknown;
}): { child: unknown; parent: unknown } {
  return op.edge_type === "contains"
    ? { child: op.target_node_id, parent: op.source_node_id }
    : { child: op.source_node_id, parent: op.target_node_id };
}

function describeChange(op: ChangeOp, nameOf: NameOf): string {
  const kind = typeof op.kind === "string" ? op.kind : "";
  switch (kind) {
    case "create_node": {
      const title = typeof op.title === "string" ? op.title : "(untitled)";
      const type = typeLabel(op.node_type);
      const parent = op.parent_node_id ?? op.parent_local_ref;
      return `${title}${type ? ` · ${type}` : ""}${parent ? ` — under ${nameOf(parent)}` : ""}`;
    }
    case "move":
      return `Move ${nameOf(op.node_id)} under ${nameOf(op.new_parent_node_id ?? op.new_parent_local_ref)}`;
    case "update": {
      const parts = [
        typeof op.title === "string" ? `rename to "${op.title}"` : null,
        typeof op.node_type === "string" ? `make it a ${typeLabel(op.node_type)}` : null,
      ].filter(Boolean);
      return `${nameOf(op.node_id)}: ${parts.length > 0 ? parts.join(", ") : "edit"}`;
    }
    case "create_edge": {
      if (typeof op.edge_type === "string" && HIERARCHY_EDGE_TYPES.has(op.edge_type)) {
        const { child, parent } = hierarchyEnds(op);
        return `Move ${nameOf(child)} under ${nameOf(parent)}`;
      }
      return `${nameOf(op.source_node_id)} ${edgeLabel(op.edge_type)} ${nameOf(op.target_node_id)}`;
    }
    case "complete":
      return `Complete ${nameOf(op.node_id)}`;
    case "archive":
      return `Archive ${nameOf(op.node_id)}`;
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

export function PendingActionCard({ action, disabled, onResolve, nodeTitles }: PendingActionCardProps) {
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
  const isChangesBatch =
    action.toolName === "propose_changes_batch" || action.toolName === "build_graph";
  // The list scrolls; a builder plan is shown whole — nobody should accept
  // changes they can't read.
  const changeLimit = action.toolName === "build_graph" ? 40 : 12;
  // What the builder wants the user to know before accepting (a new item
  // that looks like an existing one).
  const notes =
    action.toolName === "build_graph" && Array.isArray(action.toolInput.notes)
      ? (action.toolInput.notes as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
  const batchNodes = isBatch && isBatchNodeList(action.toolInput.nodes)
    ? (action.toolInput.nodes as BatchNode[])
    : null;
  const changes = isChangesBatch && isChangeList(action.toolInput.changes)
    ? (action.toolInput.changes as ChangeOp[])
    : null;

  // A node as the user knows it: its title, or — for a node this same batch
  // creates — the title the batch gives it.
  const localTitles = new Map<string, string>();
  for (const op of changes ?? []) {
    if (op.kind === "create_node" && typeof op.local_ref === "string" && typeof op.title === "string") {
      localTitles.set(op.local_ref, op.title);
    }
  }
  const nameOf: NameOf = (ref) =>
    typeof ref === "string" && ref.length > 0
      ? (localTitles.get(ref) ?? nodeTitles?.get(ref) ?? "a node")
      : "a node";

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
          {changes.slice(0, changeLimit).map((op, idx) => {
            const kind = typeof op.kind === "string" ? op.kind : "";
            const glyph = CHANGE_KIND_GLYPH[kind] ?? "•";
            return (
              <li className="pending-action-batch-item" key={idx}>
                <span className="pending-action-batch-type">{glyph}</span>
                <span className="pending-action-batch-title">{describeChange(op, nameOf)}</span>
              </li>
            );
          })}
          {changes.length > changeLimit ? (
            <li className="pending-action-batch-more">
              +{changes.length - changeLimit} more
            </li>
          ) : null}
        </ul>
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
