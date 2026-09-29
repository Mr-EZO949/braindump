import { describe, expect, it } from "vitest";

import { describePriorityDetail, parsePriorityChanges, parsePriorityUndo } from "./priority-changes";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";

describe("parsePriorityChanges", () => {
  it("rejects two status moves for one node", () => {
    const result = parsePriorityChanges({
      changes: [
        { node_id: "n1", title: "Stats", action: "wait", waiting_for: "result" },
        { node_id: "n1", title: "Stats", action: "complete" },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("resolves the user's words for a date against today", () => {
    const result = parsePriorityChanges(
      {
        changes: [
          { node_id: "n1", title: "Psych", action: "deadline", target_date: "this friday" },
          { node_id: "n2", title: "Stats", action: "wait", waiting_for: "result", check_back_on: "in 2 weeks" },
        ],
      },
      { today: "2026-10-07" },
    );
    expect(result).toMatchObject({
      ok: true,
      changes: [{ target_date: "2026-10-09" }, { check_back_on: "2026-10-21" }],
    });
    expect(parsePriorityChanges({ changes: [{ node_id: "n1", action: "deadline", target_date: "soonish" }] }, { today: "2026-10-07" }).ok).toBe(false);
  });

  it("trusts the user's words over a date the model worked out", () => {
    const result = parsePriorityChanges(
      { changes: [{ node_id: "n1", action: "deadline", target_date: "2026-10-10", date_words: "this friday" }] },
      { today: "2026-10-07" },
    );
    expect(result).toMatchObject({ ok: true, changes: [{ target_date: "2026-10-09" }] });
  });

  it("clears a deadline with an empty string", () => {
    const result = parsePriorityChanges({ changes: [{ node_id: "n1", title: "Stats", action: "deadline", target_date: "" }] });
    expect(result).toMatchObject({ ok: true, changes: [{ action: "deadline", target_date: null }] });
  });
});

describe("describePriorityDetail", () => {
  it("words each change as the state it leaves", () => {
    const [wait, deadline, stakes] = (
      parsePriorityChanges({
        changes: [
          { node_id: "a", title: "A", action: "wait", waiting_for: "exam result", check_back_on: "2026-10-15" },
          { node_id: "b", title: "B", action: "deadline", target_date: "2026-10-09" },
          { node_id: "c", title: "C", action: "stakes", stakes: "high" },
        ],
      }) as { ok: true; changes: Parameters<typeof describePriorityDetail>[0][] }
    ).changes;
    expect(describePriorityDetail(wait)).toBe("Waiting for exam result · check back Oct 15");
    expect(describePriorityDetail(deadline)).toBe("Due Oct 9");
    expect(describePriorityDetail(stakes)).toBe("High stakes");
  });
});

describe("parsePriorityUndo", () => {
  it("accepts a snapshot the tool produced", () => {
    const undo = {
      nodes: [
        { node_id: ID, status: "paused", waiting_for: "exam result", resume_on: "2026-10-15" },
        { node_id: ID, target_date: null, stakes: 1 },
      ],
      steer: [{ node_id: ID, event_type: "boost_node" }],
    };
    expect(parsePriorityUndo(undo)).toEqual({ ok: true, undo });
  });

  it("keeps absent fields absent, so Undo never touches them", () => {
    const parsed = parsePriorityUndo({ nodes: [{ node_id: ID, stakes: null }], steer: [] });
    expect(parsed.ok && parsed.undo.nodes[0]).toEqual({ node_id: ID, stakes: null });
  });

  it.each([
    [{ nodes: [{ node_id: "not-a-uuid" }] }, "bad node id"],
    [{ nodes: [{ node_id: ID, status: "deleted" }] }, "bad status"],
    [{ nodes: [{ node_id: ID, stakes: 5 }] }, "bad stakes"],
    [{ nodes: [{ node_id: ID, target_date: "Oct 9" }] }, "bad target_date"],
    [{ steer: [{ node_id: ID, event_type: "archive_node" }] }, "bad steering event"],
    [{}, "nothing to undo"],
  ])("rejects %j", (input, error) => {
    expect(parsePriorityUndo(input)).toEqual({ ok: false, error });
  });
});
