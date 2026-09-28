import { describe, expect, it } from "vitest";

import { looksLikePlainQuestion, routeChatMessage } from "./chat-router";

describe("looksLikePlainQuestion", () => {
  it.each([
    "what should i focus on right now?",
    "why is the internship goal ranked so high?",
    "which of my exams matters most?",
    "should i do the master's or post-grad?",
    "am i overcommitting?",
    "is mundane fantasy worth keeping?",
    "which deadline is closest?",
    "ugh why do i keep avoiding the thesis?",
    "explain why the ML exam matters",
  ])("sends %j to Q&A", (message) => {
    expect(looksLikePlainQuestion(message)).toBe(true);
  });

  it.each([
    // actions, completions, commitments
    "I finished the CV audit",
    "can you add a task to email the prof?",
    "rename Mundane Fantasy to Mundane Fantasy Novel",
    "should i archive the reselling idea?",
    "what if I move the gym to mornings?",
    "i need to call the bank tomorrow",
    "can you break the thesis down?",
    // data the snapshot doesn't have
    "what's on my calendar?",
    "what did i get done this week?",
    "what's in my Foundation & Diagnostics project?",
    "is the italian stuff connected to the internship?",
    "what's blocking the thesis?",
    // roadmap requests
    "how do i learn linear algebra fast?",
    // not a question
    "the ML exam went badly",
  ])("keeps %j on Claude", (message) => {
    expect(looksLikePlainQuestion(message)).toBe(false);
  });

  it("keeps answers to the assistant's own question on Claude", () => {
    const history = [
      { role: "user" as const, body: "is mundane fantasy worth keeping?" },
      { role: "assistant" as const, body: "It's low priority. Want to archive it or keep it light?" },
    ];
    expect(looksLikePlainQuestion("which would you pick?", history)).toBe(false);
    expect(looksLikePlainQuestion("which would you pick?", history.slice(0, 1))).toBe(true);
  });

  it("skips long messages", () => {
    expect(looksLikePlainQuestion(`why ${"so much stuff ".repeat(40)}?`)).toBe(false);
  });
});

describe("routeChatMessage", () => {
  const base = { history: [], mode: "explain" as const, qaEnabled: true };

  it("routes structural edits to Sonnet", () => {
    expect(routeChatMessage({ ...base, message: "split the ML exam into two projects" })).toBe("sonnet");
  });

  it("routes plain questions to Q&A only when enabled and not in transform mode", () => {
    const message = "what should i focus on?";
    expect(routeChatMessage({ ...base, message })).toBe("qa");
    expect(routeChatMessage({ ...base, message, qaEnabled: false })).toBe("haiku");
    expect(routeChatMessage({ ...base, message, mode: "transform" })).toBe("haiku");
  });

  it("routes everything else to Haiku", () => {
    expect(routeChatMessage({ ...base, message: "mark the gym done" })).toBe("haiku");
  });
});
