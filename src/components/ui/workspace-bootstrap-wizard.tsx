"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { CloseIcon, PlusIcon } from "@/components/ui/icons";
import type { WorkspaceProfileAreaType } from "@/types/graph";

interface AreaRow {
  id: string;
  title: string;
  area_type: WorkspaceProfileAreaType;
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

const MAX_AREAS = 6;
// Manual areas the user types on step 2 get a neutral default type — the
// dropdown that used to let them pick one was removed (the type is an
// internal grouping hint, not a decision worth putting on the user).
const DEFAULT_AREA_TYPE: WorkspaceProfileAreaType = "personal";
// Human labels for the (now display-only) area type. The picker was removed;
// the badge just shows the AI's category, tinted neutral-gray in CSS.
const AREA_TYPE_LABEL: Record<WorkspaceProfileAreaType, string> = {
  academic: "Academic",
  project: "Project",
  career: "Career",
  health: "Health",
  life_admin: "Life admin",
  personal: "Personal",
};

// Cycled under the spinner while the final bootstrap request runs. The submit
// does real work — extraction, node creation, embeddings, connection
// inference — so it can take a bit; these keep the wait feeling intentional.
const BUILD_MESSAGES = [
  "Reading your dump…",
  "Pulling out tasks, goals, and ideas…",
  "Sorting them under your areas…",
  "Finding the connections between them…",
  "Almost there — this can take a minute…",
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
  // The hero textarea is the brain dump — that's where the AI does its work
  // and where most of the user's first-touch value comes from. Everything
  // structured (focus, role) is tucked behind an "Add structure" toggle so
  // the canvas stays calm on first impression.
  const [bootstrapDump, setBootstrapDump] = useState("");
  const [showStructure, setShowStructure] = useState(false);
  const [successTitle, setSuccessTitle] = useState("");
  const [role, setRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  // Step 2 (the area skeleton): AI proposes life-areas from the dump, user
  // edits. Goals are no longer collected on step 1 — anything the user wants
  // to track as its own branch is added here, as an area, AFTER they've seen
  // what the AI already proposed (so they don't create duplicates).
  const [step, setStep] = useState<0 | 1>(0);
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [areaTitleDraft, setAreaTitleDraft] = useState("");
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [buildMessageIndex, setBuildMessageIndex] = useState(0);

  const trimmed = successTitle.trim();
  const trimmedRole = role.trim();
  const trimmedDump = bootstrapDump.trim();
  const trimmedAreaDraft = areaTitleDraft.trim();
  const canAddArea =
    Boolean(trimmedAreaDraft) &&
    areas.length < MAX_AREAS &&
    !areas.some((a) => a.title.toLowerCase() === trimmedAreaDraft.toLowerCase());

  // Cycle the build messages while the final submit runs.
  useEffect(() => {
    if (!submitting) {
      setBuildMessageIndex(0);
      return;
    }
    const id = window.setInterval(() => {
      setBuildMessageIndex((i) => Math.min(i + 1, BUILD_MESSAGES.length - 1));
    }, 2600);
    return () => window.clearInterval(id);
  }, [submitting]);

  // Step 1 → 2: move to the areas step and ask the AI to propose life-areas
  // from the dump. Show the step immediately (with a spinner) so it feels
  // responsive; fall soft to manual entry on any error.
  async function goToAreas() {
    if (submitting || loadingSuggestions) return;
    setStep(1);
    if (!trimmedDump && !trimmed) return; // nothing to infer from → manual entry
    setLoadingSuggestions(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/suggest-areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bootstrap_dump: trimmedDump || null,
          role: trimmedRole || null,
          success_title: trimmed || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        suggested_areas?: Array<{ title: string; area_type: WorkspaceProfileAreaType }>;
      };
      setAreas(
        (data.suggested_areas ?? []).slice(0, MAX_AREAS).map((a) => ({
          id: createId("area"),
          title: a.title,
          area_type: a.area_type,
        })),
      );
    } catch {
      setAreas([]);
    } finally {
      setLoadingSuggestions(false);
    }
  }

  function addArea() {
    if (!canAddArea) return;
    setAreas((prev) => [
      ...prev,
      { id: createId("area"), title: trimmedAreaDraft.slice(0, 80), area_type: DEFAULT_AREA_TYPE },
    ]);
    setAreaTitleDraft("");
  }

  function removeArea(id: string) {
    setAreas((prev) => prev.filter((a) => a.id !== id));
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
          // Goals are no longer a separate concept in the wizard — the user's
          // own branches come through as areas from step 2.
          goals: [],
          areas: areas.map((a) => ({ title: a.title, area_type: a.area_type })),
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
            {step === 0 ? (isOnboarding ? "First setup" : "New workspace") : "Step 2 · your areas"}
          </span>
          {step === 0 ? (
            <>
              <h2 className="bootstrap-hero-heading">
                What&rsquo;s on your <span className="bootstrap-hero-heading-em">mind</span>?
              </h2>
              <p className="bootstrap-hero-sub">
                Tasks, goals, deadlines, half-ideas. Don&rsquo;t organize — we will.
              </p>
            </>
          ) : (
            <>
              <h2 className="bootstrap-hero-heading">
                Your life <span className="bootstrap-hero-heading-em">areas</span>
              </h2>
              <p className="bootstrap-hero-sub">
                The branches your graph hangs off — edit, remove, or add your own. Your dump sorts under these.
              </p>
            </>
          )}
        </header>

        <div className="bootstrap-hero-body">
          {step === 0 ? (
          <>
          <textarea
            className="bootstrap-hero-textarea"
            placeholder="climbing 3x a week, OS project due Nov 8, mom's birthday May 18, half-formed app idea about route logging, want to read more philosophy this year, marathon in september…"
            value={bootstrapDump}
            onChange={(e) => setBootstrapDump(e.target.value)}
            maxLength={4000}
            autoFocus
            rows={9}
            disabled={submitting}
          />

          {/* Structure toggle — collapsed by default. Opens to reveal two
              terse inputs: focus + who you are. (Goals were removed — the
              user adds their own branches as areas on step 2 instead.) */}
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
              focus · who you are
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
              </motion.div>
            )}
          </AnimatePresence>
          </>
          ) : (
          <div className="bootstrap-areas">
            {loadingSuggestions ? (
              <div className="bootstrap-areas-loading" role="status" aria-live="polite">
                <span className="bootstrap-spinner" aria-hidden="true" />
                <p className="bootstrap-areas-loading-title">Reading your dump for life-areas…</p>
                <p className="bootstrap-areas-loading-sub">This usually takes a few seconds.</p>
              </div>
            ) : (
              <>
                {areas.length === 0 ? (
                  <p className="bootstrap-areas-note">No areas yet — add your main life-areas below.</p>
                ) : (
                  <div className="bootstrap-area-list">
                    {areas.map((a) => (
                      <div className="bootstrap-area-row" key={a.id}>
                        <span className="bootstrap-area-type" data-type={a.area_type}>
                          {AREA_TYPE_LABEL[a.area_type]}
                        </span>
                        <span className="bootstrap-area-title">{a.title}</span>
                        <button
                          type="button"
                          className="bootstrap-goal-chip-v2-x"
                          onClick={() => removeArea(a.id)}
                          aria-label={`Remove ${a.title}`}
                        >
                          <CloseIcon className="h-[9px] w-[9px]" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="bootstrap-area-add">
                  <input
                    className="bootstrap-line-input"
                    type="text"
                    placeholder={areas.length >= MAX_AREAS ? "Max areas reached" : "Add your own area"}
                    value={areaTitleDraft}
                    onChange={(e) => setAreaTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addArea();
                      }
                    }}
                    maxLength={80}
                    autoComplete="off"
                    disabled={areas.length >= MAX_AREAS}
                  />
                  <button
                    type="button"
                    className="bootstrap-line-add"
                    onClick={addArea}
                    disabled={!canAddArea}
                    aria-label="Add area"
                  >
                    <PlusIcon className="h-[12px] w-[12px]" />
                  </button>
                </div>
              </>
            )}
          </div>
          )}

          {error ? <p className="bootstrap-error">{error}</p> : null}
        </div>

        <footer className="bootstrap-hero-footer">
          <button
            type="button"
            className="bootstrap-cancel"
            onClick={step === 0 ? handleSkip : () => setStep(0)}
            disabled={submitting}
          >
            {step === 0 ? (isOnboarding ? "Skip for now" : "Cancel") : "Back"}
          </button>
          {step === 0 ? (
            <button
              type="button"
              className="bootstrap-submit bootstrap-submit--hero"
              disabled={submitting || loadingSuggestions}
              onClick={() => void goToAreas()}
            >
              Next
              <span className="bootstrap-submit-arrow" aria-hidden="true">→</span>
            </button>
          ) : (
            <button
              type="button"
              className="bootstrap-submit bootstrap-submit--hero"
              disabled={submitting || loadingSuggestions}
              onClick={handleSubmit}
            >
              {submitLabel}
              {!submitting && <span className="bootstrap-submit-arrow" aria-hidden="true">→</span>}
            </button>
          )}
        </footer>

        {isOnboarding ? (
          <p className="bootstrap-skip-reassurance">
            You can do this anytime — just Brain Dump.
          </p>
        ) : null}

        {/* Full-modal loading veil while the final bootstrap request runs — a
            spinner plus a couple of cycling reassurance messages so the
            (genuinely multi-second) build never feels frozen. */}
        {submitting && (
          <div className="bootstrap-building" role="status" aria-live="polite">
            <span className="bootstrap-building-spinner" aria-hidden="true" />
            <p className="bootstrap-building-title">Building your graph</p>
            <p className="bootstrap-building-msg">{BUILD_MESSAGES[buildMessageIndex]}</p>
          </div>
        )}

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
