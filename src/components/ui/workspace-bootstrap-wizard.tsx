"use client";

import { useState } from "react";

import {
  ChevronDownIcon,
  CloseIcon,
  GripVerticalIcon,
  PlusIcon,
} from "@/components/ui/icons";
import type { WorkspaceProfileAreaType } from "@/types/graph";

interface GoalRow {
  id: string;
  title: string;
}

interface AreaRow {
  id: string;
  title: string;
  area_type: WorkspaceProfileAreaType;
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  onComplete: () => void;
  onSkip: () => void;
}

const MAX_GOALS = 4;
const MAX_AREAS = 6;

const ROOT_SUGGESTIONS = [
  "Run my semester with clarity",
  "Build a personal operating system",
  "Finish my thesis with momentum",
  "Create a career growth engine",
];

const GOAL_SUGGESTIONS = [
  "Personal success",
  "High-performing student",
  "Turn projects into shipped outcomes",
  "Stay consistent without burnout",
];

const AREA_TYPE_OPTIONS: Array<{
  description: string;
  label: string;
  value: WorkspaceProfileAreaType;
}> = [
  { value: "academic", label: "Academic", description: "Courses, studying, research" },
  { value: "project", label: "Project", description: "Builds, launches, execution" },
  { value: "career", label: "Career", description: "Jobs, portfolio, networking" },
  { value: "health", label: "Health", description: "Energy, fitness, recovery" },
  { value: "life_admin", label: "Life admin", description: "Logistics, planning, upkeep" },
  { value: "personal", label: "Personal", description: "Identity, habits, relationships" },
];

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getAreaTypeLabel(areaType: WorkspaceProfileAreaType) {
  return AREA_TYPE_OPTIONS.find((option) => option.value === areaType)?.label ?? areaType;
}

function formatSummary(rootCount: number, goalCount: number, areaCount: number) {
  const parts = [
    `${rootCount} root`,
    `${goalCount} goal${goalCount === 1 ? "" : "s"}`,
    `${areaCount} area${areaCount === 1 ? "" : "s"}`,
  ];

  return parts.join(" · ");
}

export function WorkspaceBootstrapWizard({
  workspaceId,
  workspaceName,
  onComplete,
  onSkip,
}: Props) {
  const [step, setStep] = useState(0);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [role, setRole] = useState("");
  const [successTitle, setSuccessTitle] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [areaDraftTitle, setAreaDraftTitle] = useState("");
  const [areaDraftType, setAreaDraftType] = useState<WorkspaceProfileAreaType>("project");
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedSuccessTitle = successTitle.trim();
  const trimmedRole = role.trim();
  const trimmedGoalDraft = goalDraft.trim();
  const trimmedAreaDraftTitle = areaDraftTitle.trim();
  const canProceed = Boolean(trimmedSuccessTitle);
  const canAddGoal =
    Boolean(trimmedGoalDraft) &&
    goals.length < MAX_GOALS &&
    !goals.some((goal) => goal.title.toLowerCase() === trimmedGoalDraft.toLowerCase());
  const canAddArea =
    Boolean(trimmedAreaDraftTitle) &&
    areas.length < MAX_AREAS &&
    !areas.some((area) => area.title.toLowerCase() === trimmedAreaDraftTitle.toLowerCase());
  const totalNodeCount = 1 + goals.length + areas.length;
  const progressWidth = `${step === 0 ? 50 : 100}%`;
  const creationSummary = formatSummary(1, goals.length, areas.length);

  function addGoalFromValue(value: string) {
    const trimmedValue = value.trim();
    if (
      !trimmedValue ||
      goals.length >= MAX_GOALS ||
      goals.some((goal) => goal.title.toLowerCase() === trimmedValue.toLowerCase())
    ) {
      return;
    }

    setGoals((currentGoals) => [
      ...currentGoals,
      { id: createId("goal"), title: trimmedValue },
    ]);
  }

  function addGoal() {
    if (!canAddGoal) {
      return;
    }

    addGoalFromValue(trimmedGoalDraft);
    setGoalDraft("");
  }

  function removeGoal(goalId: string) {
    setGoals((currentGoals) => currentGoals.filter((goal) => goal.id !== goalId));
  }

  function addArea() {
    if (!canAddArea) {
      return;
    }

    setAreas((currentAreas) => [
      ...currentAreas,
      {
        id: createId("area"),
        title: trimmedAreaDraftTitle,
        area_type: areaDraftType,
      },
    ]);
    setAreaDraftTitle("");
  }

  function removeArea(areaId: string) {
    setAreas((currentAreas) => currentAreas.filter((area) => area.id !== areaId));
  }

  function requestCancel() {
    if (submitting) {
      return;
    }

    setShowCancelConfirm(true);
  }

  function dismissCancelConfirm() {
    if (submitting) {
      return;
    }

    setShowCancelConfirm(false);
  }

  function confirmCancel() {
    if (submitting) {
      return;
    }

    setShowCancelConfirm(false);
    onSkip();
  }

  async function handleSubmit() {
    if (!trimmedSuccessTitle || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: trimmedRole || null,
          current_focus: null,
          success_title: trimmedSuccessTitle,
          goals: goals.map((goal) => ({ title: goal.title })),
          areas: areas.map((area) => ({ title: area.title, area_type: area.area_type })),
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
      <div className="bootstrap-modal">
        <div className="bootstrap-atmosphere" aria-hidden="true" />

        <header className="bootstrap-header">
          <div className="bootstrap-heading-block">
            <span className="bootstrap-eyebrow">Workspace foundation</span>
            <h2 className="bootstrap-heading">
              {step === 0
                ? "Define the structure this workspace should grow from."
                : "Review the structure before the graph is created."}
            </h2>
          </div>

          <div className="bootstrap-progress">
            <div className="bootstrap-progress-copy">
              <span className="bootstrap-progress-step">Step {step + 1} of 2</span>
              <span className="bootstrap-progress-workspace">{workspaceName}</span>
            </div>
            <div className="bootstrap-progress-track">
              <span className="bootstrap-progress-fill" style={{ width: progressWidth }} />
            </div>
          </div>
        </header>

        {step === 0 ? (
          <div className="bootstrap-body">
            <section className="bootstrap-root-section">
              <div className="bootstrap-section-head">
                <div className="bootstrap-section-copy">
                  <span className="bootstrap-section-kicker">Root outcome</span>
                  <h3 className="bootstrap-section-title">
                    What should this workspace make easier to achieve?
                  </h3>
                </div>
              </div>

              <div className="bootstrap-field-stack">
                <label className="bootstrap-field-label" htmlFor="bootstrap-root">
                  Root outcome
                </label>
                <div
                  className="bootstrap-root-field"
                  data-filled={trimmedSuccessTitle ? "true" : "false"}
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
              </div>

              <div className="bootstrap-suggestion-list" role="list" aria-label="Root outcome examples">
                {ROOT_SUGGESTIONS.map((suggestion) => {
                  const active = suggestion.toLowerCase() === trimmedSuccessTitle.toLowerCase();

                  return (
                    <button
                      className="bootstrap-suggestion-chip"
                      data-active={active ? "true" : "false"}
                      key={suggestion}
                      onClick={() => setSuccessTitle(suggestion)}
                      type="button"
                    >
                      {suggestion}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="bootstrap-section">
              <div className="bootstrap-section-head">
                <div className="bootstrap-section-copy">
                  <span className="bootstrap-section-kicker">Context</span>
                  <h3 className="bootstrap-section-title">
                    Ground the workspace in who you are and what matters next.
                  </h3>
                </div>
              </div>

              <div className="bootstrap-field-stack">
                <div className="bootstrap-field-head">
                  <label className="bootstrap-field-label" htmlFor="bootstrap-role">
                    Who are you?
                  </label>
                  <span className="bootstrap-field-meta">Optional</span>
                </div>
                <div className="bootstrap-field" data-filled={trimmedRole ? "true" : "false"}>
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

              <div className="bootstrap-field-stack">
                <div className="bootstrap-field-head">
                  <div className="bootstrap-field-head-copy">
                    <label className="bootstrap-field-label" htmlFor="bootstrap-goal-draft">
                      Big goals
                    </label>
                  </div>
                  <span className="bootstrap-field-count">
                    {goals.length}/{MAX_GOALS}
                  </span>
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
                      placeholder="Add a goal"
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
                    <span>Add goal</span>
                  </button>
                </div>

                <div className="bootstrap-goal-chip-list">
                  {goals.length > 0 ? (
                    goals.map((goal) => (
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
                    ))
                  ) : (
                    <p className="bootstrap-empty-copy">No goals added yet.</p>
                  )}
                </div>

                <div className="bootstrap-inline-suggestions">
                  {GOAL_SUGGESTIONS.map((suggestion) => (
                    <button
                      className="bootstrap-inline-chip"
                      key={suggestion}
                      onClick={() => addGoalFromValue(suggestion)}
                      type="button"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="bootstrap-section">
              <div className="bootstrap-section-head">
                <div className="bootstrap-section-copy">
                  <span className="bootstrap-section-kicker">Active areas</span>
                  <h3 className="bootstrap-section-title">
                    Define the first lanes this workspace should organize.
                  </h3>
                </div>
                <span className="bootstrap-section-count">{areas.length}</span>
              </div>

              <div className="bootstrap-field-stack">
                <div className="bootstrap-field-head">
                  <label className="bootstrap-field-label" htmlFor="bootstrap-area-draft">
                    Area builder
                  </label>
                  <span className="bootstrap-field-meta">Up to {MAX_AREAS}</span>
                </div>

                <div className="bootstrap-tool-row bootstrap-tool-row--area">
                  <div
                    className="bootstrap-tool-input"
                    data-filled={trimmedAreaDraftTitle ? "true" : "false"}
                  >
                    <input
                      id="bootstrap-area-draft"
                      className="bootstrap-tool-input-field"
                      type="text"
                      placeholder="Area name"
                      value={areaDraftTitle}
                      onChange={(e) => setAreaDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addArea();
                        }
                      }}
                      maxLength={80}
                      autoComplete="off"
                    />
                  </div>

                  <div className="bootstrap-select-shell">
                    <select
                      className="bootstrap-select"
                      value={areaDraftType}
                      onChange={(e) =>
                        setAreaDraftType(e.target.value as WorkspaceProfileAreaType)
                      }
                    >
                      {AREA_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon className="bootstrap-select-icon h-[13px] w-[13px]" />
                  </div>

                  <button
                    className="bootstrap-tool-action bootstrap-tool-action--primary"
                    disabled={!canAddArea}
                    onClick={addArea}
                    type="button"
                  >
                    <PlusIcon className="h-[13px] w-[13px]" />
                    <span>Add area</span>
                  </button>
                </div>
              </div>

              <div className="bootstrap-area-list">
                {areas.length > 0 ? (
                  areas.map((area) => (
                    <div className="bootstrap-area-row" key={area.id}>
                      <span className="bootstrap-area-handle" aria-hidden="true">
                        <GripVerticalIcon className="h-[13px] w-[13px]" />
                      </span>
                      <div className="bootstrap-area-row-copy">
                        <span className="bootstrap-area-name">{area.title}</span>
                        <span className="bootstrap-area-description">
                          {
                            AREA_TYPE_OPTIONS.find((option) => option.value === area.area_type)
                              ?.description
                          }
                        </span>
                      </div>
                      <span className="bootstrap-area-badge">{getAreaTypeLabel(area.area_type)}</span>
                      <button
                        aria-label={`Remove ${area.title}`}
                        className="bootstrap-area-remove"
                        onClick={() => removeArea(area.id)}
                        type="button"
                      >
                        <CloseIcon className="h-[11px] w-[11px]" />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="bootstrap-empty-state">
                    <p className="bootstrap-empty-copy">No areas added yet.</p>
                  </div>
                )}
              </div>
            </section>

            {error ? <p className="bootstrap-error">{error}</p> : null}
          </div>
        ) : (
          <div className="bootstrap-body">
            <section className="bootstrap-review-hero">
              <span className="bootstrap-section-kicker">Workspace preview</span>
              <h3 className="bootstrap-review-title">{trimmedSuccessTitle}</h3>
              <div className="bootstrap-review-meta">
                {trimmedRole ? (
                  <span className="bootstrap-review-meta-item">{trimmedRole}</span>
                ) : null}
                <span className="bootstrap-review-meta-item">{creationSummary}</span>
                <span className="bootstrap-review-meta-item">{totalNodeCount} nodes total</span>
              </div>
            </section>

            <section className="bootstrap-review-section">
              <div className="bootstrap-section-head">
                <div className="bootstrap-section-copy">
                  <span className="bootstrap-section-kicker">Goals</span>
                  <h3 className="bootstrap-section-title">What the workspace will keep in view.</h3>
                </div>
                <span className="bootstrap-section-count">{goals.length}</span>
              </div>

              <div className="bootstrap-review-list">
                {goals.length > 0 ? (
                  goals.map((goal) => (
                    <div className="bootstrap-review-row" key={goal.id}>
                      <span className="bootstrap-review-row-index" aria-hidden="true" />
                      <span className="bootstrap-review-row-title">{goal.title}</span>
                    </div>
                  ))
                ) : (
                  <div className="bootstrap-empty-state">
                    <p className="bootstrap-empty-copy">No goals added to this setup.</p>
                  </div>
                )}
              </div>
            </section>

            <section className="bootstrap-review-section">
              <div className="bootstrap-section-head">
                <div className="bootstrap-section-copy">
                  <span className="bootstrap-section-kicker">Areas</span>
                  <h3 className="bootstrap-section-title">
                    The first structural lanes the graph will branch into.
                  </h3>
                </div>
                <span className="bootstrap-section-count">{areas.length}</span>
              </div>

              <div className="bootstrap-review-list">
                {areas.length > 0 ? (
                  areas.map((area) => (
                    <div className="bootstrap-review-row" key={area.id}>
                      <span className="bootstrap-review-row-index" aria-hidden="true" />
                      <span className="bootstrap-review-row-title">{area.title}</span>
                      <span className="bootstrap-area-badge">{getAreaTypeLabel(area.area_type)}</span>
                    </div>
                  ))
                ) : (
                  <div className="bootstrap-empty-state">
                    <p className="bootstrap-empty-copy">No areas added to this setup.</p>
                  </div>
                )}
              </div>
            </section>

            {error ? <p className="bootstrap-error">{error}</p> : null}
          </div>
        )}

        <footer className="bootstrap-footer">
          <button className="bootstrap-cancel" onClick={requestCancel} type="button">
            Cancel
          </button>

          <div className="bootstrap-footer-actions">
            {step === 1 ? (
              <button className="bootstrap-back" onClick={() => setStep(0)} type="button">
                Back
              </button>
            ) : null}

            <button
              className="bootstrap-submit"
              disabled={step === 0 ? !canProceed : submitting}
              onClick={step === 0 ? () => setStep(1) : handleSubmit}
              type="button"
            >
              {step === 0 ? "Review structure" : submitting ? "Creating…" : "Create workspace"}
            </button>
          </div>
        </footer>

        {showCancelConfirm ? (
          <div className="bootstrap-confirm-overlay">
            <div
              aria-labelledby="bootstrap-cancel-title"
              aria-modal="true"
              className="bootstrap-confirm-card"
              role="dialog"
            >
              <span className="bootstrap-confirm-kicker">Cancel setup</span>
              <h3 className="bootstrap-confirm-heading" id="bootstrap-cancel-title">
                Discard this workspace?
              </h3>
              <p className="bootstrap-confirm-copy">
                Confirming this will remove the new workspace instead of keeping it empty.
              </p>
              <div className="bootstrap-confirm-actions">
                <button className="bootstrap-back" onClick={dismissCancelConfirm} type="button">
                  Keep editing
                </button>
                <button
                  className="bootstrap-confirm-submit"
                  onClick={confirmCancel}
                  type="button"
                >
                  Discard workspace
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
