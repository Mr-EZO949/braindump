"use client";

import { useState } from "react";

// First-run "about you" intake — a one-time, skippable sign-up moment that
// captures user-level identity (name, occupation, what paralyzes you, working
// hours, deadline cadence) and feeds it into every workspace's AI context.
//
// Reuses the bootstrap wizard's visual system (bootstrap-* classes) so it reads
// as one flow with the workspace setup that follows it. Shown ONCE, gated on
// profiles.intake_completed_at — both Save and Skip mark it done so it never
// re-fires. Persists via PATCH /api/profile.

interface Props {
  // Called after the intake is finished OR skipped (both mark it done).
  onDone: () => void;
}

export function AboutYouIntake({ onDone }: Props) {
  const [fullName, setFullName] = useState("");
  const [occupation, setOccupation] = useState("");
  const [paralysis, setParalysis] = useState("");
  const [workingHours, setWorkingHours] = useState("");
  const [deadlineCadence, setDeadlineCadence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patchProfile(body: Record<string, unknown>) {
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Couldn't save that");
    }
  }

  async function handleSave() {
    if (submitting || skipping) return;
    setSubmitting(true);
    setError(null);
    try {
      await patchProfile({
        full_name: fullName,
        occupation,
        paralysis_triggers: paralysis,
        working_hours: workingHours,
        deadline_cadence: deadlineCadence,
        intake_done: true,
      });
      onDone();
    } catch (err) {
      // Keep their input on screen; let them retry or skip.
      setError(err instanceof Error ? err.message : "Couldn't save that");
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (submitting || skipping) return;
    setSkipping(true);
    setError(null);
    try {
      // Best-effort: mark done so the gate won't re-fire.
      await patchProfile({ intake_done: true });
    } catch {
      // Even if persistence fails (e.g. table not migrated yet), don't trap the
      // user behind the intake — dismiss it for this session.
    } finally {
      onDone();
    }
  }

  return (
    <div className="bootstrap-overlay">
      <div className="bootstrap-modal bootstrap-modal--hero about-intake">
        <div className="bootstrap-atmosphere" aria-hidden="true" />

        <header className="bootstrap-hero-header">
          <span className="bootstrap-eyebrow">First setup · about you</span>
          <h2 className="bootstrap-hero-heading">
            Tell us about <span className="bootstrap-hero-heading-em">you</span>
          </h2>
          <p className="bootstrap-hero-sub">
            So the AI tailors how it captures, plans, and unblocks you. Skip anything &mdash; you can
            edit it later in Settings.
          </p>
        </header>

        <div className="bootstrap-hero-body">
          <div className="bootstrap-line">
            <span className="bootstrap-line-prompt">Name</span>
            <input
              className="bootstrap-line-input"
              type="text"
              placeholder="what should we call you?"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={120}
              autoComplete="name"
              autoFocus
            />
          </div>

          <div className="bootstrap-line">
            <span className="bootstrap-line-prompt">Occupation</span>
            <input
              className="bootstrap-line-input"
              type="text"
              placeholder="CS student, founder, designer, between things…"
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
              maxLength={160}
              autoComplete="off"
            />
          </div>

          <div className="bootstrap-line">
            <span className="bootstrap-line-prompt">What paralyzes you</span>
            <input
              className="bootstrap-line-input"
              type="text"
              placeholder="too many options at once, perfectionism, big vague tasks…"
              value={paralysis}
              onChange={(e) => setParalysis(e.target.value)}
              maxLength={600}
              autoComplete="off"
            />
          </div>

          <div className="bootstrap-line">
            <span className="bootstrap-line-prompt">Working hours</span>
            <input
              className="bootstrap-line-input"
              type="text"
              placeholder="sharp mornings, dead afternoons, second wind at night…"
              value={workingHours}
              onChange={(e) => setWorkingHours(e.target.value)}
              maxLength={300}
              autoComplete="off"
            />
          </div>

          <div className="bootstrap-line">
            <span className="bootstrap-line-prompt">Deadlines</span>
            <input
              className="bootstrap-line-input"
              type="text"
              placeholder="procrastinate then sprint, or steady the whole way?"
              value={deadlineCadence}
              onChange={(e) => setDeadlineCadence(e.target.value)}
              maxLength={300}
              autoComplete="off"
            />
          </div>

          {error ? <p className="bootstrap-error">{error}</p> : null}
        </div>

        <footer className="bootstrap-hero-footer">
          <button
            type="button"
            className="bootstrap-cancel"
            onClick={handleSkip}
            disabled={submitting || skipping}
          >
            {skipping ? "Skipping…" : "Skip for now"}
          </button>
          <button
            type="button"
            className="bootstrap-submit bootstrap-submit--hero"
            onClick={handleSave}
            disabled={submitting || skipping}
          >
            {submitting ? "Saving…" : "Save"}
            {!submitting && <span className="bootstrap-submit-arrow" aria-hidden="true">→</span>}
          </button>
        </footer>

        <p className="bootstrap-skip-reassurance">
          This is about you as a person — you only fill it once.
        </p>
      </div>
    </div>
  );
}
