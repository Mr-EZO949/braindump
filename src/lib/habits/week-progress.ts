"use client";

// This ISO week's check-ins per habit, for the cadence dots on the graph
// (a habit with a 3×/week target shows three dots, filled as it's done).
// One query for every habit in view; refetched whenever the graph reloads.

import { useEffect, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Node } from "@/types/graph";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Monday of the current local week, as YYYY-MM-DD (completions are stored as
// the user's local date).
export function localWeekStartISO(now: Date = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export function useHabitWeekProgress(nodes: Node[]): ReadonlyMap<string, number> {
  const [doneByHabit, setDoneByHabit] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    const habitIds = nodes
      .filter((n) => n.node_type === "habit" && n.habit_target_per_week && n.status !== "archived")
      .map((n) => n.id);
    const supabase = getSupabaseBrowserClient();
    if (habitIds.length === 0 || !supabase) return;

    let cancelled = false;
    void supabase
      .from("habit_completions")
      .select("node_id")
      .gte("completed_on", localWeekStartISO())
      .in("node_id", habitIds)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const counts = new Map<string, number>();
        for (const row of data as Array<{ node_id: string }>) {
          counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
        }
        setDoneByHabit(counts);
      });
    return () => {
      cancelled = true;
    };
  }, [nodes]);

  return doneByHabit;
}
