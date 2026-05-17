"use client";

import { useEffect, useState } from "react";

// Single source of truth for PWA install state. The `beforeinstallprompt`
// event fires exactly once and can only be prompt()'d once, so we capture it
// at module scope and let every consumer (banner, settings button) share it
// instead of each registering competing listeners.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let appInstalled = false;
let listenersBound = false;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => fn());
}

function bindListeners() {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppress Chrome's hidden mini-infobar; we drive install from our UI.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    appInstalled = true;
    deferredPrompt = null;
    notify();
  });
}

function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ masquerades as macOS — disambiguate via touch points.
  const iPadOs =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iDevice || iPadOs;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayStandalone = window.matchMedia(
    "(display-mode: standalone)",
  ).matches;
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
    true;
  return displayStandalone || iosStandalone;
}

export type InstallState = {
  /** True once mounted on the client — render nothing until then (SSR-safe). */
  mounted: boolean;
  /** Already running as an installed app. */
  installed: boolean;
  /** iOS Safari — no install API, needs manual Share → Add to Home Screen. */
  ios: boolean;
  /** Android/Chromium captured a real install prompt we can fire. */
  canPrompt: boolean;
  /** Fire the native install dialog (Android). No-op elsewhere. */
  promptInstall: () => Promise<void>;
};

export function useInstallPrompt(): InstallState {
  const [, force] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    bindListeners();
    setMounted(true);
    setIos(detectIos());
    setInstalled(detectStandalone());

    const rerender = () => {
      setInstalled(appInstalled || detectStandalone());
      force((n) => n + 1);
    };
    subscribers.add(rerender);
    return () => {
      subscribers.delete(rerender);
    };
  }, []);

  const promptInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch {
      // User dismissed the OS dialog — nothing to do.
    }
    deferredPrompt = null;
    notify();
  };

  return {
    mounted,
    installed,
    ios,
    canPrompt: deferredPrompt !== null,
    promptInstall,
  };
}
