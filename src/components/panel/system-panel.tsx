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
};

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
}: SystemPanelProps) {
  // Must initialize to the same constant the server renders ("dark"). Reading
  // the DOM/localStorage in the initializer would make the first client
  // render diverge from SSR for light-theme users and break hydration. The
  // real theme is synced from the DOM in a mount effect below.
  const [theme, setTheme] = useState<Theme>("dark");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

        {/* Account actions */}
        <div className="px-5 py-4 flex flex-col gap-1">
          {/* Self-hides on desktop, in-app browsers, or when already
              installed — only shows a real install path on mobile. */}
          <InstallAppButton />
          <PushToggleButton />

          <button className="sp-menu-btn" type="button" disabled>
            Manage subscription
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
            <a href="#" className="sp-footer-link">Terms</a>
            <span className="sp-footer-dot">·</span>
            <a href="#" className="sp-footer-link">Privacy</a>
          </div>
        </div>
      </div>
    </aside>
  );
}
