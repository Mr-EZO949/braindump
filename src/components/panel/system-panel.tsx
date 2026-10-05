"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { InstallAppButton } from "@/components/pwa/install-app-button";
import { PushToggleButton } from "@/components/pwa/push-toggle-button";
import { readAutoAddSetting, saveAutoAddSetting } from "@/lib/graph/auto-apply-client";

type Theme = "dark" | "light";

// Dump-usage counters (#12) — mirrors /api/account/usage.
type TierCounts = { small: number; medium: number; big: number; total: number };
type DumpUsage = { all_time: TierCounts; this_month: TierCounts };
// GET /api/preferences — one standing preference, in words.
type TimePreferenceRow = { id: string; kind: string; label: string; detail: string };

type SystemPanelProps = {
  onSignOut: () => void;
  onDeleteAccount: () => void;
  onClose: () => void;
  open: boolean;
  signingOut: boolean;
  deletingAccount: boolean;
  userEmail: string | null;
  // Active workspace — the "About you" profile is edited per-workspace.
  workspaceId: string | null;
};

const MAX_GOALS = 8;

function readDomTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function SystemPanel({
  onClose,
  onSignOut,
  onDeleteAccount,
  open,
  signingOut,
  deletingAccount,
  userEmail,
  workspaceId,
}: SystemPanelProps) {
  // Must initialize to the same constant the server renders ("dark"). Reading
  // the DOM/localStorage in the initializer would make the first client
  // render diverge from SSR for light-theme users and break hydration. The
  // real theme is synced from the DOM in a mount effect below.
  const [theme, setTheme] = useState<Theme>("dark");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Plan control — collapsed by default ("kinda hidden"); opens a Free/Pro
  // comparison. Purely presentational until billing lands (see P0 Payments).
  const [planOpen, setPlanOpen] = useState(false);
  // Profile modal — the "About you" questions + answers live in a separate
  // window, not inline, so the settings panel stays clean.
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  // "About you" profile — the fields the AI reads to tailor extraction /
  // planning / chat. Loaded from the active workspace when the panel opens.
  const [role, setRole] = useState("");
  const [focus, setFocus] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [goalDraft, setGoalDraft] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Dump-usage counters (#12) — loaded when the panel opens.
  const [usage, setUsage] = useState<DumpUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  // One Save for the whole modal — writes both /api/profile and the workspace.
  const [savingAll, setSavingAll] = useState(false);
  const [savedAll, setSavedAll] = useState(false);

  // Personal — user-level "about you" identity (name, occupation, what
  // paralyzes you, working hours, deadlines). Separate from the per-workspace
  // profile above; loaded from and saved to /api/profile. This is the "editable
  // later" surface for what the first-run intake captures.
  const [personalName, setPersonalName] = useState("");
  const [personalOccupation, setPersonalOccupation] = useState("");
  const [personalParalysis, setPersonalParalysis] = useState("");
  const [personalHours, setPersonalHours] = useState("");
  const [personalDeadlines, setPersonalDeadlines] = useState("");
  const [personalLoading, setPersonalLoading] = useState(false);
  const [personalError, setPersonalError] = useState<string | null>(null);
  // "Add confident items without asking" — per user (auth metadata), read by
  // the server on every dump and chat turn. null until loaded.
  const [autoAdd, setAutoAdd] = useState<boolean | null>(null);
  const [autoAddError, setAutoAddError] = useState(false);
  // Standing preferences ("4h a day coding", docs/preferences.md) — saved
  // from chat or a dump; listed here, each removable. null until loaded.
  const [timePrefs, setTimePrefs] = useState<TimePreferenceRow[] | null>(null);
  const [timePrefsError, setTimePrefsError] = useState(false);
  // The pre-paint script in layout.tsx already applied the correct theme to
  // <html>. The apply-effect below must skip its first run so it doesn't
  // overwrite that with the SSR default before we've synced.
  const skipThemeApplyRef = useRef(true);

  // Reset the destructive-confirm state whenever the panel closes so it
  // never reopens already armed.
  useEffect(() => {
    if (!open) setConfirmingDelete(false);
  }, [open]);

  // Sync state to whatever the pre-paint script applied (post-hydration).
  useEffect(() => {
    setTheme(readDomTheme());
  }, []);

  useEffect(() => {
    if (skipThemeApplyRef.current) {
      // First run = the initial sync, not a user action. The DOM theme is
      // already correct (set by the layout script); don't touch it.
      skipThemeApplyRef.current = false;
      return;
    }
    const root = document.documentElement;
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    try {
      localStorage.setItem("braindump-theme", theme);
    } catch {
      // localStorage unavailable (private mode, etc.) — theme still applied for session.
    }
  }, [theme]);

  // Load the active workspace's profile whenever the panel opens (feeds both the
  // identity card and the modal).
  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    setSavedAll(false);
    fetch(`/api/workspaces/${workspaceId}/profile`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load your profile"))))
      .then((data: { role: string | null; current_focus: string | null; goals: string[] }) => {
        if (cancelled) return;
        setRole(data.role ?? "");
        setFocus(data.current_focus ?? "");
        setGoals(Array.isArray(data.goals) ? data.goals : []);
      })
      .catch((e: Error) => {
        if (!cancelled) setProfileError(e.message);
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  // Load the user-level personal profile whenever the panel opens (feeds the
  // identity card). Not keyed on workspaceId — it's about the person.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPersonalLoading(true);
    setPersonalError(null);
    setSavedAll(false);
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load your details"))))
      .then(
        (data: {
          full_name: string | null;
          occupation: string | null;
          paralysis_triggers: string | null;
          working_hours: string | null;
          deadline_cadence: string | null;
        }) => {
          if (cancelled) return;
          setPersonalName(data.full_name ?? "");
          setPersonalOccupation(data.occupation ?? "");
          setPersonalParalysis(data.paralysis_triggers ?? "");
          setPersonalHours(data.working_hours ?? "");
          setPersonalDeadlines(data.deadline_cadence ?? "");
        },
      )
      .catch((e: Error) => {
        if (!cancelled) setPersonalError(e.message);
      })
      .finally(() => {
        if (!cancelled) setPersonalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load the auto-add switch when the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAutoAddError(false);
    readAutoAddSetting()
      .then((on) => {
        if (!cancelled) setAutoAdd(on);
      })
      .catch(() => {
        if (!cancelled) setAutoAdd(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load the standing preferences when the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTimePrefsError(false);
    fetch("/api/preferences")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("preferences fetch failed"))))
      .then((data: { preferences?: TimePreferenceRow[] }) => {
        if (!cancelled) setTimePrefs(data.preferences ?? []);
      })
      .catch(() => {
        if (!cancelled) setTimePrefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const forgetTimePref = async (id: string) => {
    const before = timePrefs;
    setTimePrefs((prev) => (prev ?? []).filter((p) => p.id !== id));
    setTimePrefsError(false);
    const ok = await fetch(`/api/preferences?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) {
      setTimePrefs(before);
      setTimePrefsError(true);
    }
  };

  const toggleAutoAdd = async () => {
    if (autoAdd === null) return;
    const next = !autoAdd;
    setAutoAdd(next);
    setAutoAddError(false);
    const saved = await saveAutoAddSetting(next).catch(() => false);
    if (!saved) {
      setAutoAdd(!next);
      setAutoAddError(true);
    }
  };

  // Load dump-usage counters when the panel opens (#12).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setUsageLoading(true);
    fetch("/api/account/usage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("usage fetch failed"))))
      .then((data: DumpUsage) => {
        if (!cancelled) setUsage(data);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const trimmedGoalDraft = goalDraft.trim();
  const canAddGoal =
    trimmedGoalDraft.length > 0 &&
    goals.length < MAX_GOALS &&
    !goals.some((g) => g.toLowerCase() === trimmedGoalDraft.toLowerCase());

  const addGoal = () => {
    if (!canAddGoal) return;
    setGoals((prev) => [...prev, trimmedGoalDraft]);
    setGoalDraft("");
    setSavedAll(false);
  };

  const removeGoal = (goal: string) => {
    setGoals((prev) => prev.filter((g) => g !== goal));
    setSavedAll(false);
  };

  // One Save writes both scopes in parallel: user-level /api/profile and the
  // active workspace's profile. Editing here also resolves the first-run intake.
  const handleSaveAll = async () => {
    setSavingAll(true);
    setSavedAll(false);
    setPersonalError(null);
    setProfileError(null);
    try {
      const requests: Promise<Response>[] = [
        fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            full_name: personalName,
            occupation: personalOccupation,
            paralysis_triggers: personalParalysis,
            working_hours: personalHours,
            deadline_cadence: personalDeadlines,
            intake_done: true,
          }),
        }),
      ];
      if (workspaceId) {
        requests.push(
          fetch(`/api/workspaces/${workspaceId}/profile`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role, current_focus: focus, goals }),
          }),
        );
      }
      const responses = await Promise.all(requests);
      const failed = responses.find((r) => !r.ok);
      if (failed) {
        const body = (await failed.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Couldn't save your answers");
      }
      setSavedAll(true);
    } catch (e) {
      setPersonalError(e instanceof Error ? e.message : "Couldn't save your answers");
    } finally {
      setSavingAll(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `braindump-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Best-effort download; nothing persisted, safe to ignore.
    } finally {
      setExporting(false);
    }
  };

  // Personalised identity — what BrainDump surfaces about you at the top.
  const displayName = personalName.trim();
  const identityOccupation = personalOccupation.trim();
  const identityParalysis = personalParalysis.trim();
  const identityNote = (() => {
    const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
    if (identityOccupation && identityParalysis) {
      const par =
        identityParalysis.length > 48
          ? `${identityParalysis.slice(0, 47).trimEnd()}…`
          : identityParalysis;
      return `BrainDump reads you as ${article(identityOccupation)} ${identityOccupation} who freezes on ${par} — and plans around it.`;
    }
    if (identityOccupation) {
      return `BrainDump reads you as ${article(identityOccupation)} ${identityOccupation} — and tailors every plan and answer to that.`;
    }
    return "Add a few details so BrainDump can plan and answer like it actually knows you.";
  })();

  return (
    <aside
      aria-hidden={!open}
      className={`system-panel absolute left-0 top-0 z-20 h-full w-[300px] ${
        open ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"
      }`}
    >
      <div className="flex h-full flex-col overflow-y-auto">
        {/* Header with logo */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          {/* White wordmark on dark, ink wordmark on light (globals.css .sp-logo--*). */}
          <Image className="sp-logo sp-logo--dark" src="/logo_withtext.svg" alt="BrainDump" width={180} height={36} style={{ height: 32, width: "auto" }} />
          <Image className="sp-logo sp-logo--light" src="/logo_withtext_light.svg" alt="BrainDump" width={180} height={36} style={{ height: 32, width: "auto" }} />
          <button
            aria-label="Close"
            className="sp-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="sp-divider" />

        {/* Identity — personalised: BrainDump describing you */}
        <div className="px-5 pt-5 pb-5">
          <div className="sp-identity">
            <span className="sp-identity-avatar" aria-hidden="true">
              {displayName ? displayName[0].toUpperCase() : "·"}
            </span>
            <div className="sp-identity-main">
              <p className="sp-identity-name">
                {displayName ? `Hey, ${displayName}` : "Your profile"}
              </p>
              {identityOccupation ? (
                <p className="sp-identity-sub">{identityOccupation}</p>
              ) : null}
              <p className="sp-identity-email">{userEmail ?? "Not signed in"}</p>
            </div>
          </div>
          <p className="sp-identity-note">{identityNote}</p>
          <button
            type="button"
            className="sp-profile-btn"
            onClick={() => setProfileModalOpen(true)}
          >
            Edit your details
            <span className="sp-profile-btn-arrow" aria-hidden="true">→</span>
          </button>
        </div>

        {profileModalOpen
          ? createPortal(
              <div
                className="sp-modal-overlay"
                role="presentation"
                onClick={() => setProfileModalOpen(false)}
              >
                <div
                  className="sp-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="About you"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="sp-modal-head">
                    <div className="sp-modal-head-text">
                      <h2 className="sp-modal-title">About you</h2>
                      <p className="sp-modal-sub">
                        Your answers tailor how the AI captures, plans, and unblocks you — change them anytime.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="sp-close"
                      aria-label="Close"
                      onClick={() => setProfileModalOpen(false)}
                    >
                      ×
                    </button>
                  </div>

                  <div className="sp-modal-body">
                    <section className="sp-modal-group">
                      <div className="sp-modal-group-head">
                        <span className="sp-modal-group-title">You</span>
                        <span className="sp-modal-group-scope">used across all workspaces</span>
                      </div>

                      <div className="sp-field-grid">
                        <div className="sp-field">
                          <label className="sp-field-label" htmlFor="sp-name">Name</label>
                          <input
                            id="sp-name"
                            className="sp-input"
                            type="text"
                            placeholder="what should we call you?"
                            value={personalName}
                            onChange={(e) => { setPersonalName(e.target.value); setSavedAll(false); }}
                            disabled={personalLoading}
                          />
                        </div>
                        <div className="sp-field">
                          <label className="sp-field-label" htmlFor="sp-occupation">Occupation</label>
                          <input
                            id="sp-occupation"
                            className="sp-input"
                            type="text"
                            placeholder="CS student, founder…"
                            value={personalOccupation}
                            onChange={(e) => { setPersonalOccupation(e.target.value); setSavedAll(false); }}
                            disabled={personalLoading}
                          />
                        </div>
                      </div>

                      <div className="sp-field">
                        <label className="sp-field-label" htmlFor="sp-paralysis">What tends to paralyze you</label>
                        <textarea
                          id="sp-paralysis"
                          className="sp-textarea"
                          rows={2}
                          placeholder="too many options at once, perfectionism, big vague tasks…"
                          value={personalParalysis}
                          onChange={(e) => { setPersonalParalysis(e.target.value); setSavedAll(false); }}
                          disabled={personalLoading}
                        />
                      </div>

                      <div className="sp-field-grid">
                        <div className="sp-field">
                          <label className="sp-field-label" htmlFor="sp-hours">Working hours</label>
                          <input
                            id="sp-hours"
                            className="sp-input"
                            type="text"
                            placeholder="sharp mornings, late nights…"
                            value={personalHours}
                            onChange={(e) => { setPersonalHours(e.target.value); setSavedAll(false); }}
                            disabled={personalLoading}
                          />
                        </div>
                        <div className="sp-field">
                          <label className="sp-field-label" htmlFor="sp-deadlines">Deadlines</label>
                          <input
                            id="sp-deadlines"
                            className="sp-input"
                            type="text"
                            placeholder="sprint late, or steady?"
                            value={personalDeadlines}
                            onChange={(e) => { setPersonalDeadlines(e.target.value); setSavedAll(false); }}
                            disabled={personalLoading}
                          />
                        </div>
                      </div>
                    </section>

                    <section className="sp-modal-group">
                      <div className="sp-modal-group-head">
                        <span className="sp-modal-group-title">This workspace</span>
                        <span className="sp-modal-group-scope">just this one</span>
                      </div>

                      <div className="sp-field">
                        <label className="sp-field-label" htmlFor="sp-role">Your role</label>
                        <input
                          id="sp-role"
                          className="sp-input"
                          type="text"
                          placeholder="e.g. CS student, founder, parent"
                          value={role}
                          onChange={(e) => { setRole(e.target.value); setSavedAll(false); }}
                          disabled={profileLoading || !workspaceId}
                        />
                      </div>

                      <div className="sp-field">
                        <label className="sp-field-label" htmlFor="sp-focus">Current focus</label>
                        <textarea
                          id="sp-focus"
                          className="sp-textarea"
                          rows={2}
                          placeholder="What are you trying to make progress on right now?"
                          value={focus}
                          onChange={(e) => { setFocus(e.target.value); setSavedAll(false); }}
                          disabled={profileLoading || !workspaceId}
                        />
                      </div>

                      <div className="sp-field">
                        <span className="sp-field-label">Big goals</span>
                        {goals.length > 0 ? (
                          <div className="sp-goal-list">
                            {goals.map((goal) => (
                              <span key={goal} className="sp-goal-chip">
                                {goal}
                                <button
                                  type="button"
                                  className="sp-goal-remove"
                                  aria-label={`Remove ${goal}`}
                                  onClick={() => removeGoal(goal)}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {goals.length < MAX_GOALS ? (
                          <div className="sp-goal-add">
                            <input
                              className="sp-input"
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
                              disabled={profileLoading || !workspaceId}
                            />
                            <button
                              type="button"
                              className="sp-menu-btn sp-goal-add-btn"
                              onClick={addGoal}
                              disabled={!canAddGoal}
                            >
                              Add
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </section>

                    {personalError || profileError ? (
                      <p className="sp-error">{personalError ?? profileError}</p>
                    ) : null}
                  </div>

                  <div className="sp-modal-foot">
                    <button
                      type="button"
                      className="sp-modal-cancel"
                      onClick={() => setProfileModalOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="sp-modal-save"
                      onClick={handleSaveAll}
                      disabled={savingAll || personalLoading || profileLoading}
                    >
                      {savingAll ? "Saving…" : savedAll ? "Saved ✓" : "Save changes"}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}

        <div className="sp-divider" />

        {/* Plan */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Plan</p>
          {/* Plan — understated upgrade entry. Wire the Pro CTA to checkout
              and add a "Manage" link for Pro users once billing lands. */}
          <div className="sp-plan">
            <button
              type="button"
              className="sp-plan-row"
              onClick={() => setPlanOpen((v) => !v)}
              aria-expanded={planOpen}
            >
              <span className="sp-plan-row-left">
                <span className="sp-plan-badge">Free</span>
                <span className="sp-plan-row-label">Your plan</span>
              </span>
              <span className="sp-plan-row-cta" data-open={planOpen || undefined}>
                {planOpen ? "Hide" : "Upgrade"}
                <span className="sp-plan-chevron" aria-hidden="true">›</span>
              </span>
            </button>

            {planOpen ? (
              <div className="sp-plan-compare">
                <div className="sp-plan-card" data-current="true">
                  <span className="sp-plan-card-name">Free</span>
                  <span className="sp-plan-card-price">$0</span>
                  <span className="sp-plan-card-note">Where you are now.</span>
                </div>
                <div className="sp-plan-card sp-plan-card--pro">
                  <span className="sp-plan-card-tag">Pro</span>
                  <span className="sp-plan-card-price">
                    $15<span className="sp-plan-card-per"> / mo</span>
                  </span>
                  <ul className="sp-plan-card-perks">
                    <li>Room to dump without hitting a wall</li>
                    <li>Priority planning &amp; chat</li>
                    <li>Limits high enough to forget they exist</li>
                  </ul>
                  <button type="button" className="sp-plan-upgrade" disabled>
                    Upgrade
                    <span className="sp-plan-soon">Soon</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Dump usage (#12) — how many small / medium / big dumps you've run. */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Dump usage</p>
          {usageLoading && !usage ? (
            <p className="sp-usage-empty">Counting your dumps…</p>
          ) : usage && usage.all_time.total > 0 ? (
            <>
              <div className="sp-usage-grid">
                {(
                  [
                    { key: "small", label: "Small", hint: "1–4 items" },
                    { key: "medium", label: "Medium", hint: "5–12 items" },
                    { key: "big", label: "Big", hint: "13+ items" },
                  ] as const
                ).map((t) => (
                  <div className={`sp-usage-cell sp-usage-cell--${t.key}`} key={t.key}>
                    <span className="sp-usage-count">{usage.all_time[t.key]}</span>
                    <span className="sp-usage-label">{t.label}</span>
                    <span className="sp-usage-hint">{t.hint}</span>
                  </div>
                ))}
              </div>
              <p className="sp-usage-foot">
                {usage.all_time.total} dump{usage.all_time.total === 1 ? "" : "s"} all-time
                {usage.this_month.total > 0
                  ? ` · ${usage.this_month.total} this month`
                  : ""}
              </p>
            </>
          ) : (
            <p className="sp-usage-empty">No dumps yet — hit Brain Dump to get started.</p>
          )}
        </div>

        <div className="sp-divider" />

        {/* Data & account */}
        <div className="px-5 py-4 flex flex-col gap-1">
          <p className="sp-section-label">Data &amp; account</p>
          {/* Self-hides on desktop, in-app browsers, or when already
              installed — only shows a real install path on mobile. */}
          <InstallAppButton />
          <PushToggleButton />
          <button
            className="sp-menu-btn"
            type="button"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? "Preparing…" : "Export my data"}
          </button>

          {confirmingDelete ? (
            <div className="flex flex-col gap-2 rounded-md border border-[rgba(213,58,71,0.3)] bg-[rgba(213,58,71,0.06)] p-3">
              <p className="text-[12px] leading-snug text-(--color-text-secondary)">
                This permanently deletes your account and{" "}
                <strong className="text-(--color-text-primary)">all your data</strong> —
                every node, edge, dump, and chat. This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  className="sp-menu-btn sp-menu-btn--danger flex-1"
                  type="button"
                  onClick={onDeleteAccount}
                  disabled={deletingAccount}
                >
                  {deletingAccount ? "Deleting…" : "Delete everything"}
                </button>
                <button
                  className="sp-menu-btn flex-1"
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deletingAccount}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="sp-menu-btn sp-menu-btn--danger"
              type="button"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete account
            </button>
          )}
        </div>

        <div className="sp-divider" />

        {/* Brain dump & chat — the auto-add switch (lib/ai/auto-apply.ts). */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Brain dump &amp; chat</p>
          <div className="sp-switch-row">
            <span className="sp-switch-text">
              <span className="sp-switch-label" id="sp-auto-add-label">
                Add confident items without asking
              </span>
              <span className="sp-switch-hint" id="sp-auto-add-hint">
                {autoAdd === false
                  ? "Off: everything a dump or chat changes waits on its card for your OK."
                  : "New items you usually keep, things you finished and links go straight in, with Undo."}
              </span>
            </span>
            <button
              aria-checked={autoAdd !== false}
              aria-describedby="sp-auto-add-hint"
              aria-labelledby="sp-auto-add-label"
              className="sp-switch"
              data-on={autoAdd !== false || undefined}
              disabled={autoAdd === null}
              onClick={() => void toggleAutoAdd()}
              role="switch"
              type="button"
            >
              <span className="sp-switch-knob" aria-hidden="true" />
            </button>
          </div>
          {autoAddError ? <p className="sp-error">Couldn&apos;t save that. Try again.</p> : null}
        </div>

        <div className="sp-divider" />

        {/* Your time — standing preferences (docs/preferences.md). */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Your time</p>
          {timePrefs && timePrefs.length > 0 ? (
            <ul className="sp-pref-list">
              {timePrefs.map((p) => (
                <li className="sp-pref-row" key={p.id}>
                  <span className="sp-pref-text">
                    <span className="sp-pref-label">{p.label}</span>
                    <span className="sp-pref-detail">{p.detail}</span>
                  </span>
                  <button
                    type="button"
                    className="sp-goal-remove"
                    aria-label={`Forget ${p.label}`}
                    title="Forget this"
                    onClick={() => void forgetTimePref(p.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {timePrefs === null ? null : (
            <p className="sp-switch-hint">
              {timePrefs.length > 0
                ? "Your plans and Focus follow these. Change one by telling the chat."
                : "Tell the chat how you want to spend your time — “4h a day coding”, “no work after 10pm” — and your plans and Focus will remember it."}
            </p>
          )}
          {timePrefsError ? <p className="sp-error">Couldn&apos;t remove that. Try again.</p> : null}
        </div>

        <div className="sp-divider" />

        {/* Theme */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Theme</p>
          <div className="sp-theme-toggle">
            <button
              aria-pressed={theme === "dark"}
              className="sp-theme-option"
              data-active={theme === "dark"}
              onClick={() => setTheme("dark")}
              type="button"
            >
              Dark
            </button>
            <button
              aria-pressed={theme === "light"}
              className="sp-theme-option"
              data-active={theme === "light"}
              onClick={() => setTheme("light")}
              type="button"
            >
              Light
            </button>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sign out + footer */}
        <div className="px-5 pb-5">
          <button
            className="sp-signout-btn"
            disabled={!userEmail || signingOut}
            onClick={onSignOut}
            type="button"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>

          <div className="sp-divider mt-4" />
          <div className="sp-footer">
            <a href="mailto:support@braindump.app" className="sp-footer-link">Support</a>
            <span className="sp-footer-dot">·</span>
            <a href="/terms" className="sp-footer-link" target="_blank" rel="noreferrer">Terms</a>
            <span className="sp-footer-dot">·</span>
            <a href="/privacy" className="sp-footer-link" target="_blank" rel="noreferrer">Privacy</a>
          </div>
        </div>
      </div>
    </aside>
  );
}
