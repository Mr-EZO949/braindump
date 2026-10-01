import { describe, expect, it } from "vitest";

import type { ChatMessage, PendingAction, TurnCardData } from "@/types/chat";

import { connectionsNote, turnNote } from "./turn-note";

const turn = (extra: Partial<TurnCardData> = {}): TurnCardData => ({
  added: [],
  addedStatus: "applied",
  done: [],
  links: [],
  questions: [],
  ...extra,
});

const FUSED = "22222222-2222-4222-8222-222222222222";
const pending = (status: PendingAction["status"], acceptedIndexes?: number[]): PendingAction => ({
  runId: "r1",
  toolUseId: "t1",
  toolName: "build_graph",
  status,
  acceptedIndexes,
  toolInput: {
    changes: [
      { kind: "create_node", local_ref: "n1", title: "BrainDump", node_type: "project" },
      { kind: "update", node_id: FUSED, title: "Test BrainDump" },
      { kind: "move", node_id: FUSED, new_parent_node_id: "n1" },
    ],
  },
});
const titles = new Map([[FUSED, "Test & Market BrainDump"]]);

describe("turnNote — what the chat model is told a dump changed", () => {
  it("is empty for a message that is not a dump turn, or a turn with nothing in it", () => {
    expect(turnNote({} as ChatMessage)).toBe("");
    expect(turnNote({ turn: turn() })).toBe("");
  });

  it("lists what was added, finished, linked and asked", () => {
    const note = turnNote({
      turn: turn({
        added: [
          { id: "a", proposalId: "p", title: "Review Chapters 1-4", nodeType: "big_task", parentTitle: "Pass Statistics Midterm" },
          { id: "b", proposalId: null, title: "Call the Bank", nodeType: "task", parentTitle: null },
        ],
        done: ["Go to the gym", "Update CV"],
        links: [{ sourceTitle: "ML Course Project", targetTitle: "Get Internship", edgeType: "useful_for" }],
        questions: [{ text: "Tutoring ad — a task now?" }, { text: "Which bank?", answer: "Intesa" }],
      }),
    });
    expect(note).toContain('Added to the graph: "Review Chapters 1-4" (big task, under Pass Statistics Midterm); "Call the Bank" (task)');
    expect(note).toContain("Marked done: Go to the gym; Update CV");
    expect(note).toContain("Linked: ML Course Project useful for Get Internship");
    expect(note).toContain('Asked the user: "Tutoring ad — a task now?"');
    expect(note).toContain('Asked: "Which bank?" — the user answered: "Intesa"');
  });

  it("says outright when the user undid the additions", () => {
    const note = turnNote({
      turn: turn({
        addedStatus: "undone",
        added: [{ id: "a", proposalId: "p", title: "Call the Bank", nodeType: "task", parentTitle: null }],
      }),
    });
    expect(note).toContain("UNDONE by the user");
  });

  it("separates what waits, what was accepted and what was skipped", () => {
    const base = { turn: turn({ done: ["Go to the gym"] }) };
    expect(turnNote({ ...base, pendingAction: pending("awaiting") }, titles)).toContain(
      'NOT applied yet): BrainDump · project; Test & Market BrainDump: rename to "Test BrainDump"; Move Test & Market BrainDump under BrainDump',
    );
    expect(turnNote({ ...base, pendingAction: pending("rejected") }, titles)).toContain("DECLINED by the user");
    const partial = turnNote({ ...base, pendingAction: pending("accepted", [1]) }, titles);
    expect(partial).toContain('Accepted by the user and applied: Test & Market BrainDump: rename to "Test BrainDump"');
    expect(partial).toContain("Skipped by the user: BrainDump · project; Move Test & Market BrainDump under BrainDump");
  });
});

describe("connectionsNote", () => {
  const edges = [
    { id: "e1", sourceTitle: "Test BrainDump", targetTitle: "Market BrainDump", edgeType: "supports", explanation: null },
    { id: "e2", sourceTitle: "Fixes", targetTitle: "BrainDump", edgeType: "supports", explanation: null },
  ];
  it("says which links the user kept, dismissed or has not answered", () => {
    expect(connectionsNote({ edges, status: "added", acceptedIds: ["e1"] })).toBe(
      "[Links suggested after the dump — the user added: Test BrainDump supports Market BrainDump]",
    );
    expect(connectionsNote({ edges, status: "dismissed" })).toContain("dismissed by the user");
    expect(connectionsNote({ edges, status: "awaiting" })).toContain("not answered yet");
  });
});
