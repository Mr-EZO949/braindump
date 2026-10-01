// Links the connection engine noticed after a turn added nodes, as a card in
// the same thread — each one the user's call. Before 2026-10-01 they arrived
// as a "Suggested connections" modal over everything, 20 s after the dump.

import { useState } from "react";

import { edgeLabel } from "@/lib/chat/change-describe";
import type { ConnectionsCardData } from "@/types/chat";

interface ConnectionsCardProps {
  connections: ConnectionsCardData;
  disabled: boolean;
  // null → dismiss them all.
  onResolve: (acceptedIds: string[] | null) => void;
}

export function ConnectionsCard({ connections, disabled, onResolve }: ConnectionsCardProps) {
  const { edges, status } = connections;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(edges.map((e) => e.id)));
  const choosing = status === "awaiting" || status === "error";
  const kept = new Set(connections.acceptedIds ?? []);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const heading =
    status === "added"
      ? `Linked ${kept.size}`
      : status === "dismissed"
        ? "Left unlinked"
        : `Links I noticed · ${edges.length}`;

  return (
    <div className="turn-card" role="group" aria-label="Links I noticed">
      <section className="turn-section">
        <div className="applied-card-head">
          {status === "added" ? (
            <span className="applied-card-mark" aria-hidden="true">⇄</span>
          ) : (
            <span className="applied-card-mark applied-card-mark--ask" aria-hidden="true">⇄</span>
          )}
          <span className="applied-card-title">{heading}</span>
          {status === "saving" ? <span className="applied-card-busy">Saving…</span> : null}
        </div>
        <ul className="change-list">
          {edges.map((edge) => {
            const on = choosing ? selected.has(edge.id) : status === "added" && kept.has(edge.id);
            const body = (
              <>
                <span className={`change-row-box${on ? " change-row-box--on" : ""}`} aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                <span className="change-row-text">
                  {edge.sourceTitle} <span className="change-row-relation">{edgeLabel(edge.edgeType)}</span>{" "}
                  {edge.targetTitle}
                  {edge.explanation ? <span className="change-row-why">{edge.explanation}</span> : null}
                </span>
              </>
            );
            return choosing ? (
              <li key={edge.id}>
                <button
                  aria-pressed={on}
                  className={`change-row${on ? "" : " change-row--off"}`}
                  disabled={disabled}
                  onClick={() => toggle(edge.id)}
                  type="button"
                >
                  {body}
                </button>
              </li>
            ) : (
              <li className={`change-row change-row--static${on ? "" : " change-row--off"}`} key={edge.id}>
                {body}
              </li>
            );
          })}
        </ul>
        {choosing ? (
          <div className="pending-action-actions">
            <button
              className="pending-action-btn pending-action-btn-accept"
              disabled={disabled || selected.size === 0}
              onClick={() => onResolve(edges.filter((e) => selected.has(e.id)).map((e) => e.id))}
              type="button"
            >
              {selected.size === edges.length
                ? edges.length === 1
                  ? "Add link"
                  : `Add all ${edges.length}`
                : `Add ${selected.size} of ${edges.length}`}
            </button>
            <button
              className="pending-action-btn pending-action-btn-reject"
              disabled={disabled}
              onClick={() => onResolve(null)}
              type="button"
            >
              Not now
            </button>
          </div>
        ) : null}
        {status === "error" ? (
          <p className="applied-card-note applied-card-note--error">Couldn&apos;t save that — try again.</p>
        ) : null}
      </section>
    </div>
  );
}
