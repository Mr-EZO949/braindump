// Client side of calibrated auto-apply (policy: src/lib/ai/auto-apply.ts).
// Kept out of app-shell so the dump flow only wires three calls:
// read the preference, accept the auto-apply set, and undo it.

import type { Edge, Node } from "@/types/graph";

const PREFERENCE_KEY = "braindump:auto-apply";

// "Auto-add confident items" — on unless the user turned it off.
export function readAutoApplyPreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAutoApplyPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, enabled ? "on" : "off");
  } catch {
    /* ignore — preference just won't persist */
  }
}

export interface AcceptedBatch {
  acceptedNodes: Node[];
  acceptedEdges: Edge[];
}

// Accept proposals through the normal review route (same node creation,
// structural edges, embeddings and clustering as a manual accept).
export async function acceptProposalsNow(proposalIds: string[]): Promise<AcceptedBatch | null> {
  if (proposalIds.length === 0) return null;
  try {
    const res = await fetch("/api/proposals/nodes/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions: proposalIds.map((id) => ({ id, action: "accept" })) }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accepted_nodes?: Node[]; accepted_edges?: Edge[] };
    return { acceptedNodes: data.accepted_nodes ?? [], acceptedEdges: data.accepted_edges ?? [] };
  } catch {
    return null;
  }
}

// One-tap Undo: deletes what was auto-applied and marks those proposals
// rejected (which teaches the calibration). Returns the removed node ids.
export async function undoAutoApplied(proposalIds: string[]): Promise<string[]> {
  if (proposalIds.length === 0) return [];
  try {
    const res = await fetch("/api/proposals/nodes/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposal_ids: proposalIds }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { node_ids?: string[] };
    return data.node_ids ?? [];
  } catch {
    return [];
  }
}
