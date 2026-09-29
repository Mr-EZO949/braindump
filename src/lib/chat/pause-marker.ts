// Streaming parsers for the inline markers /api/assistant/chat embeds in its
// text stream:
//   <<BRAINDUMP_PAUSE>>…<</BRAINDUMP_PAUSE>>     a mutation waiting for Accept
//   <<BRAINDUMP_APPLIED>>…<</BRAINDUMP_APPLIED>> a change already applied, with
//                                                 an Undo (lib/chat/applied-marker)
//
// A marker can arrive chunk-split (e.g. "<<BRAIND" + "UMP_PAUSE>>{...}..."),
// so the parser carries a small buffer across calls. Plain text before/after
// the marker is returned as `text`, and a completed marker is returned as
// `marker`. Once a marker is fully captured, subsequent chunks keep flowing
// through as text. Parsers for different markers chain: feed one's `text`
// into the next.

import type { PendingAction } from "@/types/chat";

export interface MarkerParseResult<T> {
  text: string;
  marker?: T;
}

export interface MarkerParser<T> {
  push(chunk: string): MarkerParseResult<T>;
  flush(): MarkerParseResult<T>;
}

type ParserState =
  | { kind: "text"; carry: string }
  | { kind: "inside"; buffer: string };

export function createMarkerParser<T>(options: {
  open: string;
  close: string;
  /** Returns null for a malformed payload (the marker is then dropped). */
  parse: (raw: string) => T | null;
}): MarkerParser<T> {
  const { open: OPEN_TOKEN, close: CLOSE_TOKEN, parse } = options;
  let state: ParserState = { kind: "text", carry: "" };

  return {
    push(chunk: string): MarkerParseResult<T> {
      let out = "";
      let marker: T | undefined;
      let working = (state.kind === "text" ? state.carry : "") + chunk;

      if (state.kind === "inside") {
        working = state.buffer + chunk;
        const closeIdx = working.indexOf(CLOSE_TOKEN);
        if (closeIdx === -1) {
          state = { kind: "inside", buffer: working };
          return { text: "" };
        }
        const parsed = parse(working.slice(0, closeIdx));
        if (parsed) marker = parsed;
        working = working.slice(closeIdx + CLOSE_TOKEN.length);
        state = { kind: "text", carry: "" };
      }

      // state is now "text" — scan for opens, buffering a prefix that could be
      // the start of OPEN_TOKEN so we don't leak a partial marker.
      while (true) {
        const openIdx = working.indexOf(OPEN_TOKEN);
        if (openIdx === -1) {
          // Keep a tail that could be the start of the open token.
          const maxCarry = OPEN_TOKEN.length - 1;
          if (working.length > maxCarry) {
            out += working.slice(0, working.length - maxCarry);
            working = working.slice(working.length - maxCarry);
          }
          // Shrink carry to just the longest suffix that is a prefix of OPEN_TOKEN.
          let safe = 0;
          for (let i = 1; i <= Math.min(working.length, maxCarry); i++) {
            if (OPEN_TOKEN.startsWith(working.slice(working.length - i))) {
              safe = i;
            }
          }
          out += working.slice(0, working.length - safe);
          state = { kind: "text", carry: working.slice(working.length - safe) };
          return marker ? { text: out, marker } : { text: out };
        }

        // Flush everything before the open token as plain text.
        out += working.slice(0, openIdx);
        working = working.slice(openIdx + OPEN_TOKEN.length);

        const closeIdx = working.indexOf(CLOSE_TOKEN);
        if (closeIdx === -1) {
          state = { kind: "inside", buffer: working };
          return marker ? { text: out, marker } : { text: out };
        }

        const parsed = parse(working.slice(0, closeIdx));
        if (parsed && !marker) {
          // Only surface the first marker per chunk; additional markers in the
          // same chunk would be pathological anyway (the server emits one).
          marker = parsed;
        }
        working = working.slice(closeIdx + CLOSE_TOKEN.length);
        state = { kind: "text", carry: "" };
      }
    },

    flush(): MarkerParseResult<T> {
      if (state.kind === "text") {
        const out = state.carry;
        state = { kind: "text", carry: "" };
        return { text: out };
      }
      // Unterminated marker — emit the raw buffer as text rather than losing it.
      const out = OPEN_TOKEN + state.buffer;
      state = { kind: "text", carry: "" };
      return { text: out };
    },
  };
}

// ── Pause marker (Accept/Reject card) ──────────────────────────────────────

export interface PauseParseResult {
  text: string;
  pause?: Omit<PendingAction, "status">;
}

export interface PauseMarkerParser {
  push(chunk: string): PauseParseResult;
  flush(): PauseParseResult;
}

function parsePausePayload(raw: string): Omit<PendingAction, "status"> | null {
  try {
    const parsed = JSON.parse(raw) as {
      run_id?: unknown;
      tool_use_id?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
    };
    if (
      typeof parsed.run_id !== "string" ||
      typeof parsed.tool_use_id !== "string" ||
      typeof parsed.tool_name !== "string"
    ) {
      return null;
    }
    const input =
      parsed.tool_input && typeof parsed.tool_input === "object"
        ? (parsed.tool_input as Record<string, unknown>)
        : {};
    return {
      runId: parsed.run_id,
      toolUseId: parsed.tool_use_id,
      toolName: parsed.tool_name,
      toolInput: input,
    };
  } catch {
    return null;
  }
}

export function createPauseMarkerParser(): PauseMarkerParser {
  const parser = createMarkerParser({
    open: "<<BRAINDUMP_PAUSE>>",
    close: "<</BRAINDUMP_PAUSE>>",
    parse: parsePausePayload,
  });
  const toPause = (result: MarkerParseResult<Omit<PendingAction, "status">>): PauseParseResult =>
    result.marker ? { text: result.text, pause: result.marker } : { text: result.text };
  return {
    push: (chunk) => toPause(parser.push(chunk)),
    flush: () => toPause(parser.flush()),
  };
}
