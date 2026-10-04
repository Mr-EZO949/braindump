"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { EdgeRelationOptionId } from "@/lib/graph/relationships";
import { ChevronDownIcon, CloseIcon } from "@/components/ui/icons";
import { guessNodeType } from "@/lib/graph/guess-node-type";
import { getImportanceLabel } from "@/lib/graph/importance";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";
import { NODE_FAMILY_LABEL, NODE_TYPE_INFO, NODE_TYPES } from "@/lib/graph/node-types";
import type { CreateNodeInput } from "@/types/graph";

type SharedNodeSheetProps = {
  connectionDeleteSubmittingId?: string | null;
  connectionError?: string | null;
  connectionRelationId?: EdgeRelationOptionId;
  connectionSubmitting?: boolean;
  connectionTargetId?: string;
  connectionTargetOptions?: Array<{
    id: string;
    node_type: string;
    title: string;
  }>;
  connectionTypeOptions?: Array<{
    description: string;
    id: EdgeRelationOptionId;
    label: string;
  }>;
  connectionUpdateSubmittingId?: string | null;
  connections?: Array<{
    edgeId: string;
    nodeId: string;
    nodeType: string;
    relationId: EdgeRelationOptionId;
    title: string;
  }>;
  deleteDescendantCount?: number;
  deleteEdgeCount?: number;
  deleteNodeCount?: number;
  dangerConfirmOpen?: boolean;
  deleteSubmitting?: boolean;
  draft: CreateNodeInput | null;
  error: string | null;
  mode: "create" | "edit";
  onCancelDelete?: () => void;
  onChangeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onChangeNewConnectionRelation?: (relationId: EdgeRelationOptionId) => void;
  onChangeNewConnectionTarget?: (nodeId: string) => void;
  onClose: () => void;
  onConfirmDelete?: () => void;
  onCreateConnection?: () => void;
  onDeleteConnection?: (edgeId: string) => void;
  onRequestDelete?: () => void;
  onResetManualWeight?: () => void;
  onSubmit: () => void;
  onUpdateConnection?: (edgeId: string, relationId: EdgeRelationOptionId) => void;
  // Create sheet: where the new node can go (containers in this workspace).
  parentOptions?: ParentOption[];
  showRawText?: boolean;
  submitting: boolean;
};

export type ParentOption = {
  id: string;
  node_type: string;
  title: string;
};

type CreateNodeSheetProps = {
  draft: CreateNodeInput | null;
  error: string | null;
  onChangeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onClose: () => void;
  onSubmit: () => void;
  parentOptions?: ParentOption[];
  submitting: boolean;
};

type EditNodeSheetProps = {
  connectionDeleteSubmittingId: string | null;
  connectionError: string | null;
  connectionRelationId: EdgeRelationOptionId;
  connectionSubmitting: boolean;
  connectionTargetId: string;
  connectionTargetOptions: Array<{
    id: string;
    node_type: string;
    title: string;
  }>;
  connectionTypeOptions: Array<{
    description: string;
    id: EdgeRelationOptionId;
    label: string;
  }>;
  connectionUpdateSubmittingId: string | null;
  connections: Array<{
    edgeId: string;
    nodeId: string;
    nodeType: string;
    relationId: EdgeRelationOptionId;
    title: string;
  }>;
  deleteDescendantCount: number;
  deleteEdgeCount: number;
  deleteNodeCount: number;
  deleteConfirmOpen: boolean;
  deleteSubmitting: boolean;
  draft: CreateNodeInput | null;
  error: string | null;
  onCancelDelete: () => void;
  onChangeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onChangeNewConnectionRelation: (relationId: EdgeRelationOptionId) => void;
  onChangeNewConnectionTarget: (nodeId: string) => void;
  onClose: () => void;
  onConfirmDelete: () => void;
  onCreateConnection: () => void;
  onDeleteConnection: (edgeId: string) => void;
  onRequestDelete: () => void;
  onResetManualWeight: () => void;
  onSubmit: () => void;
  onUpdateConnection: (edgeId: string, relationId: EdgeRelationOptionId) => void;
  submitting: boolean;
};

// The nine node types, grouped by family, each described by the one question
// it answers (src/lib/graph/node-types.ts, docs/node-types.md).
const presetTypes = NODE_TYPES.map((value) => ({
  value,
  label: NODE_TYPE_INFO[value].label,
  description: NODE_TYPE_INFO[value].question,
  family: NODE_TYPE_INFO[value].family,
}));

const presetFamilies = (["direction", "work", "structure", "thinking"] as const).map((family) => ({
  family,
  label: NODE_FAMILY_LABEL[family],
  types: presetTypes.filter((item) => item.family === family),
}));

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getResolvedType(draft: CreateNodeInput) {
  if (draft.node_type === "custom") {
    return draft.custom_type.trim() || "Custom type";
  }

  const preset = presetTypes.find((item) => item.value === draft.node_type);

  return preset?.label ?? draft.node_type;
}

function getPreviewWidth(importanceIndex: number) {
  return clamp(154 + importanceIndex * 0.98, 156, 254);
}

function getPreviewHeight(importanceIndex: number) {
  return clamp(72 + importanceIndex * 0.34, 74, 118);
}

function SharedNodeSheet({
  connectionDeleteSubmittingId = null,
  connectionError = null,
  connectionRelationId = "contains",
  connectionSubmitting = false,
  connectionTargetId = "",
  connectionTargetOptions = [],
  connectionTypeOptions = [],
  connectionUpdateSubmittingId = null,
  connections = [],
  deleteDescendantCount = 0,
  deleteEdgeCount = 0,
  deleteNodeCount = 1,
  dangerConfirmOpen = false,
  deleteSubmitting = false,
  draft,
  error,
  mode,
  onCancelDelete,
  onChangeField,
  onChangeNewConnectionRelation,
  onChangeNewConnectionTarget,
  onClose,
  onConfirmDelete,
  onCreateConnection,
  onDeleteConnection,
  onRequestDelete,
  onResetManualWeight,
  onSubmit,
  onUpdateConnection,
  parentOptions = [],
  showRawText = true,
  submitting,
}: SharedNodeSheetProps) {
  const isCreate = mode === "create";
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  // Create: the type follows the title (guessNodeType) until the user picks
  // one; everything past title + type + parent folds under "More details".
  // CreateNodeSheet mounts this fresh per open, so both reset on their own.
  const [typeTouched, setTypeTouched] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [connectionDraftOverrides, setConnectionDraftOverrides] = useState<
    Record<string, EdgeRelationOptionId>
  >({});
  const open = Boolean(draft);
  const safeDraft: CreateNodeInput = draft ?? {
    custom_type: "",
    importance_index: 58,
    manual_weight: null,
    node_type: "task",
    raw_text: "",
    summary: "",
    body: "",
    title: "",
    target_date: "",
  };

  const handleClose = useCallback(() => {
    setTypeMenuOpen(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (dangerConfirmOpen && onCancelDelete) {
          onCancelDelete();
          return;
        }
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dangerConfirmOpen, handleClose, onCancelDelete, open]);

  const resolvedTypeLabel = getResolvedType(safeDraft);
  const importanceLabel = getImportanceLabel(safeDraft.importance_index);
  const previewAccent =
    safeDraft.node_type === "custom"
      ? "rgba(223,214,204,0.9)"
      : NODE_COLOR_BY_TYPE[safeDraft.node_type];
  const previewWidth = getPreviewWidth(safeDraft.importance_index);
  const previewHeight = getPreviewHeight(safeDraft.importance_index);
  const taskPreview = safeDraft.node_type === "task" || safeDraft.node_type === "big_task";
  const sliderProgress = `${safeDraft.importance_index}%`;
  const title = mode === "create" ? "Create node" : "Edit node";
  const kicker = mode === "create" ? "New Thought" : "Selected Thought";
  const copy =
    mode === "create"
      ? "Introduce a new thought into this workspace without leaving the graph."
      : "Adjust the node without breaking the flow of the graph around it.";
  const primaryActionLabel =
    mode === "create"
      ? submitting
        ? "Creating..."
        : "Create node"
      : submitting
        ? "Saving..."
        : "Save changes";

  const activeTypeDescription = useMemo(
    () =>
      presetTypes.find((item) => item.value === safeDraft.node_type)?.description ??
      "Use a custom label for this node.",
    [safeDraft.node_type],
  );

  if (!open) {
    return null;
  }

  const canSubmit = !submitting && !deleteSubmitting && safeDraft.title.trim().length > 0;

  const handleTitleChange = (value: string) => {
    onChangeField("title", value);
    if (isCreate && !typeTouched) {
      onChangeField("node_type", guessNodeType(value));
      onChangeField("custom_type", "");
    }
  };

  // Create sheet: Enter creates. Shift+Enter and IME composition don't.
  const handleTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!isCreate || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (canSubmit) onSubmit();
  };

  const pickType = (value: (typeof presetTypes)[number]["value"]) => {
    onChangeField("node_type", value);
    onChangeField("custom_type", "");
    setTypeTouched(true);
    setTypeMenuOpen(false);
  };

  const typeGuessed = isCreate && !typeTouched && safeDraft.title.trim().length > 0;

  return (
    <div aria-hidden={false} className="graph-create-overlay graph-create-overlay-open">
      <button
        aria-label={`Close ${mode === "create" ? "create" : "edit"} node`}
        className="graph-create-overlay-backdrop"
        onClick={handleClose}
        tabIndex={0}
        type="button"
      />

      <div className="graph-create-sheet-shell">
        <div
          className={`graph-create-sheet graph-create-sheet-open${isCreate ? " graph-create-sheet--quick" : ""}`}
        >
          {isCreate ? (
            <div className="graph-quick-header">
              <p className="graph-create-sheet-kicker">New node</p>
              <button
                aria-label="Close create node"
                className="graph-create-close graph-quick-close"
                onClick={handleClose}
                type="button"
              >
                <CloseIcon className="h-[12px] w-[12px]" />
              </button>
            </div>
          ) : (
          <>
          <div className="graph-create-sheet-header">
            <div className="min-w-0">
              <p className="graph-create-sheet-kicker">{kicker}</p>
              <h2 className="graph-create-sheet-title">{title}</h2>
              <p className="graph-create-sheet-copy">{copy}</p>
            </div>

            <button
              aria-label="Close edit node"
              className="graph-create-close"
              onClick={handleClose}
              type="button"
            >
              <CloseIcon className="h-[14px] w-[14px]" />
            </button>
          </div>

          <div className="graph-create-preview-wrap">
            <div className="graph-create-preview-frame">
              <div
                className={`graph-create-preview-node ${taskPreview ? "graph-create-preview-node-task" : ""}`}
                style={
                  {
                    "--create-node-accent": previewAccent,
                    "--create-node-height": `${previewHeight}px`,
                    "--create-node-width": `${previewWidth}px`,
                  } as CSSProperties
                }
              >
                <div className="graph-create-preview-band" />
                {taskPreview ? <div className="graph-create-preview-wash" /> : null}
                <div className="graph-create-preview-sheen" />
                <div className="graph-create-preview-content">
                  <span className="graph-create-preview-type">{resolvedTypeLabel}</span>
                  <span className="graph-create-preview-title">
                    {safeDraft.title.trim() || "Node title"}
                  </span>
                  <span className="graph-create-preview-meta">
                    {importanceLabel} · {safeDraft.importance_index}
                  </span>
                </div>
              </div>
            </div>
          </div>
          </>
          )}

          <div className="graph-create-sheet-body shell-scrollbar">
            <div className="graph-create-fields">
              {isCreate ? (
                <div className="graph-quick-top">
                  <input
                    aria-label="Title"
                    autoFocus
                    className="graph-create-input graph-create-input-title graph-quick-title"
                    enterKeyHint="go"
                    onChange={(event) => handleTitleChange(event.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    placeholder="What is it? e.g. Email the professor"
                    type="text"
                    value={safeDraft.title}
                  />

                  <div className="graph-quick-meta">
                    <button
                      aria-expanded={typeMenuOpen}
                      aria-label={`Type: ${resolvedTypeLabel}${typeGuessed ? " (guessed)" : ""}. Change type`}
                      className="graph-quick-type"
                      data-open={typeMenuOpen || undefined}
                      onClick={() => setTypeMenuOpen((current) => !current)}
                      type="button"
                    >
                      <i
                        aria-hidden="true"
                        className="graph-type-option-dot"
                        style={{ background: previewAccent }}
                      />
                      <span className="graph-quick-type-label">{resolvedTypeLabel}</span>
                      {typeGuessed ? <span className="graph-quick-guess">guessed</span> : null}
                      <ChevronDownIcon
                        className={`h-[12px] w-[12px] shrink-0 transition-transform duration-200 ${
                          typeMenuOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {parentOptions.length > 0 ? (
                      <label className="graph-quick-parent">
                        <span className="graph-quick-parent-label">Under</span>
                        <span className="graph-connection-select-shell graph-quick-parent-shell">
                          <select
                            aria-label="Parent"
                            className="graph-connection-select"
                            onChange={(event) => onChangeField("parent_id", event.target.value)}
                            value={safeDraft.parent_id ?? ""}
                          >
                            <option value="">Nothing — top level</option>
                            {parentOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.title}
                              </option>
                            ))}
                          </select>
                          <ChevronDownIcon className="h-[12px] w-[12px] text-[var(--color-text-muted)]" />
                        </span>
                      </label>
                    ) : null}
                  </div>

                  {typeMenuOpen ? (
                    <div className="graph-quick-types" role="group" aria-label="Node type">
                      {presetFamilies.map((group) => (
                        <div className="graph-quick-type-family" key={group.family}>
                          <span className="graph-type-family-label">{group.label}</span>
                          <div className="graph-quick-type-chips">
                            {group.types.map((item) => (
                              <button
                                aria-pressed={item.value === safeDraft.node_type}
                                className="graph-quick-type-chip"
                                key={item.value}
                                onClick={() => pickType(item.value)}
                                title={item.description}
                                type="button"
                              >
                                <i
                                  aria-hidden="true"
                                  className="graph-type-option-dot"
                                  style={{ background: NODE_COLOR_BY_TYPE[item.value] }}
                                />
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <p className="graph-quick-type-question">{activeTypeDescription}</p>

                  <button
                    aria-expanded={moreOpen}
                    className="graph-quick-more"
                    onClick={() => setMoreOpen((current) => !current)}
                    type="button"
                  >
                    <ChevronDownIcon
                      className={`h-[12px] w-[12px] shrink-0 transition-transform duration-200 ${
                        moreOpen ? "rotate-180" : "-rotate-90"
                      }`}
                    />
                    {moreOpen ? "Fewer details" : "More details"}
                    <span className="graph-quick-more-hint">summary · date · importance</span>
                  </button>
                </div>
              ) : (
              <label className="graph-create-field">
                <span className="graph-create-label">Title</span>
                <input
                  className="graph-create-input graph-create-input-title"
                  onChange={(event) => onChangeField("title", event.target.value)}
                  placeholder="Node title"
                  type="text"
                  value={safeDraft.title}
                />
              </label>
              )}

              {!isCreate || moreOpen ? (
              <>
              <label className="graph-create-field">
                <div className="space-y-1">
                  <span className="graph-create-label">Summary</span>
                  <p className="graph-create-helper">
                    A concise human-readable description shown in context and details.
                  </p>
                </div>
                <textarea
                  className="graph-create-input graph-create-textarea graph-create-textarea-summary"
                  onChange={(event) => onChangeField("summary", event.target.value)}
                  placeholder="Short summary"
                  rows={3}
                  value={safeDraft.summary}
                />
              </label>

              <label className="graph-create-field">
                <div className="space-y-1">
                  <span className="graph-create-label">
                    Context <span className="graph-create-helper-inline">(optional)</span>
                  </span>
                  <p className="graph-create-helper">
                    So what / why it matters / what&rsquo;s next. A few sentences max — the
                    summary already says &ldquo;what is this&rdquo;.
                  </p>
                </div>
                <textarea
                  className="graph-create-input graph-create-textarea graph-create-textarea-summary"
                  onChange={(event) => onChangeField("body", event.target.value)}
                  placeholder="Why this matters and what's the next step"
                  rows={4}
                  value={safeDraft.body}
                  maxLength={400}
                />
              </label>

              <label className="graph-create-field">
                <div className="space-y-1">
                  <span className="graph-create-label">
                    Target date <span className="graph-create-helper-inline">(optional)</span>
                  </span>
                  <p className="graph-create-helper">
                    Adds this node to the Roadmap view. Leave blank for an undated thought.
                  </p>
                </div>
                <div className="graph-create-date-row">
                  <input
                    className="graph-create-input"
                    type="date"
                    value={safeDraft.target_date}
                    onChange={(event) => onChangeField("target_date", event.target.value)}
                  />
                  {safeDraft.target_date ? (
                    <button
                      type="button"
                      className="graph-create-date-clear"
                      onClick={() => onChangeField("target_date", "")}
                      aria-label="Clear date"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </label>

              {showRawText ? (
                <label className="graph-create-field">
                  <div className="space-y-1">
                    <span className="graph-create-label">Source note</span>
                    <p className="graph-create-helper">
                      The original thought, pasted note, or fuller raw context behind this node.
                    </p>
                  </div>
                  <textarea
                    className="graph-create-input graph-create-textarea graph-create-textarea-raw"
                    onChange={(event) => onChangeField("raw_text", event.target.value)}
                    placeholder="Source thought or raw note"
                    rows={5}
                    value={safeDraft.raw_text}
                  />
                </label>
              ) : null}

              {isCreate ? null : (
              <div className="graph-create-field">
                <span className="graph-create-label">Type</span>
                <div className="graph-type-select">
                  <button
                    aria-expanded={typeMenuOpen}
                    className={`graph-type-trigger ${typeMenuOpen ? "graph-type-trigger-open" : ""}`}
                    onClick={() => setTypeMenuOpen((current) => !current)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <span className="graph-type-trigger-label">{resolvedTypeLabel}</span>
                      <span className="graph-type-trigger-meta">{activeTypeDescription}</span>
                    </div>
                    <ChevronDownIcon
                      className={`h-[14px] w-[14px] shrink-0 transition-transform duration-200 ${
                        typeMenuOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  <div className={`graph-type-menu ${typeMenuOpen ? "graph-type-menu-open" : ""}`}>
                    {presetFamilies.map((group) => (
                      <div className="graph-type-family" key={group.family}>
                        <span className="graph-type-family-label">{group.label}</span>
                        {group.types.map((item) => {
                          const active = item.value === safeDraft.node_type;

                          return (
                            <button
                              className={`graph-type-option ${active ? "graph-type-option-active" : ""}`}
                              key={item.value}
                              onClick={() => {
                                onChangeField("node_type", item.value);
                                onChangeField("custom_type", "");
                                setTypeMenuOpen(false);
                              }}
                              type="button"
                            >
                              <span className="graph-type-option-label">
                                <i
                                  aria-hidden="true"
                                  className="graph-type-option-dot"
                                  style={{ background: NODE_COLOR_BY_TYPE[item.value] }}
                                />
                                {item.label}
                              </span>
                              <span className="graph-type-option-copy">{item.description}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {safeDraft.node_type === "custom" ? (
                  <input
                    className="graph-create-input graph-create-input-inline"
                    onChange={(event) => onChangeField("custom_type", event.target.value)}
                    placeholder="Custom type label"
                    type="text"
                    value={safeDraft.custom_type}
                  />
                ) : null}
              </div>
              )}

              <div className="graph-create-field">
                <div className="flex items-end justify-between gap-3">
                  <span className="graph-create-label">Importance</span>
                  <div className="graph-importance-pill">
                    <span>{importanceLabel}</span>
                    <span>{safeDraft.importance_index}</span>
                  </div>
                </div>

                <div className="graph-importance-control">
                  <div
                    className="graph-importance-slider-wrap"
                    style={{ "--graph-importance-progress": sliderProgress } as CSSProperties}
                  >
                    <input
                      className="graph-importance-slider"
                      max={100}
                      min={0}
                      onChange={(event) =>
                        onChangeField("importance_index", Number(event.target.value))
                      }
                      step={1}
                      type="range"
                      value={safeDraft.importance_index}
                    />
                  </div>
                  <div className="graph-importance-scale">
                    <span>Low</span>
                    <span>Medium</span>
                    <span>High</span>
                  </div>
                  {mode === "edit" ? (
                    <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-(--color-text-muted)">
                      <span>
                        {safeDraft.manual_weight != null
                          ? "Manual override — auto-scoring paused for this node"
                          : "Auto-scored"}
                      </span>
                      {safeDraft.manual_weight != null && onResetManualWeight ? (
                        <button
                          className="graph-reset-manual-weight underline underline-offset-2 hover:text-(--color-text-primary)"
                          onClick={onResetManualWeight}
                          type="button"
                        >
                          Reset to auto
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
              </>
              ) : null}

              {mode === "edit" ? (
                <div className="graph-create-field">
                  <div className="space-y-1">
                    <span className="graph-create-label">Connections</span>
                    <p className="graph-create-helper">
                      Change connection types, remove links, or add a new relationship from this node.
                    </p>
                  </div>

                  <div className="graph-connection-list">
                    {connections.length > 0 ? (
                      connections.map((connection) => {
                        const draftRelationId =
                          connectionDraftOverrides[connection.edgeId] ?? connection.relationId;
                        const relationChanged = draftRelationId !== connection.relationId;

                        return (
                          <div className="graph-connection-row" key={connection.edgeId}>
                            <div className="graph-connection-node">
                              <span className="graph-connection-node-title">{connection.title}</span>
                              <span className="graph-connection-node-meta">
                                {connection.nodeType}
                              </span>
                            </div>

                            <div className="graph-connection-controls">
                              <div className="graph-connection-select-shell">
                                <select
                                  className="graph-connection-select"
                                  onChange={(event) =>
                                    setConnectionDraftOverrides((currentDrafts) => ({
                                      ...currentDrafts,
                                      [connection.edgeId]:
                                        event.target.value as EdgeRelationOptionId,
                                    }))
                                  }
                                  value={draftRelationId}
                                >
                                  {connectionTypeOptions.map((option) => (
                                    <option key={option.id} value={option.id}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDownIcon className="h-[12px] w-[12px] text-[var(--color-text-muted)]" />
                              </div>

                              <button
                                className="graph-connection-action"
                                disabled={
                                  !relationChanged ||
                                  connectionUpdateSubmittingId === connection.edgeId ||
                                  connectionSubmitting
                                }
                                onClick={() =>
                                  onUpdateConnection?.(connection.edgeId, draftRelationId)
                                }
                                type="button"
                              >
                                {connectionUpdateSubmittingId === connection.edgeId
                                  ? "Saving..."
                                  : "Update"}
                              </button>

                              <button
                                className="graph-connection-action graph-connection-action-danger"
                                disabled={connectionDeleteSubmittingId === connection.edgeId}
                                onClick={() => onDeleteConnection?.(connection.edgeId)}
                                type="button"
                              >
                                {connectionDeleteSubmittingId === connection.edgeId
                                  ? "Removing..."
                                  : "Remove"}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="graph-connection-empty">No connections yet.</p>
                    )}
                  </div>

                  <div className="graph-connection-composer">
                    <div className="graph-connection-composer-grid">
                      <label className="graph-connection-composer-field">
                        <span className="graph-create-label">Connect to</span>
                        <div className="graph-connection-select-shell">
                          <select
                            className="graph-connection-select"
                            onChange={(event) => onChangeNewConnectionTarget?.(event.target.value)}
                            value={connectionTargetId}
                          >
                            <option value="">Select node</option>
                            {connectionTargetOptions.map((node) => (
                              <option key={node.id} value={node.id}>
                                {node.title} · {node.node_type}
                              </option>
                            ))}
                          </select>
                          <ChevronDownIcon className="h-[12px] w-[12px] text-[var(--color-text-muted)]" />
                        </div>
                      </label>

                      <label className="graph-connection-composer-field">
                        <span className="graph-create-label">Relation</span>
                        <div className="graph-connection-select-shell">
                          <select
                            className="graph-connection-select"
                            onChange={(event) =>
                              onChangeNewConnectionRelation?.(
                                event.target.value as EdgeRelationOptionId,
                              )
                            }
                            value={connectionRelationId}
                          >
                            {connectionTypeOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDownIcon className="h-[12px] w-[12px] text-[var(--color-text-muted)]" />
                        </div>
                        <p className="graph-connection-helper">
                          {connectionTypeOptions.find((option) => option.id === connectionRelationId)
                            ?.description ?? "Choose how this node should connect."}
                        </p>
                      </label>
                    </div>

                    <div className="graph-connection-composer-actions">
                      <button
                        className="graph-create-secondary"
                        disabled={
                          connectionSubmitting ||
                          connectionTargetId.length === 0 ||
                          connectionTargetOptions.length === 0
                        }
                        onClick={onCreateConnection}
                        type="button"
                      >
                        {connectionSubmitting ? "Adding..." : "Add connection"}
                      </button>
                    </div>
                  </div>

                  {connectionError ? (
                    <p className="graph-create-error graph-create-error-inline">
                      {connectionError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {error ? <p className="graph-create-error">{error}</p> : null}

          {mode === "edit" && dangerConfirmOpen ? (
            <div className="graph-create-danger-panel">
              <p className="graph-create-danger-title">Delete this node?</p>
              <p className="graph-create-danger-copy">
                This will remove {deleteNodeCount} {deleteNodeCount === 1 ? "node" : "nodes"}
                {deleteDescendantCount > 0
                  ? `, including ${deleteDescendantCount} ${deleteDescendantCount === 1 ? "descendant" : "descendants"}`
                  : ""}
                . {deleteEdgeCount > 0 ? `${deleteEdgeCount} attached ${deleteEdgeCount === 1 ? "connection" : "connections"} will also be removed. ` : ""}
                The rest of the graph will remain.
              </p>
              <div className="graph-create-danger-actions">
                <button className="graph-create-secondary" onClick={onCancelDelete} type="button">
                  Keep node
                </button>
                <button
                  className="graph-create-danger-confirm"
                  disabled={deleteSubmitting}
                  onClick={onConfirmDelete}
                  type="button"
                >
                  {deleteSubmitting ? "Deleting..." : "Delete node"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="graph-create-actions">
            {isCreate ? (
              <span className="graph-quick-hint" aria-hidden="true">
                <kbd>↵</kbd> to create · <kbd>esc</kbd> to close
              </span>
            ) : null}
            {mode === "edit" ? (
              <button
                className="graph-create-danger-trigger"
                onClick={dangerConfirmOpen ? onCancelDelete : onRequestDelete}
                type="button"
              >
                {dangerConfirmOpen ? "Cancel delete" : "Delete"}
              </button>
            ) : null}
            <button className="graph-create-secondary" onClick={handleClose} type="button">
              Cancel
            </button>
            <button
              className="graph-create-primary"
              disabled={!canSubmit}
              onClick={onSubmit}
              type="button"
            >
              {primaryActionLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Quick create: title first (Enter creates), the type guessed from the title
// and one tap to change, a parent, and everything else folded away. Mounted
// fresh per open, so the "guessed" state and the fold start over each time.
export function CreateNodeSheet({
  draft,
  error,
  onChangeField,
  onClose,
  onSubmit,
  parentOptions,
  submitting,
}: CreateNodeSheetProps) {
  if (!draft) return null;
  return (
    <SharedNodeSheet
      draft={draft}
      error={error}
      mode="create"
      onChangeField={onChangeField}
      onClose={onClose}
      onSubmit={onSubmit}
      parentOptions={parentOptions}
      showRawText
      submitting={submitting}
    />
  );
}

export function EditNodeSheet({
  connectionDeleteSubmittingId,
  connectionError,
  connectionRelationId,
  connectionSubmitting,
  connectionTargetId,
  connectionTargetOptions,
  connectionTypeOptions,
  connectionUpdateSubmittingId,
  connections,
  deleteDescendantCount,
  deleteEdgeCount,
  deleteNodeCount,
  deleteConfirmOpen,
  deleteSubmitting,
  draft,
  error,
  onCancelDelete,
  onChangeField,
  onChangeNewConnectionRelation,
  onChangeNewConnectionTarget,
  onClose,
  onConfirmDelete,
  onCreateConnection,
  onDeleteConnection,
  onRequestDelete,
  onResetManualWeight,
  onSubmit,
  onUpdateConnection,
  submitting,
}: EditNodeSheetProps) {
  return (
    <SharedNodeSheet
      connectionDeleteSubmittingId={connectionDeleteSubmittingId}
      connectionError={connectionError}
      connectionRelationId={connectionRelationId}
      connectionSubmitting={connectionSubmitting}
      connectionTargetId={connectionTargetId}
      connectionTargetOptions={connectionTargetOptions}
      connectionTypeOptions={connectionTypeOptions}
      connectionUpdateSubmittingId={connectionUpdateSubmittingId}
      connections={connections}
      deleteDescendantCount={deleteDescendantCount}
      deleteEdgeCount={deleteEdgeCount}
      deleteNodeCount={deleteNodeCount}
      dangerConfirmOpen={deleteConfirmOpen}
      deleteSubmitting={deleteSubmitting}
      draft={draft}
      error={error}
      mode="edit"
      onCancelDelete={onCancelDelete}
      onChangeField={onChangeField}
      onChangeNewConnectionRelation={onChangeNewConnectionRelation}
      onChangeNewConnectionTarget={onChangeNewConnectionTarget}
      onClose={onClose}
      onConfirmDelete={onConfirmDelete}
      onCreateConnection={onCreateConnection}
      onDeleteConnection={onDeleteConnection}
      onRequestDelete={onRequestDelete}
      onResetManualWeight={onResetManualWeight}
      onSubmit={onSubmit}
      onUpdateConnection={onUpdateConnection}
      showRawText={false}
      submitting={submitting}
    />
  );
}
