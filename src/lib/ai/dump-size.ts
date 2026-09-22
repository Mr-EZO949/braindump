// Dump-size classification. Pure functions (no SDK imports) so both the server
// (metering) and client (the "that was a big dump" label) can use them.
//
// A dump's cost tracks the number of NODES it extracts far better than its raw
// character length, so node count is authoritative; the character estimate is
// only for a pre-submit hint before extraction has run.

import { DUMP_SIZE, type DumpSizeTier } from "@/lib/ai/config";

export type { DumpSizeTier };

// Authoritative: classify from the number of extracted nodes.
export function classifyDumpSize(nodeCount: number): DumpSizeTier {
  if (nodeCount >= DUMP_SIZE.BIG_MIN_NODES) return "big";
  if (nodeCount >= DUMP_SIZE.MEDIUM_MIN_NODES) return "medium";
  return "small";
}

// Pre-submit estimate from raw character count (before we know the node count).
export function estimateDumpSizeFromChars(chars: number): DumpSizeTier {
  if (chars >= DUMP_SIZE.BIG_MIN_CHARS) return "big";
  if (chars >= DUMP_SIZE.MEDIUM_MIN_CHARS) return "medium";
  return "small";
}

export const DUMP_SIZE_LABEL: Record<DumpSizeTier, string> = {
  small: "Small dump",
  medium: "Medium dump",
  big: "Big dump",
};
