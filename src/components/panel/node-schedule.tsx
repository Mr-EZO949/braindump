"use client";

// Details: the fixed weekly times linked to this node ("Stats lecture ·
// Mon–Fri 14:00–15:00 · until Dec 20") — docs/commitments.md. Reads its own
// rows (one indexed query, off the critical path); nothing renders until
// there is something to show.

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
    <div className="detail-waiting detail-schedule">
      <span className="detail-waiting-icon" aria-hidden="true">
        ◷
      </span>
      <div className="detail-waiting-text">
        {items.map((c) => (
          <span className="detail-waiting-title" key={c.id}>
            {describeCommitment(c, today)}
          </span>
        ))}
        <span className="detail-waiting-sub">Fixed every week — Focus and the planner work around it</span>
      </div>
    </div>
  );
}
