"use client";

import { useState } from "react";

import styles from "@/app/app/share/share.module.css";

export function WorkspaceShareControls({
  workspaceId,
  name,
  initialIsPublic,
  initialSlug,
}: {
  workspaceId: string;
  name: string;
  initialIsPublic: boolean;
  initialSlug: string | null;
}) {
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [slug, setSlug] = useState(initialSlug);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shareUrl = slug && typeof window !== "undefined" ? `${window.location.origin}/p/${slug}` : null;

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/share`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: next }),
      });
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      const data = (await res.json()) as { is_public: boolean; slug: string | null };
      setIsPublic(data.is_public);
      if (data.slug) setSlug(data.slug);
    } catch {
      setError("Couldn't update sharing — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy the link.");
    }
  }

  return (
    <div className={styles.controls}>
      <div className={styles.controlsHead}>
        <div className={styles.nameBlock}>
          <span className={styles.name}>{name}</span>
          <span className={`${styles.badge} ${isPublic ? styles.badgeOn : ""}`}>
            {isPublic ? "Public" : "Private"}
          </span>
        </div>
        <button
          type="button"
          className={isPublic ? styles.buttonGhost : styles.buttonPrimary}
          onClick={() => void toggle(!isPublic)}
          disabled={busy}
        >
          {busy ? "…" : isPublic ? "Make private" : "Make public"}
        </button>
      </div>

      {isPublic && shareUrl ? (
        <div className={styles.linkRow}>
          <a href={shareUrl} className={styles.link} target="_blank" rel="noreferrer">
            {shareUrl}
          </a>
          <button type="button" className={styles.copyButton} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}
