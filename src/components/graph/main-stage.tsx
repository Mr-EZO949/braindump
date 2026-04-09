"use client";

import { useState, useCallback } from "react";
import { CreateNodeSheet, EditNodeSheet } from "@/components/graph/create-node-sheet";
import { GraphCanvas } from "@/components/graph/graph-canvas";
import { NetworkIcon, PencilIcon, PlusIcon, SearchIcon } from "@/components/ui/icons";
import type { LocalGraphCameraView } from "@/lib/graph/data";
import type { EdgeRelationOptionId } from "@/lib/graph/relationships";
import type { CreateNodeInput, GraphData } from "@/types/graph";

type MainStageProps = {
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
  edgeConnectionDeleteSubmittingId: string | null;
  edgeConnectionError: string | null;
  edgeConnectionRelationId: EdgeRelationOptionId;
  edgeConnectionSubmitting: boolean;
  edgeConnectionTargetId: string;
  edgeConnectionTargetOptions: Array<{
    id: string;
    node_type: string;
    title: string;
  }>;
  edgeConnectionTypeOptions: Array<{
    description: string;
    id: EdgeRelationOptionId;
    label: string;
  }>;
  edgeConnectionUpdateSubmittingId: string | null;
  edgeConnections: Array<{
    edgeId: string;
    nodeId: string;
    nodeType: string;
    relationId: EdgeRelationOptionId;
    title: string;
  }>;
  graphData: GraphData;
  graphImportanceFilter: string;
  graphImportanceFilterOptions: Array<{
    label: string;
    value: string;
  }>;
  graphLoading: boolean;
  graphSearchValue: string;
  graphTypeFilter: string;
  graphTypeFilterOptions: Array<{
    label: string;
    value: string;
  }>;
  onChangeCreateNodeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onCameraViewChange: (view: LocalGraphCameraView) => void;
  onChangeEditNodeField: <Field extends keyof CreateNodeInput>(
    field: Field,
    value: CreateNodeInput[Field],
  ) => void;
  onChangeGraphImportanceFilter: (value: string) => void;
  onChangeGraphTypeFilter: (value: string) => void;
  onChangeNewEdgeConnectionRelation: (relationId: EdgeRelationOptionId) => void;
  onChangeNewEdgeConnectionTarget: (nodeId: string) => void;
  onCommitNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  onConfirmDeleteNode: () => void;
  onCreateEdgeConnection: () => void;
  onDeleteEdgeConnection: (edgeId: string) => void;
  onGraphSearchChange: (value: string) => void;
  onGraphSearchSubmit: () => void;
  onCloseCreateNode: () => void;
  onCloseEditNode: () => void;
  onOpenCreateNode: () => void;
  hideCompleted: boolean;
  onResetGraphFilters: () => void;
  onToggleHideCompleted: () => void;
  onToggleShowArchived: () => void;
  onToggleEditMode: () => void;
  onFindAllConnections: () => void;
  findingConnections: boolean;
  showArchived: boolean;
  onRequestDeleteNode: () => void;
  onCancelDeleteNode: () => void;
  onSelectNode: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  focusRequestKey: number;
  onSubmitCreateNode: () => void;
  onSubmitEditNode: () => void;
  onUpdateEdgeConnection: (edgeId: string, relationId: EdgeRelationOptionId) => void;
  suppressInitialFocusAnimation: boolean;
};

export function MainStage({
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
  edgeConnectionDeleteSubmittingId,
  edgeConnectionError,
  edgeConnectionRelationId,
  edgeConnectionSubmitting,
  edgeConnectionTargetId,
  edgeConnectionTargetOptions,
  edgeConnectionTypeOptions,
  edgeConnectionUpdateSubmittingId,
  edgeConnections,
  graphData,
  graphImportanceFilter,
  graphImportanceFilterOptions,
  graphLoading,
  graphSearchValue,
  graphTypeFilter,
  graphTypeFilterOptions,
  hideCompleted,
  onCancelDeleteNode,
  onCameraViewChange,
  onChangeCreateNodeField,
  onChangeEditNodeField,
  onChangeGraphImportanceFilter,
  onChangeGraphTypeFilter,
  onChangeNewEdgeConnectionRelation,
  onChangeNewEdgeConnectionTarget,
  onCommitNodePosition,
  onCloseCreateNode,
  onCloseEditNode,
  onConfirmDeleteNode,
  onCreateEdgeConnection,
  onDeleteEdgeConnection,
  onGraphSearchChange,
  onGraphSearchSubmit,
  onOpenCreateNode,
  onResetGraphFilters,
  onToggleHideCompleted,
  onToggleShowArchived,
  onToggleEditMode,
  onFindAllConnections,
  findingConnections,
  onRequestDeleteNode,
  onSelectNode,
  onSubmitCreateNode,
  onSubmitEditNode,
  onUpdateEdgeConnection,
  selectedNodeId,
  focusRequestKey,
  showArchived,
  suppressInitialFocusAnimation,
}: MainStageProps) {
  const filtersActive = graphTypeFilter !== "all" || graphImportanceFilter !== "all";
  const [layoutKey, setLayoutKey] = useState(0);
  const resetLayout = useCallback(() => setLayoutKey((k) => k + 1), []);

  return (
    <main className="relative min-w-0 flex-1 overflow-hidden bg-[var(--color-bg-base)]" data-tour="graph-area">
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
        focusRequestKey={focusRequestKey}
        graphData={graphData}
        editMode={editMode}
        layoutKey={layoutKey}
        loading={graphLoading}
        onCommitNodePosition={onCommitNodePosition}
        onSelectNode={onSelectNode}
        onViewChange={onCameraViewChange}
        searchQuery={graphSearchValue}
        suppressInitialFocusAnimation={suppressInitialFocusAnimation}
      />

      <div className="graph-toolbar-responsive absolute right-6 top-6 z-20 flex items-center gap-2">
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
          aria-label="Reset layout"
          className="graph-edit-toggle"
          onClick={resetLayout}
          title="Reset layout"
          type="button"
        >
          <svg className="h-[14px] w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>

        <button
          aria-label="Find connections across workspace"
          className={`graph-edit-toggle ${findingConnections ? "graph-edit-toggle-active" : ""}`}
          disabled={findingConnections}
          onClick={onFindAllConnections}
          title="Find connections across workspace"
          type="button"
        >
          {findingConnections ? (
            <span className="graph-find-spinner" />
          ) : (
            <NetworkIcon className="h-[14px] w-[14px]" />
          )}
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
        connectionDeleteSubmittingId={edgeConnectionDeleteSubmittingId}
        connectionError={edgeConnectionError}
        connectionRelationId={edgeConnectionRelationId}
        connectionSubmitting={edgeConnectionSubmitting}
        connectionTargetId={edgeConnectionTargetId}
        connectionTargetOptions={edgeConnectionTargetOptions}
        connectionTypeOptions={edgeConnectionTypeOptions}
        connectionUpdateSubmittingId={edgeConnectionUpdateSubmittingId}
        connections={edgeConnections}
        deleteDescendantCount={deleteDescendantCount}
        deleteEdgeCount={deleteEdgeCount}
        deleteNodeCount={deleteNodeCount}
        deleteConfirmOpen={deleteNodeConfirmOpen}
        deleteSubmitting={deleteNodeSubmitting}
        draft={editNodeDraft}
        error={editNodeError}
        onCancelDelete={onCancelDeleteNode}
        onChangeField={onChangeEditNodeField}
        onChangeNewConnectionRelation={onChangeNewEdgeConnectionRelation}
        onChangeNewConnectionTarget={onChangeNewEdgeConnectionTarget}
        onClose={onCloseEditNode}
        onConfirmDelete={onConfirmDeleteNode}
        onCreateConnection={onCreateEdgeConnection}
        onDeleteConnection={onDeleteEdgeConnection}
        onRequestDelete={onRequestDeleteNode}
        onSubmit={onSubmitEditNode}
        onUpdateConnection={onUpdateEdgeConnection}
        submitting={editNodeSubmitting}
      />

      <div className="graph-controls-responsive absolute left-6 top-6 z-10">
        <div className="graph-stage-controls">
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

          <div className="graph-filter-row">
            <label className="graph-filter-shell">
              <span className="sr-only">Filter by node type</span>
              <select
                className="graph-filter-select"
                onChange={(event) => onChangeGraphTypeFilter(event.target.value)}
                value={graphTypeFilter}
              >
                {graphTypeFilterOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="graph-filter-shell">
              <span className="sr-only">Filter by importance</span>
              <select
                className="graph-filter-select"
                onChange={(event) => onChangeGraphImportanceFilter(event.target.value)}
                value={graphImportanceFilter}
              >
                {graphImportanceFilterOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              className={`graph-filter-reset ${!hideCompleted ? "graph-filter-reset-active" : ""}`}
              onClick={onToggleHideCompleted}
              title={hideCompleted ? "Show completed nodes" : "Hide completed nodes"}
              type="button"
            >
              {hideCompleted ? "Completed" : "Hide done"}
            </button>

            <button
              className={`graph-filter-reset ${showArchived ? "graph-filter-reset-active" : ""}`}
              onClick={onToggleShowArchived}
              type="button"
            >
              {showArchived ? "Hide archived" : "Archived"}
            </button>

            <button
              className={`graph-filter-reset ${filtersActive ? "graph-filter-reset-active" : ""}`}
              disabled={!filtersActive}
              onClick={onResetGraphFilters}
              type="button"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
