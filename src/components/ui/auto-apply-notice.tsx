"use client";

import { useEffect } from "react";

// "Added N items to your graph · Undo" — shown after calibrated auto-apply
// (src/lib/ai/auto-apply.ts) accepts a dump's confident proposals without the
// review modal. Undo is one tap; the notice gets out of the way on its own.
const AUTO_DISMISS_MS = 20_000;

export function AutoApplyNotice({
  count,
  onUndo,
  onDismiss,
}: {
  count: number;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="auto-apply-notice" role="status" aria-live="polite">
      <span className="auto-apply-notice-check" aria-hidden="true">
        ✓
      </span>
      <span className="auto-apply-notice-text">
        Added {count} item{count === 1 ? "" : "s"} to your graph
      </span>
      <button type="button" className="auto-apply-notice-undo" onClick={onUndo}>
        Undo
      </button>
      <button
        type="button"
        className="auto-apply-notice-close"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
