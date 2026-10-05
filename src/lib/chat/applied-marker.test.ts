import { describe, expect, it } from "vitest";

import {
  appliedActionNote,
  appliedUndoEndpoint,
  createAppliedMarkerParser,
  encodeAppliedMarker,
  isPlanAction,
} from "./applied-marker";
import { createPauseMarkerParser } from "./pause-marker";

const payload = {
  tool_name: "update_priorities",
  applied: [
    {
      node_id: "n1",
      title: "Stats exam",
      action: "wait",
      detail: "Waiting for exam result",
      score_before: 72,
      score_after: 30,
    },
  ],
  failed: [],
  undo: { nodes: [{ node_id: "n1", status: "active" }], steer: [] },
};

describe("applied marker", () => {
  it("survives chunk splits and chains behind the pause parser", () => {
    const stream = `Got it — fingers crossed.${encodeAppliedMarker(payload)}`;
    const pause = createPauseMarkerParser();
    const applied = createAppliedMarkerParser();
    let text = "";
    let marker: ReturnType<typeof applied.push>["marker"];
    // Feed it 7 characters at a time — markers arrive split mid-token.
    for (let i = 0; i < stream.length; i += 7) {
      const out = applied.push(pause.push(stream.slice(i, i + 7)).text);
      text += out.text;
      marker = marker ?? out.marker;
    }
    const tail = applied.push(pause.flush().text);
    text += tail.text + applied.flush().text;

    expect(text).toBe("Got it — fingers crossed.");
    expect(marker?.items).toEqual([
      {
        nodeId: "n1",
        title: "Stats exam",
        action: "wait",
        detail: "Waiting for exam result",
        scoreBefore: 72,
        scoreAfter: 30,
      },
    ]);
    expect(marker?.undo).toEqual(payload.undo);
  });

  it("drops a malformed marker instead of showing it", () => {
    const parser = createAppliedMarkerParser();
    const out = parser.push("ok<<BRAINDUMP_APPLIED>>{not json<</BRAINDUMP_APPLIED>> done");
    expect(out.text + parser.flush().text).toBe("ok done");
    expect(out.marker).toBeUndefined();
  });

  it("tells the model what changed, and when the user undid it", () => {
    const action = {
      toolName: "update_priorities",
      items: [
        { nodeId: "n1", title: "Stats exam", action: "wait", detail: "Waiting for exam result", scoreBefore: null, scoreAfter: null },
      ],
      failed: [],
      undo: null,
    };
    expect(appliedActionNote({ ...action, status: "applied" })).toBe(
      "[Priorities updated: Stats exam — Waiting for exam result]",
    );
    expect(appliedActionNote({ ...action, status: "undone" })).toBe(
      "[The user UNDID these changes — they no longer apply; the Graph context shows the current state: Stats exam — Waiting for exam result]",
    );
  });

  it("a rebuilt day plan says so, and its Undo goes back to the earlier plan", () => {
    const action = {
      toolName: "replan_today",
      items: [{ nodeId: "n1", title: "Essay", action: "moved", detail: "15:30–17:00 (was 09:00)", scoreBefore: null, scoreAfter: null }],
      failed: [],
      undo: { replacement_id: "r1" },
    };
    expect(isPlanAction(action)).toBe(true);
    expect(appliedUndoEndpoint(action)).toBe("/api/assistant/plan/undo");
    expect(appliedActionNote({ ...action, status: "applied" })).toBe("[Today's plan updated: Essay — 15:30–17:00 (was 09:00)]");
  });
});
