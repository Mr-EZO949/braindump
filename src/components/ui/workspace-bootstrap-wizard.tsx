"use client";

import { useState } from "react";

import { CloseIcon, PlusIcon } from "@/components/ui/icons";

interface GoalRow {
  id: string;
  title: string;
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  onComplete: () => void;
  onSkip: () => void;
  isOnboarding?: boolean;
}

const MAX_GOALS = 4;

const FOCUS_SUGGESTIONS = [
  "Personal success",
  "Finish my degree strong",
  "Financial independence",
  "Ship a side project",
];

const GOAL_SUGGESTIONS = [
  "Academic success",
  "Money independence",
  "Stay consistent",
  "Build good habits",
];

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function WorkspaceBootstrapWizard({
  workspaceId,
  workspaceName,
  onComplete,
  onSkip,
  isOnboarding = false,
}: Props) {
  const [step, setStep] = useState(0);
  const [successTitle, setSuccessTitle] = useState("");
  const [role, setRole] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const trimmed = successTitle.trim();
  const trimmedRole = role.trim();
  const trimmedGoalDraft = goalDraft.trim();
  const canProceed = Boolean(trimmed);
  const canAddGoal =
    Boolean(trimmedGoalDraft) &&
    goals.length < MAX_GOALS &&
    !goals.some((g) => g.title.toLowerCase() === trimmedGoalDraft.toLowerCase());
  const totalNodes = 1 + goals.length;

  function addGoalFromValue(value: string) {
    const v = value.trim();
    if (!v || goals.length >= MAX_GOALS || goals.some((g) => g.title.toLowerCase() === v.toLowerCase())) return;
    setGoals((prev) => [...prev, { id: createId("goal"), title: v }]);
  }

  function addGoal() {
    if (!canAddGoal) return;
    addGoalFromValue(trimmedGoalDraft);
    setGoalDraft("");
  }

  function removeGoal(id: string) {
    setGoals((prev) => prev.filter((g) => g.id !== id));
  }

  async function handleSubmit() {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: trimmedRole || null,
          current_focus: null,
          success_title: trimmed,
          goals: goals.map((g) => ({ title: g.title })),
          areas: [],
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Setup failed");
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bootstrap-overlay">
      <div className="bootstrap-modal bootstrap-modal--compact">
        <div className="bootstrap-atmosphere" aria-hidden="true" />

        <header className="bootstrap-header">
          <div className="bootstrap-heading-block">
            <span className="bootstrap-eyebrow">
              {isOnboarding ? "Set up your workspace" : "New workspace"}
            </span>
            <h2 className="bootstrap-heading">
              {step === 0 ? "What\u0027s your main focus?" : "Looking good"}
            </h2>
            {step === 0 && (
              <p className="bootstrap-subheading">
                This becomes the root of your knowledge graph. You can always change it later.
              </p>
            )}
          </div>

          <div className="bootstrap-progress">
            <div className="bootstrap-progress-copy">
              <span className="bootstrap-progress-step">Step {step + 1} of 2</span>
              <span className="bootstrap-progress-workspace">{workspaceName}</span>
            </div>
            <div className="bootstrap-progress-track">
              <span className="bootstrap-progress-fill" style={{ width: step === 0 ? "50%" : "100%" }} />
            </div>
          </div>
        </header>

        {step === 0 ? (
          <div className="bootstrap-body bootstrap-body--padded">
            {/* Main focus input */}
            <div className="bootstrap-field-stack">
              <label className="bootstrap-field-label" htmlFor="bootstrap-root">
                Main focus
              </label>
              <div
                className="bootstrap-root-field"
                data-filled={trimmed ? "true" : "false"}
              >
                <input
                  id="bootstrap-root"
                  className="bootstrap-root-input"
                  type="text"
                  placeholder="e.g. Run my semester with clarity"
                  value={successTitle}
                  onChange={(e) => setSuccessTitle(e.target.value)}
                  maxLength={80}
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <div className="bootstrap-suggestion-list" role="list">
                {FOCUS_SUGGESTIONS.map((s) => (
                  <button
                    className="bootstrap-suggestion-chip"
                    data-active={s.toLowerCase() === trimmed.toLowerCase() ? "true" : "false"}
                    key={s}
                    onClick={() => setSuccessTitle(s)}
                    type="button"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Role field */}
            <div className="bootstrap-field-stack" style={{ marginTop: 28 }}>
              <div className="bootstrap-field-head">
                <label className="bootstrap-field-label" htmlFor="bootstrap-role">
                  Describe yourself
                </label>
                <span className="bootstrap-optional-badge">Optional</span>
              </div>
              <div
                className="bootstrap-field"
                data-filled={trimmedRole ? "true" : "false"}
              >
                <input
                  id="bootstrap-role"
                  className="bootstrap-field-input"
                  type="text"
                  placeholder="e.g. CS student balancing coursework and side projects"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  maxLength={140}
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Goals section */}
            <div className="bootstrap-field-stack" style={{ marginTop: 28 }}>
              <div className="bootstrap-field-head">
                <label className="bootstrap-field-label" htmlFor="bootstrap-goal-draft">
                  Goals
                </label>
                <div className="bootstrap-field-head-right">
                  <span className="bootstrap-optional-badge">Optional</span>
                  <span className="bootstrap-field-count">{goals.length}/{MAX_GOALS}</span>
                </div>
              </div>

              <div className="bootstrap-tool-row bootstrap-tool-row--goal">
                <div
                  className="bootstrap-tool-input"
                  data-filled={trimmedGoalDraft ? "true" : "false"}
                >
                  <input
                    id="bootstrap-goal-draft"
                    className="bootstrap-tool-input-field"
                    type="text"
                    placeholder="Type a goal and press Enter"
                    value={goalDraft}
                    onChange={(e) => setGoalDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addGoal();
                      }
                    }}
                    maxLength={80}
                    autoComplete="off"
                  />
                </div>
                <button
                  className="bootstrap-tool-action"
                  disabled={!canAddGoal}
                  onClick={addGoal}
                  type="button"
                >
                  <PlusIcon className="h-[13px] w-[13px]" />
                </button>
              </div>

              {goals.length > 0 && (
                <div className="bootstrap-goal-chip-list">
                  {goals.map((goal) => (
                    <div className="bootstrap-goal-chip" key={goal.id}>
                      <span className="bootstrap-goal-chip-text">{goal.title}</span>
                      <button
                        aria-label={`Remove ${goal.title}`}
                        className="bootstrap-goal-chip-remove"
                        onClick={() => removeGoal(goal.id)}
                        type="button"
                      >
                        <CloseIcon className="h-[10px] w-[10px]" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {goals.length < MAX_GOALS && (
                <div className="bootstrap-inline-suggestions">
                  {GOAL_SUGGESTIONS
                    .filter((s) => !goals.some((g) => g.title.toLowerCase() === s.toLowerCase()))
                    .map((s) => (
                      <button
                        className="bootstrap-inline-chip"
                        key={s}
                        onClick={() => addGoalFromValue(s)}
                        type="button"
                      >
                        {s}
                      </button>
                    ))}
                </div>
              )}
            </div>

            {error ? <p className="bootstrap-error">{error}</p> : null}
          </div>
        ) : (
          /* ── Confirmation step ── */
          <div className="bootstrap-body bootstrap-body--padded">
            <section className="bootstrap-review-hero">
              <span className="bootstrap-section-kicker">Your workspace</span>
              <h3 className="bootstrap-review-title">{trimmed}</h3>
              <div className="bootstrap-review-meta">
                {trimmedRole && (
                  <span className="bootstrap-review-meta-item">{trimmedRole}</span>
                )}
                <span className="bootstrap-review-meta-item">
                  {totalNodes} node{totalNodes !== 1 ? "s" : ""} will be created
                </span>
              </div>
            </section>

            {goals.length > 0 && (
              <section className="bootstrap-review-section">
                <div className="bootstrap-section-head">
                  <div className="bootstrap-section-copy">
                    <span className="bootstrap-section-kicker">Goals</span>
                  </div>
                  <span className="bootstrap-section-count">{goals.length}</span>
                </div>
                <div className="bootstrap-review-list">
                  {goals.map((goal) => (
                    <div className="bootstrap-review-row" key={goal.id}>
                      <span className="bootstrap-review-row-index" aria-hidden="true" />
                      <span className="bootstrap-review-row-title">{goal.title}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {error ? <p className="bootstrap-error">{error}</p> : null}
          </div>
        )}

        <footer className="bootstrap-footer">
          <button
            className="bootstrap-cancel"
            onClick={() => setShowCancelConfirm(true)}
            type="button"
          >
            {isOnboarding ? "Skip" : "Cancel"}
          </button>

          <div className="bootstrap-footer-actions">
            {step === 1 && (
              <button className="bootstrap-back" onClick={() => setStep(0)} type="button">
                Back
              </button>
            )}

            <button
              className="bootstrap-submit"
              disabled={step === 0 ? !canProceed : submitting}
              onClick={step === 0 ? () => setStep(1) : handleSubmit}
              type="button"
            >
              {step === 0
                ? "Review"
                : submitting
                  ? "Creating..."
                  : "Create workspace"}
            </button>
          </div>
        </footer>

        {showCancelConfirm && (
          <div className="bootstrap-confirm-overlay">
            <div
              aria-labelledby="bootstrap-cancel-title"
              aria-modal="true"
              className="bootstrap-confirm-card"
              role="dialog"
            >
              <span className="bootstrap-confirm-kicker">Cancel setup</span>
              <h3 className="bootstrap-confirm-heading" id="bootstrap-cancel-title">
                {isOnboarding ? "Skip workspace setup?" : "Discard this workspace?"}
              </h3>
              <p className="bootstrap-confirm-copy">
                {isOnboarding
                  ? "You can always set up your workspace later."
                  : "This workspace won\u0027t be saved."}
              </p>
              <div className="bootstrap-confirm-actions">
                <button
                  className="bootstrap-back"
                  onClick={() => setShowCancelConfirm(false)}
                  type="button"
                >
                  Keep editing
                </button>
                <button
                  className="bootstrap-confirm-submit"
                  onClick={() => {
                    setShowCancelConfirm(false);
                    onSkip();
                  }}
                  type="button"
                >
                  {isOnboarding ? "Skip for now" : "Discard workspace"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
