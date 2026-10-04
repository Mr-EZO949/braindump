"use client";

// The dock's dialogs: the weekly reflection, dump history, and Focus — the
// "I'm stuck, tell me what to do" entry point.

import type { ComponentProps } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { DumpHistoryModal } from "@/components/ui/dump-history-modal";
import { WeeklyReflectionModal } from "@/components/ui/weekly-reflection-modal";
import { WhatNowDialog } from "@/components/ui/what-now-dialog";

import type { useShellDialogs } from "./use-shell-ui";

type WhatNowProps = ComponentProps<typeof WhatNowDialog>;

export function ShellDialogs({
  dialogs,
  workspaceId,
  workspaceName,
  userId,
  graphSignature,
  contextFor,
  onFocusNode,
  onScheduledToPlanner,
  onCheckBack,
  onGraphChanged,
  onSelectNudge,
}: {
  dialogs: ReturnType<typeof useShellDialogs>;
  workspaceId: string | null;
  workspaceName: string;
  userId: string | null;
  graphSignature: string;
  contextFor: WhatNowProps["contextFor"];
  onFocusNode: WhatNowProps["onFocusNode"];
  onScheduledToPlanner: WhatNowProps["onScheduledToPlanner"];
  onCheckBack: WhatNowProps["onCheckBack"];
  onGraphChanged: WhatNowProps["onGraphChanged"];
  onSelectNudge: WhatNowProps["onSelectNudge"];
}) {
  return (
    <>
      <AnimatePresence>
        {dialogs.weeklyReflectionOpen && workspaceId ? (
          <WeeklyReflectionModal
            key="weekly-reflection"
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            onClose={() => dialogs.setWeeklyReflectionOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {dialogs.dumpHistoryOpen && workspaceId ? (
          <DumpHistoryModal key="dump-history" workspaceId={workspaceId} onClose={() => dialogs.setDumpHistoryOpen(false)} />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {dialogs.whatNowOpen ? (
          <motion.div
            key="what-now"
            className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2"
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.14 }}
          >
            <WhatNowDialog
              workspaceId={workspaceId}
              userId={userId}
              graphSignature={graphSignature}
              contextFor={contextFor}
              onClose={() => dialogs.setWhatNowOpen(false)}
              onFocusNode={onFocusNode}
              onScheduledToPlanner={onScheduledToPlanner}
              onCheckBack={onCheckBack}
              onGraphChanged={onGraphChanged}
              onSelectNudge={onSelectNudge}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
