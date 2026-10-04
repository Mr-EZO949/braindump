"use client";

// The on-load anti-freeze nudge: "N items look ready for a next step", opening
// the step picker on them. Occasional, not every reload — a localStorage snooze
// gates it: showing it snoozes briefly, dismissing it snoozes for weeks.

import { useEffect, useRef, useState } from "react";

import type { AppMode } from "@/components/ui/mode-dock";
import type { Node } from "@/types/graph";

import type { StepSuggestions } from "./use-step-suggestions";

const SNOOZE_KEY = "braindump:freeze-nudge-snooze";

export function useFreezeNudge({
  userId,
  workspaceId,
  appMode,
  needsActionNodes,
  steps,
  whatNowOpen,
  brainDumpOpen,
}: {
  userId: string | null;
  workspaceId: string | null;
  appMode: AppMode;
  needsActionNodes: Node[];
  steps: Pick<StepSuggestions, "stepSuggestionOpen" | "offerSteps">;
  whatNowOpen: boolean;
  brainDumpOpen: boolean;
}) {
  // Dismissible; resets when the workspace (re)loads.
  const [freezeNudgeDismissed, setFreezeNudgeDismissed] = useState(false);
  const [freezeNudgeAllowed, setFreezeNudgeAllowed] = useState(false);
  const freezeNudgeShownRef = useRef(false);
  useEffect(() => {
    try {
      const until = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read the snooze after hydration
      setFreezeNudgeAllowed(!(Number.isFinite(until) && Date.now() < until));
    } catch {
      setFreezeNudgeAllowed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a newly loaded workspace may nudge again
    setFreezeNudgeDismissed(false);
  }, [userId, workspaceId]);

  const snoozeFreezeNudge = (days: number) => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + days * 24 * 60 * 60 * 1000));
    } catch {
      /* localStorage unavailable — nudge just isn't throttled */
    }
  };

  // Once the nudge is actually visible this session, snooze it so it doesn't
  // greet the user on the next few reloads.
  useEffect(() => {
    const visible =
      appMode === "graph" &&
      freezeNudgeAllowed &&
      !freezeNudgeDismissed &&
      !steps.stepSuggestionOpen &&
      needsActionNodes.length > 0;
    if (visible && !freezeNudgeShownRef.current) {
      freezeNudgeShownRef.current = true;
      try {
        localStorage.setItem(SNOOZE_KEY, String(Date.now() + 2 * 24 * 60 * 60 * 1000));
      } catch {
        /* ignore */
      }
    }
  }, [appMode, freezeNudgeAllowed, freezeNudgeDismissed, steps.stepSuggestionOpen, needsActionNodes.length]);

  const showFreezeNudge =
    appMode === "graph" &&
    freezeNudgeAllowed &&
    !freezeNudgeDismissed &&
    !steps.stepSuggestionOpen &&
    !whatNowOpen &&
    !brainDumpOpen &&
    needsActionNodes.length > 0;

  // Open the SELECTIVE picker pre-loaded with the nodes that look ready for a
  // next step (capped so it never feels like a wall).
  const mapOutNeedsAction = () => {
    const candidates = needsActionNodes.slice(0, 8);
    if (candidates.length === 0) return;
    snoozeFreezeNudge(7);
    steps.offerSteps(candidates);
  };

  const dismissFreezeNudge = () => {
    setFreezeNudgeDismissed(true);
    snoozeFreezeNudge(14);
  };

  return { showFreezeNudge, readyCount: needsActionNodes.length, mapOutNeedsAction, dismissFreezeNudge };
}
