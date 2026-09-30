"use client";

// Details: the fixed weekly times linked to this node, one quiet line each
// ("◷ Mon–Fri 14:00–15:00 · until Dec 20") — docs/commitments.md. Reads its
// own rows (one indexed query, off the critical path); nothing renders until
// there is something to show, and then it fades in.

import { useEffect, useState } from "react";

import { todayIsoDate } from "@/lib/planner/auto-schedule";
import {
  COMMITMENT_SELECT,
  describeCommitment,
  normalizeCommitment,
  type Commitment,
} from "@/lib/planner/commitments";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export function NodeSchedule({ nodeId }: { nodeId: string }) {
  const [rows, setRows] = useState<{ nodeId: string; items: Commitment[] } | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let active = true;
    const today = todayIsoDate();
    void supabase
      .from("commitments")
      .select(COMMITMENT_SELECT)
      .eq("node_id", nodeId)
      .or(`ends_on.is.null,ends_on.gte.${today}`)
      .then(({ data }) => {
        if (!active) return;
        const items = ((data ?? []) as Record<string, unknown>[])
          .map(normalizeCommitment)
          .filter((c): c is Commitment => c !== null);
        setRows({ nodeId, items });
      });
    return () => {
      active = false;
    };
  }, [nodeId]);

  // Rows from a previously selected node never flash on this one.
  const items = rows?.nodeId === nodeId ? rows.items : [];
  if (items.length === 0) return null;
  const today = todayIsoDate();

  return (
    <div className="detail-schedule">
      {items.map((c) => (
        <span className="detail-schedule-line" key={c.id}>
          <span className="detail-schedule-icon" aria-hidden="true">
            ◷
          </span>
          {/* Several times on one node (lecture + lab) need their names. */}
          {items.length > 1 ? `${c.title} · ` : ""}
          {describeCommitment(c, today, { openEnd: false })}
        </span>
      ))}
    </div>
  );
}
