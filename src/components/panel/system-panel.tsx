"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { InstallAppButton } from "@/components/pwa/install-app-button";
import { PushToggleButton } from "@/components/pwa/push-toggle-button";

type Theme = "dark" | "light";

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

  // "About you" profile — the fields the AI reads to tailor extraction /
  // planning / chat. Loaded from the active workspace when the panel opens.
  const [role, setRole] = useState("");
  const [focus, setFocus] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [goalDraft, setGoalDraft] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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

  // Load the active workspace's profile whenever the panel opens.
  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    setProfileSaved(false);
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

  const trimmedGoalDraft = goalDraft.trim();
  const canAddGoal =
    trimmedGoalDraft.length > 0 &&
    goals.length < MAX_GOALS &&
    !goals.some((g) => g.toLowerCase() === trimmedGoalDraft.toLowerCase());

  const addGoal = () => {
    if (!canAddGoal) return;
    setGoals((prev) => [...prev, trimmedGoalDraft]);
    setGoalDraft("");
    setProfileSaved(false);
  };

  const removeGoal = (goal: string) => {
    setGoals((prev) => prev.filter((g) => g !== goal));
    setProfileSaved(false);
  };

  const handleSaveProfile = async () => {
    if (!workspaceId) return;
    setProfileSaving(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, current_focus: focus, goals }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Couldn't save your profile");
      }
      const data = (await res.json()) as {
        role: string | null;
        current_focus: string | null;
        goals: string[];
      };
      setRole(data.role ?? "");
      setFocus(data.current_focus ?? "");
      setGoals(Array.isArray(data.goals) ? data.goals : []);
      setProfileSaved(true);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Couldn't save your profile");
    } finally {
      setProfileSaving(false);
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

  return (
    <aside
      aria-hidden={!open}
      className={`system-panel absolute left-0 top-0 z-20 h-full w-[300px] ${
        open ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"
      }`}
    >
      <div className="flex h-full flex-col">
        {/* Header with logo */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <Image src="/logo_withtext.svg" alt="BrainDump" width={180} height={36} style={{ height: 32, width: "auto" }} />
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

        {/* Account */}
        <div className="px-5 py-4">
          <p className="sp-section-label">Account</p>
          <p className="sp-email">{userEmail ?? "Not signed in"}</p>
        </div>

        <div className="sp-divider" />

        {/* About you — profile the AI uses to tailor its help */}
        <div className="px-5 py-4">
          <p className="sp-section-label">About you</p>
          <p className="sp-hint">The AI reads this to tailor how it captures, plans, and answers.</p>

          <div className="sp-field">
            <label className="sp-field-label" htmlFor="sp-role">Your role</label>
            <input
              id="sp-role"
              className="sp-input"
              type="text"
              placeholder="e.g. CS student, founder, parent"
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setProfileSaved(false);
              }}
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
              onChange={(e) => {
                setFocus(e.target.value);
                setProfileSaved(false);
              }}
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

          {profileError ? <p className="sp-error">{profileError}</p> : null}

          <button
            type="button"
            className="sp-save-btn"
            onClick={handleSaveProfile}
            disabled={profileSaving || profileLoading || !workspaceId}
          >
            {profileSaving ? "Saving…" : profileSaved ? "Saved ✓" : "Save profile"}
          </button>
        </div>

        <div className="sp-divider" />

        {/* Account actions */}
        <div className="px-5 py-4 flex flex-col gap-1">
          {/* Self-hides on desktop, in-app browsers, or when already
              installed — only shows a real install path on mobile. */}
          <InstallAppButton />
          <PushToggleButton />

          <button className="sp-menu-btn" type="button" disabled>
            Manage subscription
          </button>

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
