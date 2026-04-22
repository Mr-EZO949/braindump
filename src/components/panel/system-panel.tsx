"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type Theme = "dark" | "light";

type SystemPanelProps = {
  onSignOut: () => void;
  onClose: () => void;
  open: boolean;
  signingOut: boolean;
  userEmail: string | null;
};

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function SystemPanel({
  onClose,
  onSignOut,
  open,
  signingOut,
  userEmail,
}: SystemPanelProps) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
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
          <button className="sp-menu-btn" type="button" disabled>
            Manage subscription
          </button>
          <button className="sp-menu-btn sp-menu-btn--danger" type="button" disabled>
            Delete account
          </button>
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
