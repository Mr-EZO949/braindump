"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { useInstallPrompt } from "@/components/pwa/use-install-prompt";

const DISMISS_KEY = "braindump:install-banner-dismissed";

// App-wide, dismissible "Install BrainDump" strip. Shows only on a device
// where install is actually possible (Android prompt captured, or iOS
// Safari), never when already installed, and never again once dismissed
// (the settings panel keeps a permanent install button as the fallback).
export function InstallBanner() {
  const { mounted, installed, ios, canPrompt, promptInstall } =
    useInstallPrompt();
  const [dismissed, setDismissed] = useState(true); // assume hidden until checked
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!mounted || installed || dismissed) return null;
  if (!canPrompt && !ios) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage unavailable — at least hide it for this session.
    }
    setDismissed(true);
  };

  const onInstall = () => {
    if (canPrompt) {
      void promptInstall();
      return;
    }
    setIosHelp((open) => !open);
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 border-b border-[rgba(255,255,255,0.08)] bg-[rgba(11,11,13,0.95)] backdrop-blur-md"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      role="region"
      aria-label="Install BrainDump"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
        <Image
          src="/icons/icon-192.png"
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 shrink-0 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-(--color-text-primary)">
            Install BrainDump
          </p>
          <p className="truncate text-[11.5px] text-(--color-text-muted)">
            {ios && !canPrompt
              ? "Add it to your home screen"
              : "Full screen, no browser bars"}
          </p>
        </div>
        <button
          type="button"
          onClick={onInstall}
          className="shrink-0 rounded-full border border-[rgba(213,58,71,0.55)] bg-[rgba(213,58,71,0.95)] px-4 py-1.5 text-[12.5px] font-semibold text-white"
        >
          {ios && !canPrompt ? "How?" : "Install"}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 px-1.5 text-[18px] leading-none text-(--color-text-muted)"
        >
          ×
        </button>
      </div>

      {ios && iosHelp ? (
        <div className="mx-auto max-w-3xl px-4 pb-3 text-[12px] leading-snug text-(--color-text-secondary)">
          In <strong className="text-(--color-text-primary)">Safari</strong>,
          tap the <strong className="text-(--color-text-primary)">Share</strong>{" "}
          button
          <span aria-hidden="true" className="mx-1 inline-flex translate-y-[3px]">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v13" />
              <path d="m7 8 5-5 5 5" />
              <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
            </svg>
          </span>
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
