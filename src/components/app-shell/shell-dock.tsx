"use client";

// The bottom of the screen: the mode dock, or the Brain Dump box in its place
// while a dump is being written.

import { AnimatePresence, motion } from "framer-motion";

import { BrainDumpOverlay } from "@/components/ui/brain-dump-overlay";
import { ModeDock, type AppMode } from "@/components/ui/mode-dock";

import type { BrainDump } from "./use-brain-dump";

export function DumpBoxOrDock({
  dump,
  appMode,
  onSetMode,
  onOpenWhatNow,
  focusGlow,
}: {
  dump: BrainDump;
  appMode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onOpenWhatNow: () => void;
  focusGlow: boolean;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {dump.brainDumpOpen ? (
        <motion.div
          key="brain-dump"
          className="brain-dump-anchor fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <BrainDumpOverlay
            errorMessage={dump.brainDumpError}
            onChange={dump.setBrainDumpValue}
            onClose={dump.closeBrainDump}
            onRetry={() => void dump.retryBrainDump()}
            onSubmit={() => void dump.submitBrainDump()}
            retryAvailable={Boolean(dump.brainDumpFailedEntryId)}
            retrying={dump.brainDumpRetrying}
            submitting={dump.brainDumpSubmitting}
            progress={dump.dumpProgress}
            value={dump.brainDumpValue}
          />
        </motion.div>
      ) : (
        <motion.div
          key="dock"
          className="mode-dock-anchor fixed bottom-6 left-1/2 z-40 -translate-x-1/2"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <ModeDock
            mode={appMode}
            onSetMode={onSetMode}
            onOpenBrainDump={dump.openBrainDump}
            onOpenWhatNow={onOpenWhatNow}
            focusGlow={focusGlow}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
