// A dump's "Your week" card: the fixed weekly times it named ("stats every
// day at 2pm", docs/commitments.md) and the standing preferences it stated
// ("I want to spend 4h a day coding", docs/preferences.md), saved at once with
// ONE Undo (POST /api/assistant/commitments/undo undoes both halves). Both
// paths of POST /api/entries use it.

import type { DumpPriorityRead } from "./dump-priorities";
import { applyCommitmentChanges } from "./tools/commitment-mutations";
import { applyPreferenceChanges } from "./tools/preference-mutations";
import type { ToolContext } from "./tools/read-only";
import type { AppliedMarkerPayload } from "@/lib/chat/applied-marker";

export type DumpScheduleUpdate = Pick<AppliedMarkerPayload, "applied" | "failed" | "undo">;

export async function saveDumpSchedule(
  ctx: ToolContext,
  read: DumpPriorityRead | null,
): Promise<DumpScheduleUpdate | null> {
  if (!read || (read.commitments.length === 0 && read.preferences.length === 0)) return null;
  const [commitments, preferences] = await Promise.all([
    read.commitments.length > 0 ? applyCommitmentChanges(ctx, { changes: read.commitments }, "dump") : null,
    read.preferences.length > 0 ? applyPreferenceChanges(ctx, { changes: read.preferences }) : null,
  ]);
  const savedCommitments = commitments?.accepted && "undo" in commitments ? commitments : null;
  const savedPreferences = preferences?.accepted && "undo" in preferences ? preferences : null;
  if (!savedCommitments && !savedPreferences) return null;
  return {
    applied: [...(savedCommitments?.applied ?? []), ...(savedPreferences?.applied ?? [])],
    failed: savedCommitments?.failed ?? [],
    undo: {
      created: savedCommitments?.undo?.created ?? [],
      before: savedCommitments?.undo?.before ?? [],
      ...(savedPreferences ? { preferences: savedPreferences.undo } : {}),
    },
  };
}
