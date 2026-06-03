"use client";

// PushToggleButton — opt-in/out for web-push nudge notifications.
// Hidden when the browser doesn't support push, or VAPID isn't configured.

import { useEffect, useState } from "react";

const PUBLIC_VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

type State = "loading" | "unsupported" | "denied" | "off" | "on" | "busy";

export function PushToggleButton() {
  const [state, setState] = useState<State>("loading");
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window &&
      Boolean(PUBLIC_VAPID);
    if (!supported) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    (async () => {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        setEndpoint(existing.endpoint);
        setState("on");
      } else {
        setState("off");
      }
    })().catch(() => setState("off"));
  }, []);

  if (state === "loading" || state === "unsupported") return null;

  const enable = async () => {
    setState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const keyBytes = urlBase64ToUint8Array(PUBLIC_VAPID!);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer as ArrayBuffer,
      });
      const json = sub.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: json.keys,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
      setEndpoint(sub.endpoint);
      setState("on");
    } catch (err) {
      console.error("[push] enable failed:", err);
      setState("off");
    }
  };

  const disable = async () => {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await fetch(
          `/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`,
          { method: "DELETE" },
        );
      } else if (endpoint) {
        await fetch(
          `/api/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`,
          { method: "DELETE" },
        );
      }
      setEndpoint(null);
      setState("off");
    } catch (err) {
      console.error("[push] disable failed:", err);
      setState("on");
    }
  };

  if (state === "denied") {
    return (
      <button
        className="sp-menu-btn"
        type="button"
        disabled
        title="Notifications blocked in browser settings"
      >
        Notifications blocked
      </button>
    );
  }

  return (
    <button
      className="sp-menu-btn"
      type="button"
      onClick={state === "on" ? disable : enable}
      disabled={state === "busy"}
    >
      {state === "busy"
        ? "…"
        : state === "on"
          ? "Disable notifications"
          : "Enable notifications"}
    </button>
  );
}
