"use client";

import { useEffect } from "react";

// Registers the service worker (PRODUCTION ONLY) so the app is installable to
// the home screen on Android/Chrome. Side-effect only.
//
// In development a caching service worker is actively harmful: it caches built
// chunks and serves them across refreshes, so after any HMR/build change the
// browser keeps loading the OLD bundle — which produced a persistent
// "module factory is not available / deleted in an HMR update" runtime error
// that a normal refresh couldn't clear. So in dev we UNREGISTER any existing
// SW and wipe its caches instead of registering.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      // Tear down any SW left over from a prior session + its caches, so stale
      // chunks can never be served in development.
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if (window.caches) {
        caches
          .keys()
          .then((keys) => keys.forEach((k) => caches.delete(k)))
          .catch(() => {});
      }
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
