import { describe, expect, it } from "vitest";

import { parseDumpPriorityResponse, statusTouchedIds } from "./dump-priorities";

const TODAY = "2026-10-07"; // a Wednesday
const nodes = [
  { ref: "n1", id: "stats", title: "Stats final exam" },
  { ref: "n2", id: "psych", title: "Psychology exam" },
  { ref: "n3", id: "masters", title: "Masters application" },
];

describe("parseDumpPriorityResponse", () => {
  it("maps refs to nodes and resolves the user's date words", () => {
    const read = parseDumpPriorityResponse(
      JSON.stringify({
        changes: [
          { ref: "n1", action: "wait", waiting_for: "exam result", date_words: "next week" },
          { ref: "n2", action: "deadline", date_words: "this friday" },
          { ref: "n3", action: "stakes", stakes: "high" },
        ],
        unclear: [],
      }),
      nodes,
      TODAY,
    );
    expect(read.changes).toEqual([
      { node_id: "stats", title: "Stats final exam", action: "wait", waiting_for: "exam result", date_words: "next week" },
      { node_id: "psych", title: "Psychology exam", action: "deadline", date_words: "this friday" },
      { node_id: "masters", title: "Masters application", action: "stakes", stakes: "high" },
    ]);
  });

  it("drops what it can't trust, row by row", () => {
    const read = parseDumpPriorityResponse(
      '```json\n{"changes":[' +
        '{"ref":"n9","action":"focus"},' + // unknown ref
        '{"ref":"n1","action":"complete"},' + // completions belong to extraction
        '{"ref":"n2","action":"deadline","date_words":"end of term"},' + // unresolvable
        '{"ref":"n3","action":"wait","waiting_for":"reply","date_words":"sometime soon"},' + // keeps the wait
        '{"ref":"n3","action":"drop"}' + // second status move for n3
        '],"unclear":["Did you miss psychology or drop it?"]}\n```',
      nodes,
      TODAY,
    );
    expect(read.changes).toEqual([
      { node_id: "masters", title: "Masters application", action: "wait", waiting_for: "reply" },
    ]);
    expect(read.unclear).toEqual([
      "Did you miss psychology or drop it?",
      'When exactly is "Psychology exam" due?',
    ]);
  });

  it("is empty on anything that isn't JSON", () => {
    expect(parseDumpPriorityResponse("Sure! Here are the changes:", nodes, TODAY)).toEqual({ changes: [], unclear: [] });
  });
});

describe("statusTouchedIds", () => {
  it("lists nodes whose status the dump changes — they skip extraction's completion", () => {
    const read = parseDumpPriorityResponse(
      JSON.stringify({
        changes: [
          { ref: "n1", action: "wait", waiting_for: "exam result" },
          { ref: "n3", action: "focus" },
        ],
      }),
      nodes,
      TODAY,
    );
    expect([...statusTouchedIds(read)]).toEqual(["stats"]);
    expect(statusTouchedIds(null).size).toBe(0);
  });
});
