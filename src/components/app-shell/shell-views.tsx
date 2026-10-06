"use client";

// The main area's view for the current mode — graph, planner, todos, habits,
// roadmap — cross-fading on a switch.

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AssistantMode as AssistantModeView } from "@/components/assistant/assistant-mode";
import { HabitsView } from "@/components/ui/habits-view";
import type { AppMode } from "@/components/ui/mode-dock";
import { RoadmapView } from "@/components/ui/roadmap-view";
import { SectionBackdrop } from "@/components/ui/section-backdrop";
import { TodosView } from "@/components/ui/todos-view";
import type { GraphData, Node, NodeStatus } from "@/types/graph";

import type { PlannerSync } from "./use-shell-ui";

export function ShellViews({
  appMode,
  graphStage,
  graphData,
  selectedNodeId,
  workspaceId,
  planner,
  onAskInChat,
  onLinkedNodeStatusChange,
  onOpenNodeInGraph,
  onToggleStatus,
}: {
  appMode: AppMode;
  // The graph view itself (MainStage), built by the shell.
  graphStage: ReactNode;
  graphData: GraphData;
  selectedNodeId: string | null;
  workspaceId: string | null;
  planner: Pick<PlannerSync, "plannerRefreshKey" | "draftPlanRefreshKey" | "draftPlanHint" | "refreshPlanner">;
  onAskInChat: (message: string) => void;
  onLinkedNodeStatusChange: (nodeId: string, nextStatus: NodeStatus) => void;
  // A list row tapped: back to the graph with that node selected.
  onOpenNodeInGraph: (nodeId: string) => void;
  onToggleStatus: (nodeId: string, status: Node["status"]) => void;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {appMode === "graph" ? (
        <motion.div
          key="graph"
          className="flex min-w-0 flex-1"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          {graphStage}
        </motion.div>
      ) : appMode === "assistant" ? (
        <motion.div
          key="assistant"
          className="flex min-w-0 flex-1"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          <AssistantModeView
            graphData={graphData}
            selectedNodeId={selectedNodeId}
            workspaceId={workspaceId}
            tasksRefreshKey={planner.plannerRefreshKey}
            draftPlanRefreshKey={planner.draftPlanRefreshKey}
            draftPlanHint={planner.draftPlanHint}
            onAskInChat={onAskInChat}
            onLinkedNodeStatusChange={onLinkedNodeStatusChange}
            onNodeStatusChange={onToggleStatus}
          />
        </motion.div>
      ) : appMode === "todos" ? (
        <motion.div
          key="todos"
          className="flex min-w-0 flex-1 lists-bg"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          <SectionBackdrop kind="todos" />
          <TodosView graphData={graphData} onSelectNode={onOpenNodeInGraph} onToggleStatus={onToggleStatus} />
        </motion.div>
      ) : appMode === "habits" ? (
        <motion.div
          key="habits"
          className="flex min-w-0 flex-1 lists-bg"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          <SectionBackdrop kind="habits" />
          <HabitsView graphData={graphData} onSelectNode={onOpenNodeInGraph} onPlannerInvalidate={planner.refreshPlanner} />
        </motion.div>
      ) : (
        <motion.div
          key="roadmap"
          className="flex min-w-0 flex-1 lists-bg"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          <SectionBackdrop kind="roadmap" />
          <RoadmapView graphData={graphData} onSelectNode={onOpenNodeInGraph} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
