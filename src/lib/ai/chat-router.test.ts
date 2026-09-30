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

  // Outcome reports change the ranking — they need Claude's tools, even when
  // phrased as a question (Gemini answered these instead of handing off).
  it.each([
    "is stats still important now that the exam is over?",
    "is psych even worth stressing about now that I got into the masters program?",
    "got my stats result back, did I pass?",
    "psych got pushed back a week?",
    "is it fine that psych is pass/fail?",
  ])("keeps the outcome report %j on Claude", (message) => {
    expect(looksLikePlainQuestion(message)).toBe(false);
  });

  it.each(["can psych wait?", "what should I focus on?", "why is psych so big?", "which goal matters most?"])(
    "still sends the plain question %j to Q&A",
    (message) => {
      expect(looksLikePlainQuestion(message)).toBe(true);
    },
  );

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

  it("keeps the follow-ups of a restructure on Sonnet", () => {
    // The 2026-09-30 thread: the restructure was offered, then "yeah", then a
    // complaint — neither follow-up carries a structural word.
    const history = [
      {
        role: "assistant" as const,
        body: "You mentioned restructuring so 'BrainDump' becomes a separate project with 'Test & Market BrainDump' as a task under it — want me to convert it?",
      },
      { role: "user" as const, body: "yeah" },
    ];
    expect(routeChatMessage({ ...base, history, message: "i dont see any changes" })).toBe("sonnet");
    expect(routeChatMessage({ ...base, history: history.slice(0, 1), message: "yeah" })).toBe("sonnet");
  });

  it("does not pin a thread to Sonnet because of a long dump or an old turn", () => {
    const dump = {
      role: "user" as const,
      body: `${"i need to start making money and finish my exams. ".repeat(20)} add these under the project: a, b, c, d`,
    };
    expect(routeChatMessage({ ...base, history: [dump], message: "mark the gym done" })).toBe("haiku");
    const old = [
      { role: "user" as const, body: "split the ML exam into two projects" },
      { role: "assistant" as const, body: "Done." },
      { role: "user" as const, body: "thanks" },
      { role: "assistant" as const, body: "Anything else?" },
      { role: "user" as const, body: "the gym went well" },
      { role: "assistant" as const, body: "Nice." },
    ];
    expect(routeChatMessage({ ...base, history: old, message: "mark the gym done" })).toBe("haiku");
  });
});
