// A long brain dump takes 20–35 s; until 2026-10-02 the user watched a bare
// spinner for all of it. With `stream: true` /api/entries answers in NDJSON:
// one line per stage as the dump moves through the builder, then the result —
// the same JSON the plain request returns (docs/unified-turn.md, phase 5).
// Shared by the route (stage names) and the client (reading the stream).

export type DumpStage = "reading" | "building" | "reorganizing" | "applying";

export const DUMP_STAGE_LABEL: Record<DumpStage, string> = {
  reading: "Reading it",
  building: "Sorting it into your graph",
  reorganizing: "Moving things around as you asked",
  applying: "Saving",
};

export function isDumpStage(value: unknown): value is DumpStage {
  return typeof value === "string" && value in DUMP_STAGE_LABEL;
}

// The response as { status, data }, whether it streamed or not. Stage lines
// call onStage; a stream that ends without its result line is a failure.
export async function readDumpResponse<T = Record<string, unknown>>(
  res: Response,
  onStage: (stage: DumpStage) => void,
): Promise<{ status: number; data: Partial<T> }> {
  if (!(res.headers.get("Content-Type") ?? "").includes("ndjson") || !res.body) {
    return { status: res.status, data: ((await res.json().catch(() => ({}))) ?? {}) as Partial<T> };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (line: string): { status: number; data: Partial<T> } | null => {
    if (!line.trim()) return null;
    try {
      const parsed = JSON.parse(line) as { stage?: unknown; status?: unknown; result?: unknown };
      if (isDumpStage(parsed.stage)) onStage(parsed.stage);
      if (parsed.result && typeof parsed.result === "object") {
        return { status: typeof parsed.status === "number" ? parsed.status : 200, data: parsed.result as Partial<T> };
      }
    } catch {
      // A torn line can't happen (we split on newlines); anything else is skipped.
    }
    return null;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const result = take(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (result) return result;
      newline = buffer.indexOf("\n");
    }
  }
  return take(buffer) ?? { status: 500, data: {} };
}
