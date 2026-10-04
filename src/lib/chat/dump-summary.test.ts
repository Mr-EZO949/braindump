import { describe, expect, it } from "vitest";

import { bootstrapSummaryText, dumpSummaryText, roadmapOfferText, type DumpSummaryFacts } from "./dump-summary";

const facts = (extra: Partial<DumpSummaryFacts> = {}): DumpSummaryFacts => ({
  appliedCount: 0,
  reviewCount: 0,
  completedTitles: [],
  questionCount: 0,
  priorityChanged: false,
  otherChange: false,
  unclear: [],
  ...extra,
});

describe("dumpSummaryText", () => {
  it("says what was added and what still needs a look", () => {
    expect(dumpSummaryText(facts({ appliedCount: 1 }))).toBe("I added 1 item to your graph.");
    expect(dumpSummaryText(facts({ appliedCount: 2, reviewCount: 1 }))).toBe(
      "I added 2 items to your graph — 1 needs a quick look in the panel that just opened.",
    );
    expect(dumpSummaryText(facts({ reviewCount: 3 }))).toContain("proposed 3 nodes");
  });

  it("covers the nothing-new cases", () => {
    expect(dumpSummaryText(facts())).toBe("I went through your dump but didn't find anything new worth proposing.");
    expect(dumpSummaryText(facts({ priorityChanged: true }))).toBe("Nothing new to add — I updated what matters instead:");
    expect(dumpSummaryText(facts({ otherChange: true }))).toBe("Nothing new to add to the graph.");
  });

  it("adds completions, questions, priorities and what it couldn't change", () => {
    const text = dumpSummaryText(
      facts({
        appliedCount: 1,
        completedTitles: ["a", "b", "c", "d"],
        questionCount: 1,
        priorityChanged: true,
        unclear: ["Which midterm?"],
      }),
    );
    expect(text).toBe(
      "I added 1 item to your graph. I also marked 4 existing items done: a, b, c…. I have 1 quick clarifying question — answer inline when ready. I also updated what matters: One thing I didn't change — Which midterm? Tell me here and I'll update it.",
    );
  });
});

describe("bootstrapSummaryText", () => {
  it("reports the first dump, or that it failed", () => {
    expect(bootstrapSummaryText({ extractionFailed: true, nodeCount: 3, questionCount: 1 })).toContain("couldn't process");
    expect(bootstrapSummaryText({ extractionFailed: false, nodeCount: 1, questionCount: 2 })).toBe(
      "I analyzed your first dump and proposed 1 node and their connections — review and accept them in the panel that just opened. I have 2 quick clarifying questions — answer inline when ready.",
    );
    expect(bootstrapSummaryText({ extractionFailed: false, nodeCount: 0, questionCount: 0 })).toBe(
      "I went through your dump but didn't find anything new worth proposing yet.",
    );
  });
});

describe("roadmapOfferText", () => {
  it("names one project, a few, or a few and the rest", () => {
    expect(roadmapOfferText([{ title: "Thesis" }])).toMatch(/^"Thesis" is a project with no steps/);
    expect(roadmapOfferText([{ title: "A" }, { title: "B" }])).toMatch(/^"A" and "B" are projects/);
    expect(roadmapOfferText([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }])).toMatch(
      /^"A", "B" and "C" and 1 more are projects/,
    );
  });
});
