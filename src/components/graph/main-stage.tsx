"use client";

import { CreateNodeSheet, EditNodeSheet } from "@/components/graph/create-node-sheet";
import { GraphCanvas } from "@/components/graph/graph-canvas";
import {
  ArrowUpIcon,
  AttachmentIcon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/ui/icons";
import type { CreateNodeInput, GraphData } from "@/types/graph";

type MainStageProps = {
  composerPlaceholder: string;
  composerValue: string;
  createNodeDraft: CreateNodeInput | null;
  createNodeError: string | null;
  createNodeSubmitting: boolean;
  deleteDescendantCount: number;
  deleteEdgeCount: number;
  deleteNodeCount: number;
  deleteNodeConfirmOpen: boolean;
  deleteNodeSubmitting: boolean;
  editMode: boolean;
  editNodeDraft: CreateNodeInput | null;
  editNodeError: string | null;
  editNodeSubmitting: boolean;
  graphData: GraphData;
  graphLoading: boolean;
  graphSearchValue: string;
  onChangeCreateNodeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onChangeEditNodeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onCommitNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  onConfirmDeleteNode: () => void;
  onGraphSearchChange: (value: string) => void;
  onGraphSearchSubmit: () => void;
  onCloseCreateNode: () => void;
  onCloseEditNode: () => void;
  onOpenCreateNode: () => void;
  onToggleEditMode: () => void;
  onRequestDeleteNode: () => void;
  onCancelDeleteNode: () => void;
  onSelectNode: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onComposerChange: (value: string) => void;
  onComposerSubmit: () => void;
  onSubmitCreateNode: () => void;
  onSubmitEditNode: () => void;
  submitting: boolean;
};

export function MainStage({
  composerPlaceholder,
  composerValue,
  createNodeDraft,
  createNodeError,
  createNodeSubmitting,
  deleteDescendantCount,
  deleteEdgeCount,
  deleteNodeCount,
  deleteNodeConfirmOpen,
  deleteNodeSubmitting,
  editMode,
  editNodeDraft,
  editNodeError,
  editNodeSubmitting,
  graphData,
  graphLoading,
  graphSearchValue,
  onCancelDeleteNode,
  onChangeCreateNodeField,
  onChangeEditNodeField,
  onCommitNodePosition,
  onCloseCreateNode,
  onCloseEditNode,
  onComposerChange,
  onComposerSubmit,
  onConfirmDeleteNode,
  onGraphSearchChange,
  onGraphSearchSubmit,
  onOpenCreateNode,
  onToggleEditMode,
  onRequestDeleteNode,
  onSelectNode,
  onSubmitCreateNode,
  onSubmitEditNode,
  selectedNodeId,
  submitting,
}: MainStageProps) {
  return (
    <main className="relative min-w-0 flex-1 overflow-hidden bg-[var(--color-bg-base)]">
      <div className="main-stage-material pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,transparent_62%,rgba(0,0,0,0.16)_100%)]" />
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-200 ease-out ${
          editMode ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="main-stage-edit-overlay" />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 py-10">
        <div className="origin-marker" aria-hidden="true">
          <div className="origin-field" />
          <div className="origin-aura" />
          <div className="origin-ring" />
          <div className="origin-core" />
          <div className="origin-dot" />
        </div>
      </div>
      <GraphCanvas
        focusNodeId={selectedNodeId}
        graphData={graphData}
        editMode={editMode}
        loading={graphLoading}
        onCommitNodePosition={onCommitNodePosition}
        onSelectNode={onSelectNode}
        searchQuery={graphSearchValue}
      />

      <div className="absolute right-6 top-6 z-20 flex items-center gap-2">
        <div
          className={`graph-edit-mode-chip ${editMode ? "graph-edit-mode-chip-active" : ""}`}
        >
          Edit mode
        </div>

        <button
          aria-hidden={!editMode}
          aria-label="Create node"
          className={`graph-create-trigger ${
            editMode ? "graph-create-trigger-visible" : "graph-create-trigger-hidden"
          }`}
          onClick={onOpenCreateNode}
          tabIndex={editMode ? 0 : -1}
          type="button"
        >
          <PlusIcon className="h-[14px] w-[14px]" />
          <span>New node</span>
        </button>

        <button
          aria-label={editMode ? "Exit edit mode" : "Enter edit mode"}
          aria-pressed={editMode}
          className={`graph-edit-toggle ${editMode ? "graph-edit-toggle-active" : ""}`}
          onClick={onToggleEditMode}
          type="button"
        >
          <PencilIcon className="h-[14px] w-[14px]" />
        </button>
      </div>

      <CreateNodeSheet
        draft={createNodeDraft}
        error={createNodeError}
        onChangeField={onChangeCreateNodeField}
        onClose={onCloseCreateNode}
        onSubmit={onSubmitCreateNode}
        submitting={createNodeSubmitting}
      />

      <EditNodeSheet
        deleteDescendantCount={deleteDescendantCount}
        deleteEdgeCount={deleteEdgeCount}
        deleteNodeCount={deleteNodeCount}
        deleteConfirmOpen={deleteNodeConfirmOpen}
        deleteSubmitting={deleteNodeSubmitting}
        draft={editNodeDraft}
        error={editNodeError}
        onCancelDelete={onCancelDeleteNode}
        onChangeField={onChangeEditNodeField}
        onClose={onCloseEditNode}
        onConfirmDelete={onConfirmDeleteNode}
        onRequestDelete={onRequestDeleteNode}
        onSubmit={onSubmitEditNode}
        submitting={editNodeSubmitting}
      />

      <div className="absolute left-6 top-6 z-10">
        <label className="graph-search-control">
          <SearchIcon className="h-[13px] w-[13px] shrink-0 text-[var(--color-text-muted)]" />
          <span className="sr-only">Graph search</span>
          <input
            className="graph-search-input"
            onChange={(event) => onGraphSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onGraphSearchSubmit();
              }
            }}
            placeholder="Find node"
            type="search"
            value={graphSearchValue}
          />
        </label>
      </div>

      <div className="absolute inset-x-0 bottom-6 z-10 flex justify-center px-6">
        <div className="stage-composer" role="group" aria-label="Thought composer">
          <button
            aria-label="Add attachment"
            className="composer-utility-button"
            type="button"
          >
            <AttachmentIcon className="h-[15px] w-[15px]" />
          </button>

          <textarea
            className="stage-composer-textarea"
            onChange={(event) => onComposerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onComposerSubmit();
              }
            }}
            placeholder={composerPlaceholder}
            rows={1}
            value={composerValue}
          />

          <button
            aria-label="Start voice input"
            className="composer-utility-button"
            type="button"
          >
            <MicIcon className="h-[15px] w-[15px]" />
          </button>

          <button
            aria-label="Send thought"
            className="composer-send-button"
            disabled={submitting || composerValue.trim().length === 0}
            onClick={onComposerSubmit}
            type="button"
          >
            <ArrowUpIcon className="h-[15px] w-[15px]" />
          </button>
        </div>
      </div>
    </main>
  );
}
