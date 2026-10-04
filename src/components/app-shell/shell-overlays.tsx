"use client";

// What floats over the shell: the proposal review and step-picker modals, the
// reanalyze-everything confirm, the status chips (auto-apply Undo, generating
// steps, reading a dump / finding links), the analysis notice, and the
// anti-freeze nudge. Each keeps its own AnimatePresence so exits animate.

import { AnimatePresence, motion } from "framer-motion";

import { AutoApplyNotice } from "@/components/ui/auto-apply-notice";
import { ProposedNodesReview } from "@/components/ui/proposed-nodes-review";
import type { AINotice } from "@/lib/graph/connection-analysis";

import type { ProposalReview } from "./use-proposal-review";
import type { StepSuggestions } from "./use-step-suggestions";

/** Proposed nodes review — centered modal. */
export function ProposalReviewModal({
  proposals,
  existingNodeTitles,
}: {
  proposals: ProposalReview;
  existingNodeTitles: Record<string, string>;
}) {
  return (
    <AnimatePresence>
      {proposals.proposedReviewOpen &&
        (proposals.proposedNodes.length > 0 || proposals.clarifyingQuestions.length > 0) && (
          <motion.div
            key="prn-backdrop"
            className="fixed inset-0 z-60 flex items-center justify-center"
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <ProposedNodesReview
              existingNodeTitles={existingNodeTitles}
              proposals={proposals.proposedNodes}
              suggestedAreas={proposals.suggestedAreas}
              onAddAreas={proposals.addAreas}
              onAccept={proposals.acceptProposals}
              onClose={proposals.requestCloseReview}
              submitting={proposals.proposedNodesSubmitting}
              clarifyingQuestions={proposals.clarifyingQuestions}
              onAnswerInline={proposals.answerInline}
            />
          </motion.div>
        )}
    </AnimatePresence>
  );
}

/** Step suggestion prompt — shown after accepting goals/projects, or from the nudge. */
export function StepSuggestModal({ steps }: { steps: StepSuggestions }) {
  const { stepSuggestionNodes } = steps;
  return (
    <AnimatePresence>
      {steps.stepSuggestionOpen && stepSuggestionNodes.length > 0 && (
        <motion.div
          key="step-suggest-backdrop"
          className="fixed inset-0 z-60 flex items-center justify-center"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ background: "rgba(0,0,0,0.45)" }}
        >
          <motion.div
            className="step-suggest-modal"
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            initial={{ opacity: 0, y: 16, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="step-suggest-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
            <div className="step-suggest-body">
              <p className="step-suggest-title">Break these into steps?</p>
              <p className="step-suggest-desc">
                Pick which to map out — skip any you&rsquo;re not ready for.
              </p>
              <div className="step-suggest-checklist">
                {stepSuggestionNodes.map((n) => (
                  <label className="step-suggest-check" key={n.id}>
                    <input type="checkbox" checked={n.selected} onChange={() => steps.toggleStepNode(n.id)} />
                    <span>{n.title}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="step-suggest-actions">
              <button className="per-btn-ghost" onClick={steps.dismissStepSuggestion} type="button">
                Skip
              </button>
              <button
                className="per-btn-primary"
                onClick={() => void steps.generateSteps()}
                disabled={stepSuggestionNodes.every((n) => !n.selected)}
                type="button"
              >
                {(() => {
                  const c = stepSuggestionNodes.filter((n) => n.selected).length;
                  return c === stepSuggestionNodes.length || c === 0 ? "Generate steps" : `Generate steps (${c})`;
                })()}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Full-graph reconnect confirmation. */
export function FindAllConfirmModal({
  open,
  nodeCount,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  nodeCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="find-all-backdrop"
          className="fixed inset-0 z-60 flex items-center justify-center"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={onCancel}
        >
          <motion.div
            className="step-suggest-modal"
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            initial={{ opacity: 0, y: 16, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="step-suggest-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
            </div>
            <div className="step-suggest-body">
              <p className="step-suggest-title">Reanalyze the entire graph?</p>
              <p className="step-suggest-desc">
                This will run connection analysis across all{" "}
                <strong>{nodeCount}</strong> nodes in this
                workspace. It can take a while and uses AI credits. New
                connections will be proposed for you to review.
              </p>
            </div>
            <div className="step-suggest-actions">
              <button className="per-btn-ghost" onClick={onCancel} type="button">
                Cancel
              </button>
              <button className="per-btn-primary" onClick={onConfirm} type="button">
                Reanalyze all
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The auto-apply Undo notice and the "Generating steps…" chip (with Cancel). */
export function WorkChips({
  autoApplyCount,
  onUndoAutoApply,
  onDismissAutoApply,
  generatingSteps,
  onCancelSteps,
}: {
  autoApplyCount: number | null;
  onUndoAutoApply: () => void;
  onDismissAutoApply: () => void;
  generatingSteps: boolean;
  onCancelSteps: () => void;
}) {
  return (
    <AnimatePresence>
      {autoApplyCount !== null ? (
        <AutoApplyNotice key="auto-apply" count={autoApplyCount} onUndo={onUndoAutoApply} onDismiss={onDismissAutoApply} />
      ) : null}
      {generatingSteps && (
        <motion.div
          key="step-loading"
          className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2"
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          initial={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
        >
          <div className="ai-status-chip">
            <span className="ai-status-spinner" />
            Generating steps…
            <button type="button" className="ai-status-cancel" onClick={onCancelSteps}>
              Cancel
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * AI status chip — shown during extraction and connection analysis. Not over
 * the open Brain Dump box: it shows its own progress.
 */
export function AiStatusChip({ show, readingDump }: { show: boolean; readingDump: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="ai-status"
          className="ai-status-chip"
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          initial={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
        >
          <span className="ai-status-spinner" aria-hidden="true" />
          <span className="ai-status-text">
            {readingDump ? "Reading your dump & building your graph…" : "Finding connections…"}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A connection-analysis warning or error, with a retry when it applies here. */
export function AiNoticeBar({
  notice,
  canRetry,
  onRetry,
  onDismiss,
}: {
  notice: AINotice | null;
  canRetry: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          key={`${notice.tone}:${notice.message}`}
          className={`ai-notice ai-notice--${notice.tone}`}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          initial={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.15 }}
        >
          <span>{notice.message}</span>
          <div className="ai-notice-actions">
            {canRetry ? (
              <button className="ai-notice-action" onClick={onRetry} type="button">
                Find connections
              </button>
            ) : null}
            <button className="ai-notice-dismiss" onClick={onDismiss} type="button">
              Dismiss
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * On-load anti-freeze nudge — proactively surface nodes ready for a next
 * step, opening the SELECTIVE picker so it's never a wall.
 */
export function FreezeNudgeBar({
  count,
  onMapOut,
  onDismiss,
}: {
  count: number;
  onMapOut: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="freeze-nudge" role="status">
      <span className="freeze-nudge-text">
        {count === 1 ? "1 item looks ready for a next step." : `${count} items look ready for a next step.`}
      </span>
      <div className="freeze-nudge-actions">
        <button className="freeze-nudge-btn" type="button" onClick={onMapOut}>
          Pick what to map out
        </button>
        <button className="freeze-nudge-dismiss" type="button" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
