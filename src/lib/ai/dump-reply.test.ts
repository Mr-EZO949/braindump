import { describe, expect, it } from "vitest";

import { parseDumpReply } from "./dump-reply";

describe("parseDumpReply", () => {
  it("NONE on the verdict line → no reply", () => {
    expect(parseDumpReply("NONE")).toBeNull();
    expect(parseDumpReply("NONE\n")).toBeNull();
    expect(parseDumpReply("none.")).toBeNull();
  });

  it("an acknowledgement is one sentence, whatever the model adds", () => {
    expect(
      parseDumpReply(
        "ACK\nA cancelled 8am after the train in, then no seat at the library — that's a lost day. You've got ML due in four days.",
      ),
    ).toBe("A cancelled 8am after the train in, then no seat at the library — that's a lost day.");
  });

  it("an answer stops at the last whole sentence within the budget", () => {
    const long =
      "ANSWER\nI'd drop the Italian crash course for now — it has no deadline and the CV is due by the 15th. The dentist can wait a week or two since it's just a booking call, and reselling has no date either. Those two have hard dates staring you down, so they stay on the list this week no matter what else comes up.";
    const reply = parseDumpReply(long)!;
    expect(reply.split(/\s+/).length).toBeLessThanOrEqual(60);
    expect(reply.endsWith(".")).toBe(true);
    expect(reply).not.toContain("Those two");
  });

  it("BOTH keeps the answer even when the two sentences run over (eval 2026-10-02)", () => {
    const reply = parseDumpReply(
      "BOTH\n\nFour hours of sleep and an ML problem set done on top of everything else is rough.\n\nThe dentist and CV are both quick wins with real deadlines coming up — I'd suggest dropping the Italian crash course and clothes reselling for this week, since neither has a deadline and you've got the stats review starting in two weeks anyway.",
    )!;
    expect(reply).toContain("Four hours of sleep");
    expect(reply).toContain("dropping the Italian crash course");
  });

  it("keeps abbreviations inside a sentence", () => {
    expect(parseDumpReply("ACK\nThe midterm on Oct. 22 and a 7am shift is a lot. More.")).toBe(
      "The midterm on Oct. 22 and a 7am shift is a lot.",
    );
  });

  it("no verdict line → the text as it is (older prompt shape)", () => {
    expect(parseDumpReply("“That's a lot for one week.”")).toBe("That's a lot for one week.");
  });
});
