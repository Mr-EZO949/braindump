import { describe, expect, it } from "vitest";

import type { ChatMessage, TurnCardData } from "@/types/chat";

import { chatHistoryForModel, dumpHistoryForEntries, mergeTurnCards } from "./thread-history";

const m = (extra: Partial<ChatMessage>): ChatMessage => ({ id: "x", role: "assistant", body: "", createdAt: "t", ...extra });

const card = (title: string, extra: Partial<TurnCardData> = {}): TurnCardData => ({
  added: [{ id: title, proposalId: null, title, nodeType: "task", parentTitle: null }],
  addedStatus: "applied",
  done: [],
  links: [],
  questions: [],
  ...extra,
});

describe("chatHistoryForModel", () => {
  it("sends text turns as they are and skips errors and empty bodies", () => {
    const history = chatHistoryForModel(
      [
        m({ role: "user", body: "hi" }),
        m({ body: "oops", status: "error" }),
        m({ body: "   " }),
        m({ body: "hello" }),
      ],
      new Map(),
    );
    expect(history).toEqual([
      { role: "user", body: "hi" },
      { role: "assistant", body: "hello" },
    ]);
  });

  it("gives a card its note so the model knows what changed", () => {
    const [turn, links] = chatHistoryForModel(
      [
        m({ body: "Added it.", turn: card("Email professor") }),
        m({
          connections: {
            status: "added",
            acceptedIds: ["e1"],
            edges: [{ id: "e1", sourceTitle: "A", targetTitle: "B", edgeType: "supports", explanation: null }],
          },
        }),
      ],
      new Map(),
    );
    expect(turn.body.startsWith("Added it.\n\n[What this changed")).toBe(true);
    expect(turn.body).toContain('"Email professor"');
    expect(links.body).toContain("A helps B");
  });
});

describe("dumpHistoryForEntries", () => {
  it("sends the last six text turns, each cut to 600 characters", () => {
    const messages = Array.from({ length: 9 }, (_, i) => m({ id: `m${i}`, body: i === 8 ? "x".repeat(700) : `b${i}` }));
    messages.push(m({ body: "failed", status: "error" }));
    const history = dumpHistoryForEntries(messages);
    expect(history).toHaveLength(6);
    expect(history[0].body).toBe("b3");
    expect(history[5].body).toHaveLength(600);
  });
});

describe("mergeTurnCards", () => {
  it("joins a second change in the same reply into one card, undo steps included", () => {
    const first = card("A", { undo: { added: ["ua"], done: [], links: [] }, questions: [{ text: "q1" }] });
    const second = card("B", { done: ["C"], undo: { added: ["ub"], done: ["uc"], links: [] } });
    const merged = mergeTurnCards(first, second);
    expect(merged.added.map((n) => n.title)).toEqual(["A", "B"]);
    expect(merged.done).toEqual(["C"]);
    expect(merged.questions).toEqual([{ text: "q1" }]);
    expect(merged.undo).toEqual({ added: ["ua", "ub"], done: ["uc"], links: [] });
    expect(mergeTurnCards(card("A"), card("B")).undo).toEqual({ added: [], done: [], links: [] });
  });
});
