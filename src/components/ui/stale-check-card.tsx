"use client";

// "Does this still matter?" — work the user planned and skipped on 2+ days with
// no deadline (lib/planner/skips.ts). It's out of Focus's picks and new plans
// until answered here. Shown at the top of Focus and on the Planner screen
// before generating. Deterministic — no model call.

import { useState } from "react";

import { clientDayHints } from "@/lib/habits/streak";
import type { StaleAnswer, StaleItem } from "@/lib/planner/skips";

// The card stays small: a few questions at a time, the rest come back later.
const MAX_SHOWN = 3;

const ANSWER_DONE: Record<StaleAnswer, string> = {
  still_matters: "Kept — back in your picks",
  not_now: "Can wait — it'll come up later",
  drop: "Dropped",
};

type AnswerUndo = { marker_id: string; priority?: unknown };

type RowState =
  | { status: "busy"; answer: StaleAnswer | "undo" }
  | { status: "answered"; answer: StaleAnswer; undo: AnswerUndo }
  | { status: "error"; message: string };

type StaleCheckCardProps = {
  workspaceId: string;
  items: StaleItem[];
  // After an answer or an Undo: refresh whatever reads the ranking.
  onChanged?: (change: { nodeId: string; answer: StaleAnswer | "undo"; dropped: boolean }) => void;
  className?: string;
};

export function StaleCheckCard({ workspaceId, items, onChanged, className }: StaleCheckCardProps) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Answered items stay on the card (with Undo) after the server list drops them.
  const [kept, setKept] = useState<StaleItem[]>([]);

  const shown = [
    ...kept,
    ...items.filter((item) => !kept.some((k) => k.id === item.id)).slice(0, MAX_SHOWN),
  ];
  const hidden = Math.max(0, items.filter((item) => !kept.some((k) => k.id === item.id)).length - MAX_SHOWN);
  if (shown.length === 0) return null;

  const setRow = (id: string, state: RowState | null) =>
    setRows((prev) => {
      const next = { ...prev };
      if (state) next[id] = state;
      else delete next[id];
      return next;
    });

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/assistant/stale-check/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, ...clientDayHints(), ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; undo?: AnswerUndo };
    if (!res.ok) throw new Error(json.error ?? "failed");
    return json;
  };

  const answer = async (item: StaleItem, choice: StaleAnswer) => {
    setRow(item.id, { status: "busy", answer: choice });
    try {
      const json = await post({ node_id: item.id, answer: choice, skipped_on: item.skipped_on });
      if (!json.undo) throw new Error("no undo");
      setKept((prev) => (prev.some((k) => k.id === item.id) ? prev : [...prev, item]));
      setRow(item.id, { status: "answered", answer: choice, undo: json.undo });
      onChanged?.({ nodeId: item.id, answer: choice, dropped: choice === "drop" });
    } catch {
      setRow(item.id, { status: "error", message: "Couldn't save that — try again." });
    }
  };

  const undo = async (item: StaleItem) => {
    const row = rows[item.id];
    if (row?.status !== "answered") return;
    setRow(item.id, { status: "busy", answer: "undo" });
    try {
      await post({ node_id: item.id, answer: "undo", undo: row.undo });
      setKept((prev) => prev.filter((k) => k.id !== item.id));
      setRow(item.id, null);
      onChanged?.({ nodeId: item.id, answer: "undo", dropped: row.answer === "drop" });
    } catch {
      setRow(item.id, row);
    }
  };

  return (
    <section aria-label="Does this still matter?" className={`stale-check ${className ?? ""}`}>
      <span className="stale-check-eyebrow">
        <span aria-hidden="true" className="stale-check-pip" />
        Does this still matter?
      </span>
      <p className="stale-check-lede">You planned {shown.length === 1 ? "this" : "these"} and skipped {shown.length === 1 ? "it" : "them"}.</p>
      <ul className="stale-check-list">
        {shown.map((item) => {
          const row = rows[item.id];
          const busy = row?.status === "busy";
          return (
            <li className="stale-check-item" data-answered={row?.status === "answered" || undefined} key={item.id}>
              <div className="stale-check-line">
                <span className="stale-check-title">{item.title}</span>
                <span className="stale-check-days">{item.skipped_label}</span>
              </div>
              {row?.status === "answered" || (busy && row.answer === "undo") ? (
                <div className="stale-check-done">
                  <span>{row.status === "answered" ? ANSWER_DONE[row.answer] : "Undoing…"}</span>
                  {row.status === "answered" ? (
                    <button className="stale-check-undo" onClick={() => void undo(item)} type="button">
                      Undo
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="stale-check-actions">
                  <button
                    className="stale-check-btn stale-check-btn--keep"
                    disabled={busy}
                    onClick={() => void answer(item, "still_matters")}
                    type="button"
                  >
                    {busy && row.answer === "still_matters" ? "Saving…" : "Still matters"}
                  </button>
                  <button
                    className="stale-check-btn"
                    disabled={busy}
                    onClick={() => void answer(item, "not_now")}
                    type="button"
                  >
                    {busy && row.answer === "not_now" ? "Saving…" : "Not now"}
                  </button>
                  <button
                    className="stale-check-btn"
                    disabled={busy}
                    onClick={() => void answer(item, "drop")}
                    type="button"
                  >
                    {busy && row.answer === "drop" ? "Saving…" : "Drop it"}
                  </button>
                </div>
              )}
              {row?.status === "error" ? <span className="stale-check-error">{row.message}</span> : null}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? <p className="stale-check-more">+{hidden} more after these</p> : null}
    </section>
  );
}
