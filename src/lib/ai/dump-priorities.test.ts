import { describe, expect, it } from "vitest";

import { mentionsWeeklyTime, parseDumpPriorityResponse, saidInDump, statusTouchedIds } from "./dump-priorities";

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
    expect(parseDumpPriorityResponse("Sure! Here are the changes:", nodes, TODAY)).toEqual({
      changes: [],
      commitments: [],
      unclear: [],
    });
  });
});

describe("parseDumpPriorityResponse — fixed commitments", () => {
  const practice = {
    ref: "c1",
    id: "11111111-1111-4111-8111-111111111111",
    title: "Volleyball practice",
    node_id: null,
    days: [2, 4],
    start_time: "17:00",
    end_time: "18:30",
    starts_on: null,
    ends_on: null,
  };

  const statsClass = { ref: "n1", id: "33333333-3333-4333-8333-333333333333", title: "Stats" };

  it("turns adds, updates and removes into set_commitments rows", () => {
    const read = parseDumpPriorityResponse(
      JSON.stringify({
        changes: [],
        commitments: [
          { action: "add", title: "Stats lecture", days: ["mon", "tue", "wed", "thu", "fri"], start: "14:00", until: "dec 20", node: "n1" },
          { action: "update", ref: "c1", start: "18:00" },
        ],
      }),
      [statsClass],
      TODAY,
      [practice],
    );
    expect(read.commitments).toEqual([
      {
        action: "add",
        title: "Stats lecture",
        days: ["mon", "tue", "wed", "thu", "fri"],
        start_time: "14:00",
        node_id: statsClass.id,
        until: "dec 20",
      },
      { action: "update", commitment_id: practice.id, start_time: "18:00" },
    ]);
  });

  it("picks up a commitment row filed under changes", () => {
    const read = parseDumpPriorityResponse(
      JSON.stringify({ changes: [{ ref: "c1", action: "update", start: "18:00" }], commitments: [] }),
      nodes,
      TODAY,
      [practice],
    );
    expect(read.changes).toEqual([]);
    expect(read.commitments).toEqual([{ action: "update", commitment_id: practice.id, start_time: "18:00" }]);
  });

  it("keeps a commitment whose end date it can't read, and asks about it", () => {
    const read = parseDumpPriorityResponse(
      JSON.stringify({
        commitments: [
          { action: "add", title: "Stats lecture", days: ["mon"], start: "14:00", until: "end of term" },
          { action: "add", title: "No time", days: ["mon"] }, // no start → dropped
          { action: "remove", ref: "c9" }, // unknown ref → dropped
          { action: "remove", ref: "c1" },
        ],
      }),
      nodes,
      TODAY,
      [practice],
    );
    expect(read.commitments).toEqual([
      { action: "add", title: "Stats lecture", days: ["mon"], start_time: "14:00" },
      { action: "remove", commitment_id: practice.id },
    ]);
    expect(read.unclear).toEqual(["When does Stats lecture end?"]);
  });
});

describe("mentionsWeeklyTime", () => {
  it("needs a clock time and a weekday or repeat word", () => {
    expect(mentionsWeeklyTime("I have stats every day at 2pm")).toBe(true);
    expect(mentionsWeeklyTime("work tue/thu 9:00 to 17:00")).toBe(true);
    expect(mentionsWeeklyTime("practice on mondays at 6 pm")).toBe(true);
    expect(mentionsWeeklyTime("call mom at 2pm")).toBe(false);
    expect(mentionsWeeklyTime("finish the essay by friday")).toBe(false);
    expect(mentionsWeeklyTime("ugh stats is killing me")).toBe(false);
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

  it("'updated my cv so that's done' read as resume on an active node: dropped, the completion stands (e2e 2026-10-02)", () => {
    const withStatus = [
      { ref: "n1", id: "cv", title: "Update CV", status: "active" },
      { ref: "n2", id: "visa", title: "Visa appointment", status: "paused" },
    ];
    const read = parseDumpPriorityResponse(
      JSON.stringify({ changes: [{ ref: "n1", action: "resume" }, { ref: "n2", action: "resume" }] }),
      withStatus,
      TODAY,
    );
    expect(read.changes.map((c) => c.node_id)).toEqual(["visa"]);
    expect(statusTouchedIds(read).size).toBe(0);
  });
});

describe("parseDumpPriorityResponse — questions name items, not refs", () => {
  const nodes = [
    { ref: "n10", id: "career", title: "Income & Career" },
    { ref: "n12", id: "italian", title: "Italian Crash Course" },
    { ref: "n14", id: "personal", title: "Personal Development" },
  ];
  it("replaces refs the model wrote into a question with the items' titles", () => {
    const read = parseDumpPriorityResponse(
      JSON.stringify({
        changes: [],
        unclear: ["Should n12 (Italian Crash Course) move from n10 (Income & Career) to n14, or stay?"],
      }),
      nodes,
      "2026-10-01",
    );
    expect(read.unclear).toEqual([
      'Should "Italian Crash Course" move from "Income & Career" to "Personal Development", or stay?',
    ]);
  });
});


describe("parseDumpPriorityResponse — stakes and focus only from the user's words (fix list #5)", () => {
  const read = (rows: unknown[], dump: string) =>
    parseDumpPriorityResponse(JSON.stringify({ changes: rows, unclear: [] }), nodes, TODAY, [], dump).changes;

  it("keeps a weight the dump says, quoted however the model spaced it", () => {
    const dump = "ugh the masters app.  I NEED this for my masters, honestly. focus on stats this week";
    expect(
      read(
        [
          { ref: "n3", action: "stakes", stakes: "high", said: "I need this for my masters" },
          { ref: "n1", action: "focus", said: "“focus on stats this week”" },
        ],
        dump,
      ).map((c) => c.action),
    ).toEqual(["stakes", "focus"]);
  });

  it("reads stakes written as 'level' (eval, dump-priorities-v4)", () => {
    const dump = "the internship is the one that matters, my whole masters application depends on getting it";
    expect(
      read([{ ref: "n3", action: "stakes", level: "high", said: "my whole masters application depends on getting it" }], dump),
    ).toEqual([{ node_id: "masters", title: "Masters application", action: "stakes", stakes: "high" }]);
  });

  it("drops a weight read from tone: no quote, or words the user never wrote", () => {
    const dump = "so stressed about the masters application, i keep thinking about it and can't sleep";
    expect(
      read(
        [
          { ref: "n3", action: "stakes", stakes: "high" },
          { ref: "n3", action: "focus", said: "this matters most right now" },
          { ref: "n1", action: "deprioritize", said: "ok" },
        ],
        dump,
      ),
    ).toEqual([]);
  });

  it("leaves waits, deadlines and drops alone — they need no quote", () => {
    const dump = "took the stats final, waiting for results. psych moved to friday";
    expect(
      read(
        [
          { ref: "n1", action: "wait", waiting_for: "results" },
          { ref: "n2", action: "deadline", date_words: "friday" },
        ],
        dump,
      ).map((c) => c.action),
    ).toEqual(["wait", "deadline"]);
  });

  it("saidInDump ignores case, curly quotes and edge punctuation, not the words", () => {
    expect(saidInDump("“It’s pass/fail.”", "honestly it's pass/fail so whatever")).toBe(true);
    expect(saidInDump("it is pass/fail", "honestly it's pass/fail so whatever")).toBe(false);
    expect(saidInDump("so", "so stressed")).toBe(false);
  });
});
