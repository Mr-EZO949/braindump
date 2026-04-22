// Streaming parser for the <<BRAINDUMP_PAUSE>>...<</BRAINDUMP_PAUSE>> marker
// emitted by /api/assistant/chat when Claude proposes a mutation tool call.
//
// The marker can arrive chunk-split (e.g. "<<BRAIND" + "UMP_PAUSE>>{...}..."),
// so the parser carries a small buffer across calls. Plain text before/after
// the marker is returned as `text`, and a completed marker is returned as
// `pause`. Once a marker is fully captured, subsequent chunks keep flowing
// through as text.

import type { PendingAction } from "@/types/chat";

const OPEN_TOKEN = "<<BRAINDUMP_PAUSE>>";
const CLOSE_TOKEN = "<</BRAINDUMP_PAUSE>>";

export interface PauseParseResult {
  text: string;
  pause?: Omit<PendingAction, "status">;
}

export interface PauseMarkerParser {
  push(chunk: string): PauseParseResult;
  flush(): PauseParseResult;
}

type ParserState =
  | { kind: "text"; carry: string }
  | { kind: "inside"; buffer: string };

export function createPauseMarkerParser(): PauseMarkerParser {
  let state: ParserState = { kind: "text", carry: "" };

  function parsePayload(raw: string): Omit<PendingAction, "status"> | null {
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

  return {
    push(chunk: string): PauseParseResult {
      let out = "";
      let pause: Omit<PendingAction, "status"> | undefined;
      let working =
        (state.kind === "text" ? state.carry : "") +
        (state.kind === "inside" ? "" : "") +
        chunk;

      if (state.kind === "inside") {
        working = state.buffer + chunk;
        const closeIdx = working.indexOf(CLOSE_TOKEN);
        if (closeIdx === -1) {
          state = { kind: "inside", buffer: working };
          return { text: "" };
        }
        const payload = working.slice(0, closeIdx);
        const parsed = parsePayload(payload);
        if (parsed) pause = parsed;
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
          const emit = working.slice(0, working.length - safe);
          const carry = working.slice(working.length - safe);
          out += emit;
          state = { kind: "text", carry };
          return pause ? { text: out, pause } : { text: out };
        }

        // Flush everything before the open token as plain text.
        out += working.slice(0, openIdx);
        working = working.slice(openIdx + OPEN_TOKEN.length);

        const closeIdx = working.indexOf(CLOSE_TOKEN);
        if (closeIdx === -1) {
          state = { kind: "inside", buffer: working };
          return pause ? { text: out, pause } : { text: out };
        }

        const payload = working.slice(0, closeIdx);
        const parsed = parsePayload(payload);
        if (parsed && !pause) {
          // Only surface the first marker per chunk; additional markers in the
          // same chunk would be pathological anyway (the server closes after
          // emitting one).
          pause = parsed;
        }
        working = working.slice(closeIdx + CLOSE_TOKEN.length);
        state = { kind: "text", carry: "" };
      }
    },

    flush(): PauseParseResult {
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
