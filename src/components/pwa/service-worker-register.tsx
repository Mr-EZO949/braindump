"use client";

import { useEffect } from "react";

// Registers the service worker after load. Required for the app to be
// installable to the home screen on Android/Chrome. Side-effect only.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failure must never break the app — installability is
        // a progressive enhancement, not a requirement.
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
