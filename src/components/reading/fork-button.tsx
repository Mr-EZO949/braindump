"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import styles from "./reading-view.module.css";

// "Fork into your own BrainDump". Anonymous visitors are sent to sign in first
// (and back to this graph); signed-in visitors get a copy in a fresh workspace.
export function ForkButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fork() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/p/${slug}/fork`, { method: "POST" });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(`/p/${slug}`)}`;
        return;
      }
      if (!res.ok) throw new Error(`fork failed: ${res.status}`);
      await res.json();
      router.push("/app");
    } catch {
      setError("Couldn't fork — try again.");
      setLoading(false);
    }
  }

  return (
    <div className={styles.forkWrap}>
      {error ? <span className={styles.forkError}>{error}</span> : null}
      <button
        type="button"
        className={styles.forkButton}
        onClick={() => void fork()}
        disabled={loading}
      >
        {loading ? "Forking…" : "Fork into your BrainDump"}
      </button>
    </div>
  );
}
