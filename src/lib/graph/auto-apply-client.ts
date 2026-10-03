// Client side of calibrated auto-apply (policy: src/lib/ai/auto-apply.ts).
// Kept out of app-shell: the settings switch, accepting the auto-apply set,
// and undoing it.

import { AUTO_ADD_SETTING, autoAddEnabled } from "@/lib/ai/auto-apply";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Edge, Node } from "@/types/graph";

// "Add confident items without asking" (settings panel). The server reads it
// from the user's auth metadata on every dump / chat turn (autoAddEnabled).
export async function readAutoAddSetting(): Promise<boolean> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return true;
  const { data } = await supabase.auth.getUser();
  return autoAddEnabled(data.user);
}

export async function saveAutoAddSetting(enabled: boolean): Promise<boolean> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return false;
  const { error } = await supabase.auth.updateUser({ data: { [AUTO_ADD_SETTING]: enabled } });
  return !error;
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
