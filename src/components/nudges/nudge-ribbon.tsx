"use client";

// NudgeRibbon — AI-initiated reach-out surface.
// Renders the top-most pending nudge as a slim strip above the app. Three
// actions: Open (navigate to node + mark actioned), Snooze 1w, Dismiss.
// Polls /api/nudges on mount and when the window regains focus.

import { useCallback, useEffect, useState } from "react";

type Nudge = {
  id: string;
  kind: "stale" | "newly_ready" | "due_soon";
  title: string;
  body: string;
  node_id: string | null;
  workspace_id: string;
  status: string;
  created_at: string;
};

const KIND_GLYPH: Record<Nudge["kind"], string> = {
  stale: "✦",
  newly_ready: "→",
  due_soon: "◷",
};

type Props = {
  onOpenNode: (nodeId: string, workspaceId: string) => void;
};

export function NudgeRibbon({ onOpenNode }: Props) {
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/nudges", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { nudges?: Nudge[] };
      setNudges(data.nudges ?? []);
    } catch {
      // Network blip — keep what we have.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const visible = nudges.filter((n) => !hidden.has(n.id));
  const top = visible[0];
  if (!top) return null;

  const updateNudge = async (
    id: string,
    payload: { status: string; snoozed_until?: string },
  ) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await fetch(`/api/nudges/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // best-effort
    }
  };

  const handleOpen = () => {
    void updateNudge(top.id, { status: "actioned" });
    if (top.node_id) onOpenNode(top.node_id, top.workspace_id);
  };

  const handleSnooze = () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    void updateNudge(top.id, { status: "snoozed", snoozed_until: until });
  };

  const handleDismiss = () => {
    void updateNudge(top.id, { status: "dismissed" });
  };

  return (
    <div className="nudge-ribbon" data-kind={top.kind}>
      <span className="nudge-ribbon-glyph">{KIND_GLYPH[top.kind]}</span>
      <div className="nudge-ribbon-body">
        <p className="nudge-ribbon-title">{top.title}</p>
        <p className="nudge-ribbon-detail">{top.body}</p>
      </div>
      <div className="nudge-ribbon-actions">
        {top.node_id ? (
          <button
            type="button"
            className="nudge-ribbon-action nudge-ribbon-action-primary"
            onClick={handleOpen}
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          className="nudge-ribbon-action"
          onClick={handleSnooze}
          title="Snooze for a week"
        >
          Snooze
        </button>
        <button
          type="button"
          className="nudge-ribbon-action nudge-ribbon-action-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {visible.length > 1 ? (
        <span className="nudge-ribbon-count">+{visible.length - 1}</span>
      ) : null}
    </div>
  );
}
