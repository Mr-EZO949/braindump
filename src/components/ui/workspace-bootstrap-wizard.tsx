"use client";

import { useState } from "react";

import { CloseIcon, PlusIcon } from "@/components/ui/icons";
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

const AREA_TYPE_OPTIONS: Array<{ value: WorkspaceProfileAreaType; label: string }> = [
  { value: "academic", label: "Academic" },
  { value: "project", label: "Project" },
  { value: "career", label: "Career" },
  { value: "health", label: "Health" },
  { value: "life_admin", label: "Life admin" },
  { value: "personal", label: "Personal" },
];

export function WorkspaceBootstrapWizard({
  workspaceId,
  workspaceName,
  onComplete,
  onSkip,
}: Props) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [role, setRole] = useState("");
  const [successTitle, setSuccessTitle] = useState("");
  const [goals, setGoals] = useState<GoalRow[]>([
    { id: "g0", title: "" },
    { id: "g1", title: "" },
    { id: "g2", title: "" },
  ]);
  const [areas, setAreas] = useState<AreaRow[]>([{ id: "a0", title: "", area_type: "project" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validGoals = goals.filter((g) => g.title.trim());
  const validAreas = areas.filter((a) => a.title.trim());
  const trimmedSuccessTitle = successTitle.trim();
  const trimmedRole = role.trim();
  const canProceed = Boolean(trimmedSuccessTitle);
  const totalNodeCount = 1 + validGoals.length + validAreas.length;

  function goTo(nextStep: number, direction: "forward" | "back") {
    setDir(direction);
    setStep(nextStep);
  }

  function updateGoal(id: string, title: string) {
    setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, title } : g)));
  }

  function updateArea(id: string, patch: Partial<Omit<AreaRow, "id">>) {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function addArea() {
    if (areas.length >= 6) return;
    setAreas((prev) => [...prev, { id: `a${Date.now()}`, title: "", area_type: "project" }]);
  }

  function removeArea(id: string) {
    setAreas((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleSubmit() {
    if (!trimmedSuccessTitle || submitting) return;
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
          goals: validGoals.map((g) => ({ title: g.title.trim() })),
          areas: validAreas.map((a) => ({ title: a.title.trim(), area_type: a.area_type })),
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
        <div className="bootstrap-header">
          <div className="bootstrap-heading-block">
            <div className="bootstrap-topline">
              <span className="bootstrap-workspace-label">{workspaceName}</span>
            </div>
            <h2 className="bootstrap-heading">{step === 0 ? "Set up workspace" : "Review"}</h2>
          </div>
        </div>

        {step === 0 && (
          <div className="bootstrap-body" data-dir={dir === "back" ? "back" : undefined}>
            <div className="bootstrap-form-grid">
              <section className="bootstrap-panel bootstrap-panel--feature bootstrap-panel--full">
                <div className="bootstrap-panel-head">
                  <label className="bootstrap-label" htmlFor="bootstrap-root">
                    Root outcome
                  </label>
                </div>
                <div className="bootstrap-input-wrap bootstrap-input-wrap--root">
                  <input
                    id="bootstrap-root"
                    className="bootstrap-input bootstrap-input--root"
                    type="text"
                    placeholder="e.g. Launch My SaaS, Student Success, Career Growth"
                    value={successTitle}
                    onChange={(e) => setSuccessTitle(e.target.value)}
                    maxLength={80}
                    autoComplete="off"
                    autoFocus
                  />
                </div>
              </section>

              <section className="bootstrap-panel">
                <div className="bootstrap-subsection">
                  <label className="bootstrap-label" htmlFor="bootstrap-role">Who are you?</label>
                  <div className="bootstrap-input-wrap">
                    <input
                      id="bootstrap-role"
                      className="bootstrap-input"
                      type="text"
                      placeholder="e.g. CS student balancing classes and side projects"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      maxLength={140}
                      autoComplete="off"
                    />
                  </div>
                </div>

                <div className="bootstrap-subsection-divider" />

                <div className="bootstrap-subsection">
                  <label className="bootstrap-label">Big goals</label>
                  <div className="bootstrap-field-list">
                    {goals.map((g, i) => (
                      <div key={g.id} className="bootstrap-input-wrap">
                        <input
                          className="bootstrap-input"
                          type="text"
                          placeholder={
                            i === 0
                              ? "e.g. Be a high-performing student"
                              : i === 1
                                ? "e.g. Build strong habits"
                                : "e.g. Become financially independent"
                          }
                          value={g.title}
                          onChange={(e) => updateGoal(g.id, e.target.value)}
                          maxLength={80}
                          autoComplete="off"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="bootstrap-panel">
                <div className="bootstrap-panel-head">
                  <label className="bootstrap-label">Active areas</label>
                  <span className="bootstrap-panel-meta">{validAreas.length}</span>
                </div>
                <div className="bootstrap-field-list">
                  {areas.map((a) => (
                    <div key={a.id} className="bootstrap-context-row">
                      <div className="bootstrap-input-wrap bootstrap-input-context">
                        <input
                          className="bootstrap-input"
                          type="text"
                          placeholder="e.g. Stats 302, Restaurant SaaS, Health habits"
                          value={a.title}
                          onChange={(e) => updateArea(a.id, { title: e.target.value })}
                          maxLength={80}
                          autoComplete="off"
                        />
                      </div>
                      <select
                        className="bootstrap-select"
                        value={a.area_type}
                        onChange={(e) =>
                          updateArea(a.id, { area_type: e.target.value as WorkspaceProfileAreaType })
                        }
                      >
                        {AREA_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      {areas.length > 1 && (
                        <button
                          className="bootstrap-remove-btn"
                          onClick={() => removeArea(a.id)}
                          aria-label="Remove"
                          type="button"
                        >
                          <CloseIcon className="h-[12px] w-[12px]" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {areas.length < 6 && (
                  <button className="bootstrap-add-btn" onClick={addArea} type="button">
                    <PlusIcon className="h-[12px] w-[12px]" />
                    <span>Add area</span>
                  </button>
                )}
              </section>
            </div>

            {error && <p className="bootstrap-error">{error}</p>}

            <div className="bootstrap-footer">
              <button className="bootstrap-cancel" onClick={onSkip} type="button">
                Cancel
              </button>
              <button
                className="bootstrap-next"
                onClick={() => goTo(1, "forward")}
                disabled={!canProceed}
                type="button"
              >
                Review
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="bootstrap-body" data-dir={dir === "back" ? "back" : undefined}>
            <div className="bootstrap-review-shell">
              <div className="bootstrap-review-meta">
                {trimmedRole ? <span>{trimmedRole}</span> : null}
                <span>{totalNodeCount} nodes</span>
              </div>
              <div className="bootstrap-tree-root">
                <div className="bootstrap-tree-root-text">
                  <span className="bootstrap-tree-root-label">Root</span>
                  <span className="bootstrap-tree-root-title">{trimmedSuccessTitle}</span>
                </div>
              </div>

              {(validGoals.length > 0 || validAreas.length > 0) && (
                <div className="bootstrap-review-grid">
                  {validGoals.length > 0 && (
                    <section className="bootstrap-tree-section">
                      <div className="bootstrap-tree-section-head">
                        <span className="bootstrap-tree-section-label">Goals</span>
                        <span className="bootstrap-panel-meta">{validGoals.length}</span>
                      </div>
                      <div className="bootstrap-tree-items">
                        {validGoals.map((g) => (
                          <div key={g.id} className="bootstrap-tree-item">
                            <span className="bootstrap-tree-item-title">{g.title}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {validAreas.length > 0 && (
                    <section className="bootstrap-tree-section">
                      <div className="bootstrap-tree-section-head">
                        <span className="bootstrap-tree-section-label">Areas</span>
                        <span className="bootstrap-panel-meta">{validAreas.length}</span>
                      </div>
                      <div className="bootstrap-tree-items">
                        {validAreas.map((a) => (
                          <div key={a.id} className="bootstrap-tree-item">
                            <span className="bootstrap-tree-item-title">{a.title}</span>
                            <span className="bootstrap-tree-item-tag">
                              {AREA_TYPE_OPTIONS.find((o) => o.value === a.area_type)?.label}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>

            {error && <p className="bootstrap-error">{error}</p>}

            <div className="bootstrap-footer">
              <button className="bootstrap-cancel" onClick={onSkip} type="button">
                Cancel
              </button>
              <div className="bootstrap-footer-actions">
                <button
                  className="bootstrap-back"
                  onClick={() => goTo(0, "back")}
                  disabled={submitting}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="bootstrap-submit"
                  onClick={handleSubmit}
                  disabled={submitting}
                  type="button"
                >
                  {submitting ? "Setting up…" : "Create workspace"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
