"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { ChevronDownIcon, CloseIcon, PlusIcon } from "@/components/ui/icons";
import { getImportanceLabel } from "@/lib/graph/importance";
import type { CreateNodeInput } from "@/types/graph";

type CreateNodeSheetProps = {
  draft: CreateNodeInput | null;
  error: string | null;
  onChangeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onClose: () => void;
  onOpen: () => void;
  onSubmit: () => void;
  submitting: boolean;
};

const presetTypes = [
  {
    description: "North-star motivation or enduring direction.",
    label: "Goal",
    value: "goal",
  },
  {
    description: "A concrete venture, build, or system.",
    label: "Project",
    value: "project",
  },
  {
    description: "An actionable next step or deliverable.",
    label: "Task",
    value: "task",
  },
  {
    description: "A reusable idea, model, or supporting concept.",
    label: "Concept",
    value: "concept",
  },
  {
    description: "A course, subject, or formal class branch.",
    label: "Class",
    value: "class",
  },
  {
    description: "Use a custom label when the presets do not fit.",
    label: "Custom type",
    value: "custom",
  },
] as const;

const typeAccentByPreset: Record<Exclude<CreateNodeInput["node_type"], "custom">, string> = {
  class: "#9c7a49",
  concept: "#70808d",
  goal: "#ddd6cc",
  project: "#955460",
  task: "#bb4b58",
};

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

export function CreateNodeSheet({
  draft,
  error,
  onChangeField,
  onClose,
  onOpen,
  onSubmit,
  submitting,
}: CreateNodeSheetProps) {
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const open = Boolean(draft);
  const safeDraft = draft ?? {
    custom_type: "",
    importance_index: 58,
    node_type: "concept",
    raw_text: "",
    summary: "",
    title: "",
  };

  const handleClose = useCallback(() => {
    setTypeMenuOpen(false);
    onClose();
  }, [onClose]);

  const handleOpen = useCallback(() => {
    setTypeMenuOpen(false);
    onOpen();
  }, [onOpen]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleClose, open]);

  const resolvedTypeLabel = getResolvedType(safeDraft);
  const importanceLabel = getImportanceLabel(safeDraft.importance_index);
  const previewAccent =
    safeDraft.node_type === "custom"
      ? "rgba(223,214,204,0.9)"
      : typeAccentByPreset[safeDraft.node_type];
  const previewWidth = getPreviewWidth(safeDraft.importance_index);
  const previewHeight = getPreviewHeight(safeDraft.importance_index);
  const taskPreview = safeDraft.node_type === "task";
  const sliderProgress = `${safeDraft.importance_index}%`;

  const activeTypeDescription = useMemo(
    () =>
      presetTypes.find((item) => item.value === safeDraft.node_type)?.description ??
      "Use a custom label for this node.",
    [safeDraft.node_type],
  );

  return (
    <>
      <div className="absolute right-6 top-6 z-20">
        <button
          aria-expanded={open}
          className={`graph-create-trigger ${open ? "graph-create-trigger-open" : ""}`}
          onClick={handleOpen}
          type="button"
        >
          <PlusIcon className="h-[14px] w-[14px]" />
          <span>New node</span>
        </button>
      </div>

      <div
        aria-hidden={!open}
        className={`graph-create-overlay ${open ? "graph-create-overlay-open" : ""}`}
      >
        <button
          aria-label="Close create node"
          className="graph-create-overlay-backdrop"
          onClick={handleClose}
          tabIndex={open ? 0 : -1}
          type="button"
        />

        <div className="graph-create-sheet-shell">
          <div className={`graph-create-sheet ${open ? "graph-create-sheet-open" : ""}`}>
            <div className="graph-create-sheet-header">
              <div className="min-w-0">
                <p className="graph-create-sheet-kicker">New Thought</p>
                <h2 className="graph-create-sheet-title">Create node</h2>
                <p className="graph-create-sheet-copy">
                  Introduce a new thought into this workspace without leaving the graph.
                </p>
              </div>

              <button
                aria-label="Close create node"
                className="graph-create-close"
                onClick={handleClose}
                type="button"
              >
                <CloseIcon className="h-[14px] w-[14px]" />
              </button>
            </div>

            <div className="graph-create-sheet-body shell-scrollbar">
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

              <div className="graph-create-fields">
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
                      {presetTypes.map((item) => {
                        const active = item.value === safeDraft.node_type;

                        return (
                          <button
                            className={`graph-type-option ${active ? "graph-type-option-active" : ""}`}
                            key={item.value}
                            onClick={() => {
                              onChangeField("node_type", item.value);
                              if (item.value !== "custom") {
                                onChangeField("custom_type", "");
                              }
                              setTypeMenuOpen(false);
                            }}
                            type="button"
                          >
                            <span className="graph-type-option-label">{item.label}</span>
                            <span className="graph-type-option-copy">{item.description}</span>
                          </button>
                        );
                      })}
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
                  </div>
                </div>
              </div>
            </div>

            {error ? <p className="graph-create-error">{error}</p> : null}

            <div className="graph-create-actions">
              <button className="graph-create-secondary" onClick={handleClose} type="button">
                Cancel
              </button>
              <button
                className="graph-create-primary"
                disabled={submitting || safeDraft.title.trim().length === 0}
                onClick={onSubmit}
                type="button"
              >
                {submitting ? "Creating..." : "Create node"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
