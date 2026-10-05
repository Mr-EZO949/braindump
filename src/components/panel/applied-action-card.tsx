// A change chat already made (update_priorities): what moved, with an Undo.
// Rendered under the assistant bubble when the stream carries a
// <<BRAINDUMP_APPLIED>> marker (lib/chat/applied-marker). Replaces the old
// Accept/Reject gate for priority changes — they're fully reversible, so the
// safety net is after the fact instead of in the way.

import { isPlanAction, isPreferenceAction, isScheduleAction } from "@/lib/chat/applied-marker";
import { PRIORITY_ACTION_GLYPH, type PriorityAction } from "@/lib/graph/priority-changes";
import { COMMITMENT_ACTION_GLYPH, type CommitmentAction } from "@/lib/planner/commitment-changes";
import type { AppliedAction, AppliedActionItem } from "@/types/chat";

interface AppliedActionCardProps {
  action: AppliedAction;
  onUndo: () => void;
  // Inside the brain-dump turn card: a section of that card, not a card of
  // its own, under the heading the turn card uses for it.
  embedded?: boolean;
  heading?: string;
}

// Actions that push a node up get the brand accent; the rest stay quiet.
const RAISING = new Set(["focus", "resume", "deadline"]);
// A finished or dropped node leaves the ranking — its score delta means nothing.
const LEAVING = new Set(["complete", "drop"]);
// replan_today rows (lib/planner/plan-replace.ts replanCardRows).
const PLAN_GLYPH: Record<string, string> = { kept: "◷", moved: "→", missed: "✕", unplanned: "–" };

function Delta({ item }: { item: AppliedActionItem }) {
  if (LEAVING.has(item.action) || item.scoreBefore === null || item.scoreAfter === null) return null;
  const diff = Math.round(item.scoreAfter - item.scoreBefore);
  if (Math.abs(diff) < 2) return null;
  const up = diff > 0;
  return (
    <span
      className={`applied-card-delta ${up ? "applied-card-delta--up" : "applied-card-delta--down"}`}
      title={`Importance ${Math.round(item.scoreBefore)} → ${Math.round(item.scoreAfter)}`}
    >
      {up ? "↑" : "↓"} {Math.abs(diff)}
    </span>
  );
}

export function AppliedActionCard({ action, onUndo, embedded, heading: headingOverride }: AppliedActionCardProps) {
  const { status } = action;
  const undone = status === "undone";
  const canUndo = status === "applied" || status === "error";
  // set_commitments / set_preferences: a schedule change — same card, its own words and glyphs.
  const schedule = isScheduleAction(action);
  // replan_today: today's plan rebuilt from now — Undo goes back to the earlier plan.
  const plan = isPlanAction(action);
  const heading =
    headingOverride ??
    (plan
      ? "Rest of today replanned"
      : isPreferenceAction(action)
        ? "Saved for your plans"
        : schedule
          ? "Schedule saved"
          : "Priorities updated");

  return (
    <div
      className={`applied-card${embedded ? " applied-card--embedded" : ""}${undone ? " applied-card--undone" : ""}`}
      role="group"
      aria-label={undone ? "Change undone" : heading}
    >
      <div className="applied-card-head">
        <span className="applied-card-mark" aria-hidden="true">
          {undone ? "↺" : "✓"}
        </span>
        <span className="applied-card-title">
          {undone ? (plan ? "Undone — back to the earlier plan" : "Undone — back to how it was") : heading}
        </span>
        {canUndo ? (
          <button className="applied-card-undo" onClick={onUndo} type="button">
            Undo
          </button>
        ) : status === "undoing" ? (
          <span className="applied-card-busy">Undoing…</span>
        ) : null}
      </div>

      <ul className="applied-card-list">
        {action.items.map((item, index) => {
          const glyph = plan
            ? (PLAN_GLYPH[item.action] ?? "◷")
            : schedule
              ? (COMMITMENT_ACTION_GLYPH[item.action as CommitmentAction] ?? "◷")
              : (PRIORITY_ACTION_GLYPH[item.action as PriorityAction] ?? "•");
          const raises = plan
            ? item.action === "moved"
            : schedule
            ? item.action === "add"
            : item.action === "stakes"
              ? item.detail === "High stakes"
              : RAISING.has(item.action);
          const tone = raises ? "raise" : "quiet";
          return (
            <li
              className="applied-card-row"
              key={`${item.nodeId}-${item.action}-${index}`}
              style={{ animationDelay: `${index * 45}ms` }}
            >
              <span className={`applied-card-glyph applied-card-glyph--${tone}`} aria-hidden="true">
                {glyph}
              </span>
              <span className="applied-card-text">
                <span className="applied-card-name">{item.title}</span>
                <span className="applied-card-detail">{item.detail}</span>
              </span>
              {undone ? null : <Delta item={item} />}
            </li>
          );
        })}
      </ul>

      {action.failed.length > 0 ? (
        <p className="applied-card-note">
          Couldn&apos;t change: {action.failed.map((f) => f.title).join(", ")}
        </p>
      ) : null}
      {status === "error" ? (
        <p className="applied-card-note applied-card-note--error">
          {action.errorMessage ?? "Couldn't undo that — try again."}
        </p>
      ) : null}
    </div>
  );
}
