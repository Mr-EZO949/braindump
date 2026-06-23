"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { CloseIcon, PlusIcon } from "@/components/ui/icons";

interface GoalRow {
  id: string;
  title: string;
}

// Slim shape for what bootstrap returns about the dump — we hand this off
// to the parent so it can auto-open the proposed-nodes review modal.
export interface BootstrapDumpHandoff {
  proposed_nodes: unknown[];
  clarifying_questions: unknown[];
  raw_entry_id: string | null;
  raw_text: string;
  // Set when the user submitted a dump but extraction failed (or was
  // disabled) and produced no proposals — lets the parent surface a
  // "couldn't process that dump" notice instead of silently dropping it.
  extraction_error: string | null;
}

interface Props {
  workspaceId: string;
  workspaceName: string;
  onComplete: (handoff?: BootstrapDumpHandoff) => void;
  onSkip: () => void;
  isOnboarding?: boolean;
}

const MAX_GOALS = 6;

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
  // The hero textarea is the brain dump — that's where the AI does its work
  // and where most of the user's first-touch value comes from. Everything
  // structured (focus, role, goals) is tucked behind an "Add structure"
  // toggle so the canvas stays calm on first impression.
  const [bootstrapDump, setBootstrapDump] = useState("");
  const [showStructure, setShowStructure] = useState(false);
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
  const trimmedDump = bootstrapDump.trim();
  const canAddGoal =
    Boolean(trimmedGoalDraft) &&
    goals.length < MAX_GOALS &&
    !goals.some((g) => g.title.toLowerCase() === trimmedGoalDraft.toLowerCase());

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
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: trimmedRole || null,
          current_focus: null,
          // Falls back to a neutral placeholder so the bootstrap endpoint
          // never sees an empty success_title.
          success_title: trimmed || workspaceName || "My workspace",
          goals: goals.map((g) => ({ title: g.title })),
          areas: [],
          bootstrap_dump: trimmedDump || null,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Setup failed");
      }

      const data = (await res.json().catch(() => ({}))) as {
        bootstrap_dump?: {
          proposed_nodes?: unknown[];
          clarifying_questions?: unknown[];
          raw_entry_id?: string | null;
          extraction_error?: string | null;
        };
      };
      const dump = data.bootstrap_dump;
      const hasProposals = Boolean(
        dump &&
          ((dump.proposed_nodes && dump.proposed_nodes.length > 0) ||
            (dump.clarifying_questions && dump.clarifying_questions.length > 0)),
      );
      // Submitted a dump but got nothing back AND extraction failed (or was
      // disabled): flag it so the parent can surface a non-blocking notice
      // rather than silently dropping the dump's payoff.
      const extractionFailed =
        Boolean(trimmedDump) && !hasProposals && Boolean(dump?.extraction_error);
      if (hasProposals || extractionFailed) {
        onComplete({
          proposed_nodes: dump?.proposed_nodes ?? [],
          clarifying_questions: dump?.clarifying_questions ?? [],
          raw_entry_id: dump?.raw_entry_id ?? null,
          raw_text: trimmedDump,
          extraction_error: extractionFailed ? dump?.extraction_error ?? "" : null,
        });
      } else {
        onComplete();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  // "Skip for now" from onboarding must NOT permanently lock the wizard.
  // We dismiss it for this session (onSkip) without creating an anchor or
  // writing bootstrap_completed_at, so a later still-empty load can re-offer
  // setup. (Previously this ran handleSubmit, which marked the workspace
  // bootstrapped forever — the wizard never returned.)
  function handleSkip() {
    if (isOnboarding) {
      onSkip();
      return;
    }
    // For non-onboarding ("I created a new workspace by mistake") we still
    // confirm before destroying.
    setShowCancelConfirm(true);
  }

  const submitLabel = submitting
    ? trimmedDump
      ? "Reading…"
      : "Creating…"
    : "Begin";

  return (
    <div className="bootstrap-overlay">
      <div className="bootstrap-modal bootstrap-modal--hero">
        <div className="bootstrap-atmosphere" aria-hidden="true" />

        <header className="bootstrap-hero-header">
          <span className="bootstrap-eyebrow">
            {isOnboarding ? "First setup" : "New workspace"}
          </span>
          <h2 className="bootstrap-hero-heading">
            What&rsquo;s on your <span className="bootstrap-hero-heading-em">mind</span>?
          </h2>
          <p className="bootstrap-hero-sub">
            Tasks, goals, deadlines, half-ideas. Don&rsquo;t organize — we will.
          </p>
        </header>

        <div className="bootstrap-hero-body">
          <textarea
            className="bootstrap-hero-textarea"
            placeholder="climbing 3x a week, OS project due Nov 8, mom's birthday May 18, half-formed app idea about route logging, want to read more philosophy this year, marathon in september…"
            value={bootstrapDump}
            onChange={(e) => setBootstrapDump(e.target.value)}
            maxLength={4000}
            autoFocus
            rows={9}
          />

          {/* Structure toggle — collapsed by default. Opens to reveal three
              terse inputs: season, role, goals. */}
          <button
            type="button"
            className="bootstrap-structure-toggle"
            data-open={showStructure || undefined}
            onClick={() => setShowStructure((v) => !v)}
            aria-expanded={showStructure}
          >
            <span className="bootstrap-structure-toggle-chevron" aria-hidden="true">
              {showStructure ? "−" : "+"}
            </span>
            <span>{showStructure ? "Hide structure" : "Add structure"}</span>
            <span className="bootstrap-structure-toggle-hint">
              focus · who you are · top goals
            </span>
          </button>

          <AnimatePresence initial={false}>
            {showStructure && (
              <motion.div
                key="structure"
                className="bootstrap-structure-block"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="bootstrap-line">
                  <span className="bootstrap-line-prompt">Focus</span>
                  <input
                    className="bootstrap-line-input"
                    type="text"
                    placeholder="do my best work without burning out"
                    value={successTitle}
                    onChange={(e) => setSuccessTitle(e.target.value)}
                    maxLength={240}
                    autoComplete="off"
                  />
                </div>

                <div className="bootstrap-line">
                  <span className="bootstrap-line-prompt">You</span>
                  <input
                    className="bootstrap-line-input"
                    type="text"
                    placeholder="junior CS at U Mich, climber, NLP lab"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    maxLength={140}
                    autoComplete="off"
                  />
                </div>

                <div className="bootstrap-line bootstrap-line--goals">
                  <span className="bootstrap-line-prompt">
                    Goals
                    {goals.length > 0 ? (
                      <span className="bootstrap-line-prompt-count">{goals.length}</span>
                    ) : null}
                  </span>
                  <div className="bootstrap-goals-row">
                    <input
                      className="bootstrap-line-input"
                      type="text"
                      placeholder="type a goal, press enter"
                      value={goalDraft}
                      onChange={(e) => setGoalDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addGoal();
                        }
                      }}
                      maxLength={120}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="bootstrap-line-add"
                      onClick={addGoal}
                      disabled={!canAddGoal}
                      aria-label="Add goal"
                    >
                      <PlusIcon className="h-[12px] w-[12px]" />
                    </button>
                  </div>
                </div>

                {goals.length > 0 && (
                  <div className="bootstrap-goal-chips">
                    {goals.map((goal) => (
                      <span className="bootstrap-goal-chip-v2" key={goal.id}>
                        {goal.title}
                        <button
                          type="button"
                          className="bootstrap-goal-chip-v2-x"
                          onClick={() => removeGoal(goal.id)}
                          aria-label={`Remove ${goal.title}`}
                        >
                          <CloseIcon className="h-[9px] w-[9px]" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {error ? <p className="bootstrap-error">{error}</p> : null}
        </div>

        <footer className="bootstrap-hero-footer">
          <button
            type="button"
            className="bootstrap-cancel"
            onClick={handleSkip}
            disabled={submitting}
          >
            {isOnboarding ? "Skip for now" : "Cancel"}
          </button>
          <button
            type="button"
            className="bootstrap-submit bootstrap-submit--hero"
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitLabel}
            {!submitting && <span className="bootstrap-submit-arrow" aria-hidden="true">→</span>}
          </button>
        </footer>

        {isOnboarding ? (
          <p className="bootstrap-skip-reassurance">
            You can do this anytime — just Brain Dump.
          </p>
        ) : null}

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
                  : "This workspace won't be saved."}
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
