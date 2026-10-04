"use client";

// The graph view (MainStage) wired to the shell's graph, view, editor,
// status and connection state. One MainStage per workspace (keyed), so a
// switch starts it fresh.

import { MainStage } from "@/components/graph/main-stage";
import { visibleEdgeRelationOptions } from "@/lib/graph/relationships";
import type { Node } from "@/types/graph";

import type { ConnectionAnalysis } from "./use-connection-analysis";
import type { GraphView } from "./use-graph-view";
import type { NodeEditor } from "./use-node-editor";
import type { WorkspaceGraph } from "./use-workspace-graph";

export function ShellGraphStage({
  workspaceId,
  graph,
  view,
  editor,
  connections,
  changeStatus,
}: {
  workspaceId: string | null;
  graph: WorkspaceGraph;
  view: GraphView;
  editor: NodeEditor;
  connections: Pick<ConnectionAnalysis, "analyzingConnections" | "requestFindAll">;
  changeStatus: (nodeId: string, status: Node["status"]) => Promise<void>;
}) {
  const deletePlan = view.selectedNodeDeletePlan;
  return (
    <MainStage
      key={workspaceId ?? "workspace-none"}
      createNodeDraft={editor.createNodeDraft}
      createNodeError={editor.createNodeError}
      createNodeSubmitting={editor.createNodeSubmitting}
      deleteDescendantCount={deletePlan?.descendantCount ?? 0}
      deleteEdgeCount={deletePlan?.edgeIds.length ?? 0}
      deleteNodeCount={deletePlan?.nodeIds.length ?? 1}
      deleteNodeConfirmOpen={editor.deleteNodeConfirmOpen}
      deleteNodeSubmitting={editor.deleteNodeSubmitting}
      editMode={editor.editMode}
      editNodeDraft={editor.editNodeDraft}
      editNodeError={editor.editNodeError}
      editNodeSubmitting={editor.editNodeSubmitting}
      edgeConnectionDeleteSubmittingId={editor.edgeDeleteSubmittingId}
      edgeConnectionError={editor.edgeError}
      edgeConnectionRelationId={editor.edgeRelationId}
      edgeConnectionSubmitting={editor.edgeSubmitting}
      edgeConnectionTargetId={editor.edgeTargetId}
      edgeConnectionTargetOptions={view.connectableNodes}
      edgeConnectionTypeOptions={visibleEdgeRelationOptions}
      edgeConnectionUpdateSubmittingId={editor.edgeUpdateSubmittingId}
      edgeConnections={view.selectedNodeConnections}
      graphData={view.filteredGraphData}
      historyGraphData={graph.graphData}
      workProgressByNode={graph.workProgressByNode}
      pulseNodeIds={graph.priorityPulseIds}
      graphLoading={graph.graphLoading}
      graphSearchValue={view.graphSearchValue}
      graphTypeFilter={view.nodeTypeFilter}
      graphTypeCounts={graph.nodeTypeCounts}
      graphTypeTotalCount={graph.nodeTypeTotalCount}
      onCameraViewChange={view.setCameraView}
      onCancelDeleteNode={() => editor.setDeleteNodeConfirmOpen(false)}
      onChangeCreateNodeField={editor.changeCreateField}
      onChangeEditNodeField={editor.changeEditField}
      onChangeNewEdgeConnectionRelation={editor.setEdgeRelationId}
      onChangeNewEdgeConnectionTarget={editor.setEdgeTargetId}
      onCommitNodePosition={editor.commitNodePosition}
      onConfirmDeleteNode={() => {
        void editor.deleteNode();
      }}
      onCloseCreateNode={editor.closeCreateNode}
      onCloseEditNode={editor.closeEditNode}
      onCreateEdgeConnection={() => {
        void editor.createEdge();
      }}
      onDeleteEdgeConnection={(edgeId) => {
        void editor.deleteEdge(edgeId);
      }}
      onGraphSearchChange={view.setGraphSearchValue}
      onGraphSearchSubmit={editor.submitGraphSearch}
      onChangeGraphTypeFilter={view.setNodeTypeFilter}
      onOpenCreateNode={editor.openCreateNode}
      onResetEditManualWeight={editor.resetManualWeight}
      onResetGraphFilters={view.resetFilters}
      hideCompleted={view.hideCompleted}
      completedNodes={view.completedNodes}
      onSelectCompletedNode={(nodeId) => {
        view.setHideCompleted(false);
        editor.selectNode(nodeId);
      }}
      onSelectArchivedNode={editor.selectNode}
      onRestoreArchivedNode={(nodeId) => {
        void changeStatus(nodeId, "active");
      }}
      onToggleHideCompleted={() => view.setHideCompleted((v) => !v)}
      onFindAllConnections={connections.requestFindAll}
      findingConnections={connections.analyzingConnections}
      onToggleEditMode={editor.toggleEditMode}
      onRequestDeleteNode={() => editor.setDeleteNodeConfirmOpen(true)}
      onSelectNode={editor.selectNode}
      onSubmitCreateNode={() => {
        void editor.submitCreateNode();
      }}
      onSubmitEditNode={() => {
        void editor.submitEditNode();
      }}
      onUpdateEdgeConnection={(edgeId, relationId) => {
        void editor.updateEdge(edgeId, relationId);
      }}
      focusRequestKey={view.focusRequestKey}
      selectedNodeId={view.selectedNodeId}
      suppressInitialFocusAnimation={view.suppressInitialFocusAnimation}
    />
  );
}
