import { describe, expect, it } from "vitest";

import { actionSucceeded, confirmationFor, looksMultiStep } from "./confirmations";

describe("confirmationFor", () => {
  it("uses the tool's own message when it has one", () => {
    expect(confirmationFor("plan_day", JSON.stringify({ accepted: true, message: "Drafted a full-day plan with 9 blocks." }))).toBe(
      "Drafted a full-day plan with 9 blocks.",
    );
  });

  it("names what got unblocked by a completion", () => {
    const content = JSON.stringify({ accepted: true, newly_available: [{ id: "1", title: "Write intro" }] });
    expect(confirmationFor("complete_node", content)).toBe("Done ✓ That unblocks: Write intro.");
  });

  it("says a habit was logged, not completed", () => {
    expect(confirmationFor("complete_node", JSON.stringify({ accepted: true, habit_logged: true }))).toBe("Logged for today ✓");
  });

  it("counts batch adds and quotes single adds", () => {
    expect(confirmationFor("propose_nodes_batch", JSON.stringify({ accepted: true, created: [{}, {}, {}] }))).toBe("Added 3 items ✓");
    expect(confirmationFor("propose_node", JSON.stringify({ accepted: true, title: "Call Abdo" }))).toBe('Added "Call Abdo" ✓');
  });

  it("falls back to a generic reply for unknown tools or non-JSON results", () => {
    expect(confirmationFor("something_new", "ok")).toBe("Done ✓");
  });
});

describe("actionSucceeded", () => {
  it("treats accepted:false and error payloads as failures", () => {
    expect(actionSucceeded(JSON.stringify({ accepted: false, error: "not found" }), false)).toBe(false);
    expect(actionSucceeded(JSON.stringify({ accepted: true }), true)).toBe(false);
    expect(actionSucceeded(JSON.stringify({ accepted: true, node_id: "x" }), false)).toBe(true);
  });
});

describe("looksMultiStep", () => {
  it("flags requests with a second action", () => {
    expect(looksMultiStep("add buy groceries and schedule it for 5pm")).toBe(true);
    expect(looksMultiStep("mark the gym done, then plan my evening")).toBe(true);
    expect(looksMultiStep("yeah add it as task and mark it done")).toBe(true);
  });
  it("leaves single actions alone", () => {
    expect(looksMultiStep("mark the gym as done")).toBe(false);
    expect(looksMultiStep("move the call with Abdo to Friday")).toBe(false);
  });
});
