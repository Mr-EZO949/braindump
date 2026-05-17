"use client";

import { useState } from "react";

import { useInstallPrompt } from "@/components/pwa/use-install-prompt";

// Permanent install affordance in the settings panel — the place a user
// looks after dismissing the banner. Shares install state with the banner
// via useInstallPrompt(). Renders nothing on desktop, when already
// installed, or before mount (SSR-safe).
export function InstallAppButton({ className }: { className?: string }) {
  const { mounted, installed, ios, canPrompt, promptInstall } =
    useInstallPrompt();
  const [showIosHelp, setShowIosHelp] = useState(false);

  if (!mounted || installed) return null;
  if (!canPrompt && !ios) return null;

  const handleClick = () => {
    if (canPrompt) {
      void promptInstall();
      return;
    }
    if (ios) setShowIosHelp((open) => !open);
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleClick}
        className="sp-menu-btn flex w-full items-center gap-2"
      >
        <svg
          className="h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12" />
          <path d="m8 11 4 4 4-4" />
          <path d="M5 21h14" />
        </svg>
        Install app
      </button>

      {ios && showIosHelp ? (
        <div className="mt-2 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-3 text-[12px] leading-snug text-(--color-text-secondary)">
          In <strong className="text-(--color-text-primary)">Safari</strong>,
          tap <strong className="text-(--color-text-primary)">Share</strong>{" "}
          then{" "}
          <strong className="text-(--color-text-primary)">
            &ldquo;Add to Home Screen.&rdquo;
          </strong>{" "}
          Opening this inside another app (Telegram, Instagram, etc.) won&apos;t
          work — use Safari directly.
        </div>
      ) : null}
    </div>
  );
}
